// SignInLock: the policy of the temporary lock on an email after repeated failed sign-ins, with the exception for networks the account
// already signed in from (decision 052). The console, the merchant portal and the storefront all use it.
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { parseIpAddress, signInNetworkKey } from '../../../common/ip-address';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import {
  FAMILIAR_SIGN_INS_READ,
  type SignInScope,
  exceedsFailureBudget,
  isFamiliarNetwork,
} from '../domain/sign-in-lock';
import { NO_ACCOUNT_ID } from '../domain/public-links';
import type { SubjectType } from '../db/schema';
import { SignInFailures } from '../infra/sign-in-failures';
import { fullSignInAddresses } from '../security/session.repository';
import type { RequestMeta } from './request-meta';

/** The account an email belongs to, when it has one that may sign in with a password. */
export interface SignInAccount {
  readonly subjectType: SubjectType;
  readonly subjectId: number;
}

/**
 * Counts every password sign-in attempt of an email before its password is checked, and decides whether it may try.
 *
 * Why: decision 052. Attempts are counted per email across addresses, so guessing from many
 * addresses still ends in a lock, and they are counted before the slow password check, atomically, so a burst of parallel attempts
 * cannot all be checked: ten counted attempts are checked, the eleventh is refused and starts a lock of 15 minutes. A correct password
 * takes back only its own attempt (`giveBack`), never the failures others caused: two shop accounts of one email may belong to two
 * people (a password chosen without the emailed link proves no mailbox), so one's success must not reopen the other's guessing. A lock that refused every caller
 * would let a stranger keep the owner out, so while the email is locked an attempt is refused (`429` with `Retry-After`) unless the
 * request comes from a network (an IPv4 /24 or IPv6 /64) that one of the newest 50 full sessions of the account being signed into came
 * from; the attempts such a network is still allowed share one budget per email and network (limiter `sign-in-familiar`, 5 in 15
 * minutes: the sixth is refused like any other attempt on a locked email, before its password is checked). The sessions are read whenever
 * the email is locked, with the account's id or with an id no account has, so a locked email answers alike for every email. Count and lock end (`clear`) only with a new password
 * from an emailed link (it proves the mailbox), one staff set, or the own change of an account whose holder proved the mailbox or was
 * made by staff (customers, console members); a merchant's own change does not end them (a password chosen without the emailed link proves no mailbox).
 *
 * Side effects: the Redis hash of `SignInFailures`; one `sessions` read while an email is locked; while it is locked, one point of the
 * `sign-in-familiar` counter (`gsm:{env}:ratelimit:sign-in-familiar:{hash}`) for an attempt that comes from a network the account used.
 *
 * @see docs/decisions/052-sign-in-and-mail-limits.md
 */
@Injectable()
export class SignInLock {
  private readonly logger = new Logger(SignInLock.name);

  constructor(
    private readonly failures: SignInFailures,
    private readonly db: DbService,
    private readonly limits: RateLimitService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Counts the attempt, then refuses it while the email is locked (or when this attempt starts the lock), unless the account has
   * signed in from the caller's network and that network has attempts left (5 in 15 minutes per email and network while the lock
   * runs). An attempt that may try stays counted: the caller gives it back when its password is correct.
   *
   * @param scope the console or the shop
   * @param email the email as typed
   * @param account the account the attempt would sign into, `undefined` when there is none (unknown email, guest, no password)
   * @param meta the caller's exact address (the network is taken from it)
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`: the time left of the lock)
   */
  async assertMayTry(
    scope: SignInScope,
    email: string,
    account: SignInAccount | undefined,
    meta: Pick<RequestMeta, 'ip'>,
  ): Promise<void> {
    const charged = await this.failures.charge(scope, email);
    const lockRuns = charged.lockedForSeconds > 0;
    if (!lockRuns && !exceedsFailureBudget(charged.attempts)) return;
    // The first attempt beyond the budget starts the lock (and the count again); attempts crossing it at the same moment each start
    // the same lock.
    const lockedFor = lockRuns ? charged.lockedForSeconds : await this.failures.startLock(scope, email);
    // The same read for every email: an id no account has finds no rows, so a locked email costs the same whoever owns it.
    const addresses = await fullSignInAddresses(
      this.db.db,
      account?.subjectType ?? (scope === 'staff' ? 'staff' : 'client'),
      account?.subjectId ?? NO_ACCOUNT_ID,
      FAMILIAR_SIGN_INS_READ,
    );
    const familiar = account !== undefined && isFamiliarNetwork(meta.ip, addresses);
    if (familiar && (await this.takeFamiliarPoint(scope, email, meta.ip))) return;
    // A refused attempt checked no password, so it is no guess: its count goes back, and once the lock ends the email has its whole
    // budget again. (The attempt that started the lock went with the count it reset.)
    if (lockRuns) await this.failures.giveBack(scope, email);
    this.logger.warn(
      familiar
        ? `Sign-in refused (${scope}): the email is locked and the attempts left to this network are used up (${meta.ip})`
        : `Sign-in refused (${scope}): the email is locked after repeated failures (${meta.ip})`,
    );
    throw new AppError('RATE_LIMITED', {
      detail: 'Too many failed attempts. Try again later.',
      retryAfterSeconds: lockedFor,
    });
  }

  /**
   * Takes one point of the budget that a familiar network shares while its email is locked.
   *
   * Why: decision 052. The networks an account used keep trying while a lock runs, so their attempts are bounded together: one budget
   * per scope, email and network (not per address, an owner's address moves inside its /24 or /64), 5 in 15 minutes. The key is a keyed
   * hash, so the cache Redis holds no email address. Called only for an attempt that is let through because of its network.
   *
   * @param scope the console or the shop
   * @param email the email as typed
   * @param ip the caller's exact address (its network is taken from it)
   * @returns false when the network has used its attempts
   */
  private async takeFamiliarPoint(scope: SignInScope, email: string, ip: string): Promise<boolean> {
    const network = signInNetworkKey(parseIpAddress(ip));
    if (network === undefined) return false;
    const key = this.tokens.hash(`sign-in-familiar\u0000${scope}\u0000${email.trim().toLowerCase()}\u0000${network}`);
    return (await this.limits.consume('sign-in-familiar', key)).allowed;
  }

  /**
   * Takes back the attempt counted by {@link assertMayTry}: its password was correct (whatever comes next: a session, a `403`).
   *
   * Why: a correct password is no guess; only this attempt's count goes, so a success never cancels the failures other attempts
   * caused, and a running lock stays.
   *
   * @param scope the console or the shop
   * @param email the email as typed
   * @returns when the attempt is taken back
   */
  giveBack(scope: SignInScope, email: string): Promise<void> {
    return this.failures.giveBack(scope, email);
  }

  /**
   * Deletes the count and the lock of an email: the mailbox owner chose a new password, or staff set one.
   *
   * @param scope the console or the shop
   * @param email the email as typed
   * @returns when the count and the lock are gone
   */
  clear(scope: SignInScope, email: string): Promise<void> {
    return this.failures.clear(scope, email);
  }
}
