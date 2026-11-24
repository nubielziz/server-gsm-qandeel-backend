// AccountSignInService: the use cases of the three sign-in routes (POST /client/auth/sign-in, /client/auth/login, POST /store/v1/auth/login),
// POST /client/auth/2fa and /logout, and the entry to the password links, for an account of any rank (map domain A, stage 2; MISMATCHES B124
// to B126; decision 064). Sensitive steps read the account from the database, not from the session's cached copy (decision 018).
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { AccountDirectory } from '../accounts/account-directory';
import { canAct, sessionStateOf } from '../accounts/account-status';
import type { Client } from '../db/schema';
import { accountStageOfStep, nextAccountStep, signInStillHolds } from '../domain/account-sign-in-step';
import { temporaryPasswordExpired } from '../domain/temporary-password';
import {
  acceptClientSignInStep,
  findClientById,
  lockClientForSignIn,
  recordClientSignIn,
  replaceClientPasswordHash,
} from '../infra/merchant-auth.repository';
import type {
  AccountForcedChangeAnswer,
  AccountSignIn,
  AccountSignInAnswer,
  AccountSignInInput,
} from '../ports/account-auth';
import type { AccountPrincipal } from '../ports/account-principal';
import { AccountSessions } from '../ports/account-sessions';
import { SessionCookies } from '../security/session-cookies';
import { SessionService } from '../security/session.service';
import { AccountPasswordService } from './account-password.service';
import { AccountSignInLimiter } from './account-sign-in-limiter';
import { CodeStepLock } from './code-step-lock';
import { MerchantAccountReader } from './merchant-account-reader';
import { invalidCode } from './merchant-errors';
import { upgradedClientPasswordHash } from './merchant-password-hash';
import { type RequestMeta, requestMetaOf } from './request-meta';
import { SignInLock } from './sign-in-lock';
import { CLIENT_TOTP_AAD, TotpService } from './totp.service';

const WRONG_CREDENTIALS = 'The email or password is not correct.';

/**
 * The sign-in of an account: password, the optional authenticator code, the forced password change, and sign-out.
 *
 * Why: B124 to B126 and decisions 018, 052 and 064. One use case serves the three sign-in routes and every rank, so one argon2 verify,
 * one counter and one lock cover all of them. The order of `signIn` is part of the contract: rate limit per email and network, then the
 * account of the email (`AccountDirectory.findLoginByEmail` only: a guest row that shares the email is never found), then the email's
 * lock (the attempt is counted before the password is checked and refused while the email is locked, with an exception for networks the
 * account signed in from), then credentials (exactly one argon2 verify, against the stored hash when the lock named an account and
 * against the boot-time dummy hash otherwise; one indistinguishable `401` for an unknown email, a guest, a wrong password, a temporary
 * password older than 72 hours, an account with no password yet and an erased account, with the same work done in each case, each
 * staying counted; a correct password takes back only its own count), then `ACCOUNT_SUSPENDED` for an account that may not act (suspended
 * or blocked), then a session: pending when a new password or a code is still needed, active otherwise (the step logic is
 * `nextAccountStep`). The session opens only if the account is still as it was when the password was checked (`signInStillHolds`, which
 * asks `canAct`) and its stored hash still holds the proven password (`stillProven`), otherwise the answer is the same `401` as a wrong
 * password. The rank kind is read under the account's row lock and names the readable CSRF cookie that `AccountSessions.start` sets.
 *
 * Side effects: reads and writes `clients` (the last sign-in time and address when a session becomes full, an upgraded password hash, the
 * count of wrong authenticator codes) and `sessions` (through `AccountSessions` and `SessionService`); counts rate-limit attempts; sets
 * and clears the session cookies on the reply; a failed attempt is logged without the email. Sign-ins write no audit rows (the audit log
 * records staff writes), except one: the wrong code that closes the code step (`CodeStepLock`: twenty wrong codes within 24 hours close it
 * until those 24 hours end, a new password is set by a reset link or by staff, or staff reset two-factor sign-in).
 *
 * @see docs/contract/MISMATCHES.md (B124, B125, B126)
 * @see POST /client/auth/sign-in, POST /client/auth/login, POST /store/v1/auth/login, POST /client/auth/2fa, POST /client/auth/logout
 */
@Injectable()
export class AccountSignInService implements AccountSignIn, OnModuleInit {
  private readonly logger = new Logger(AccountSignInService.name);
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly directory: AccountDirectory,
    private readonly ranks: RankGroupReads,
    private readonly accountSessions: AccountSessions,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookies,
    private readonly limiter: AccountSignInLimiter,
    private readonly lock: SignInLock,
    private readonly totp: TotpService,
    private readonly reader: MerchantAccountReader,
    private readonly codeLock: CodeStepLock,
    private readonly passwords: AccountPasswordService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Makes the dummy hash at boot, so the first unknown-email sign-in takes as long as every other one. */
  onModuleInit(): void {
    this.dummyHash ??= this.hasher.hash(this.tokens.random(32));
  }

  /**
   * Checks the email and password and opens a session.
   *
   * @param input the credentials as typed
   * @param request the request: its address and agent are read, and a stale session cookie on it is ended so it cannot be fixated
   * @param reply the reply the session cookies go on
   * @returns the next step (`password`, `totp` or `done`) and the rank of the account
   * @throws {AppError} `RATE_LIMITED` (429: too many tries from this network, or the email is locked after ten failures and the
   *   account has not signed in from this network), `UNAUTHORIZED` (401: unknown email, a guest, wrong password, expired temporary
   *   password, no password yet or an erased account, each staying counted towards the lock; or the account changed after the password
   *   was checked), `ACCOUNT_SUSPENDED` (403: correct password, but the account is suspended or blocked)
   */
  async signIn(input: AccountSignInInput, request: FastifyRequest, reply: FastifyReply): Promise<AccountSignInAnswer> {
    const meta = requestMetaOf(request);
    await this.limiter.enforceLogin(input.email, meta);
    // The one email lookup: the login partition only, so a guest row with the same email is never what a sign-in meets.
    const found = await this.directory.findLoginByEmail(this.db.db, input.email);
    // The hash never leaves the identity module: the row is read by the id the directory gave.
    const client = found === undefined ? undefined : await findClientById(this.db.db, found.id);
    // The account the lock and the verify work on: one that can hold a password sign-in at all.
    const signable =
      client !== undefined &&
      client.hasAccount &&
      client.passwordHash !== null &&
      sessionStateOf(client.status) !== 'gone'
        ? client
        : undefined;
    await this.lock.assertMayTry(
      'shop',
      input.email,
      signable ? { subjectType: 'account', subjectId: signable.id } : undefined,
      meta,
    );
    const verified = await this.passwordMatches(signable, input.password);
    // A temporary password runs out after 72 hours and is then refused like a wrong one (decision 052).
    const expired = signable !== undefined && verified && temporaryPasswordExpired(signable, this.clock.nowMs());
    if (signable === undefined || !verified || expired) {
      this.logger.warn(
        `Sign-in refused (${
          signable === undefined
            ? client === undefined
              ? 'unknown email'
              : 'no password to check'
            : expired
              ? 'temporary password expired'
              : 'wrong password'
        }) from ${meta.ip}`,
      );
      // The attempt stays counted, whoever the email belongs to (or nobody): a lock only some emails reach would tell which have accounts.
      throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
    }
    // A correct password is no guess: only its own count goes back (a 403 below included). The failures of other attempts stay.
    await this.lock.giveBack('shop', input.email);
    this.assertMayAct(signable, meta);

    await this.limiter.resetLogin(input.email, meta);
    return this.startSession(signable, input.password, request, reply, meta);
  }

  /**
   * Checks the authenticator code and opens the full session.
   *
   * @param principal the account of the pending code step
   * @param code the six digits
   * @param request the request (its address and agent)
   * @param reply the reply the full session's cookies go on (the pending session ends)
   * @throws {AppError} `RATE_LIMITED` (429: five codes per 15 minutes, or the code step is closed after twenty wrong codes within 24
   *   hours until they end, a new password is set or staff reset 2FA), `ACCOUNT_SUSPENDED` (403), `UNAUTHORIZED` (401: the account is
   *   gone, the session is no code step, or 2FA is no longer on), `VALIDATION_FAILED` (422 on `code`: wrong, expired or already used)
   */
  async finishCodeStep(
    principal: AccountPrincipal,
    code: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const meta = requestMetaOf(request);
    await this.limiter.enforceCode(principal.accountId);
    const client = await this.reader.current(principal.accountId);
    // The session was opened for a code step; if 2FA was turned off meanwhile the account must sign in again.
    if (principal.stage !== 'pending_totp' || !client.twofaEnabled || client.totpSecretEnc === null) {
      throw new AppError('UNAUTHORIZED');
    }
    const secretEnc = client.totpSecretEnc;
    // Counted before the code is checked; a correct code takes back only its own count, so a success never resets the others.
    const account = { type: 'account', id: client.id } as const;
    const attempts = await this.codeLock.charge(account, meta);
    const step = await this.totp.check(
      this.totp.open(secretEnc, CLIENT_TOTP_AAD),
      code,
      client.totpLastStep,
      this.clock.nowMs(),
    );
    if (step === undefined) {
      await this.codeLock.failed(account, attempts, client.name, meta);
      throw invalidCode('That code is not correct or has expired. Enter the current code.');
    }
    await this.codeLock.giveBack(account);

    await this.db.runInTransaction(async (work) => {
      // False: a parallel request used this code first, the account was suspended or blocked, or the secret was replaced.
      if (!(await acceptClientSignInStep(work.tx, { id: client.id, step, secretEnc }))) {
        throw invalidCode('That code was already used. Wait for the next code and try again.');
      }
      await recordClientSignIn(work.tx, client.id, this.clock.now(), meta.ip);
      // The pending session ends and a full one starts in the same transaction (no fixation): if the pending one was ended meanwhile
      // (a rank change, a password change) this throws and the accepted step is rolled back with it.
      if (!(await this.sessions.revoke(principal.session.id, work))) throw new AppError('UNAUTHORIZED');
      const record = await this.directory.findById(work.tx, client.id);
      if (!record) throw new AppError('UNAUTHORIZED');
      await this.accountSessions.start(work, reply, {
        accountId: client.id,
        stage: 'active',
        rankKind: record.rankKind,
      });
    });
    await this.limiter.resetCode(client.id);
  }

  /**
   * Ends the caller's session and clears its cookies.
   *
   * Why: sign-out always works, at any stage and for any rank. If the account may not act any more (suspended or blocked) every session of
   * it ends, not only this one.
   *
   * @param principal the account of the session (pending code step or full)
   * @param reply the reply the cleared cookies go on
   */
  async signOut(principal: AccountPrincipal, reply: FastifyReply): Promise<void> {
    const client = await findClientById(this.db.db, principal.accountId);
    await this.db.runInTransaction(async (work) => {
      if (client !== undefined && sessionStateOf(client.status) !== 'ok') {
        await this.sessions.revokeAllOf('account', client.id, {}, work);
        return;
      }
      await this.sessions.revoke(principal.session.id, work);
    });
    this.cookies.clearAccount(reply);
  }

  /**
   * Replaces a temporary password during the sign-in and continues it.
   *
   * @param principal the account of the `pending_password` session
   * @param password the new password
   * @param request the request (its address and agent)
   * @param reply the reply the replacing session's cookies go on
   * @returns the next step (`totp` or `done`)
   * @throws {AppError} `RATE_LIMITED` (429), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403), `WEAK_PASSWORD` (422 on `password`)
   */
  changeForcedPassword(
    principal: AccountPrincipal,
    password: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AccountForcedChangeAnswer> {
    return this.passwords.changeForced(principal, password, request, reply);
  }

  /**
   * Sends a password link to an account that may use one.
   *
   * @param email the email as typed
   * @param meta the caller's address and network
   * @throws {AppError} `RATE_LIMITED` (429)
   */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    await this.passwords.forgot(email, meta);
  }

  /**
   * Sets a new password from an invitation or a reset link. It never signs in.
   *
   * @param input the token of the link and the new password
   * @param meta the caller's address and network
   * @throws {AppError} `RATE_LIMITED` (429), `TOKEN_INVALID` (410), `WEAK_PASSWORD` (422 on `password`)
   */
  async resetPassword(input: { readonly token: string; readonly password: string }, meta: RequestMeta): Promise<void> {
    await this.passwords.reset(input, meta);
  }

  /**
   * Opens the session of an account whose password is already proven.
   *
   * Why: the ending of every password sign-in: ending the stale session, the step (`nextAccountStep`), the session of that step's stage
   * with the cookies of the account's rank kind, the hash upgrade of decision 007, and the last-sign-in record when the session is
   * already full. The session is opened in a transaction that reads the account again under its row lock and requires the account as it
   * was when the password was checked (`signInStillHolds`) and a stored hash that still holds the proven password: the hash it was proven
   * against, or a hash the same password verifies against again under the lock (decision 007's upgrade, written by a parallel sign-in of
   * the same account; `stillProven`). A reset, a password change, a verification that ended the password chosen before, a switch-on of
   * two-step sign-in or a suspension that committed in between ends the sign-in like a wrong password, and one that commits after it ends
   * the new session with the others. Lock order: the account row, then the new session.
   *
   * Side effects: ends the session of the stale cookie; locks the `clients` row and, in the same transaction, inserts a `sessions` row and
   * sets the cookies, writes `clients.last_login_at` and `last_login_ip` when `next` is `done`, and `clients.password_hash` when an upgrade is
   * due (only over the hash that was verified).
   */
  private async startSession(
    client: Client,
    password: string,
    request: FastifyRequest,
    reply: FastifyReply,
    meta: RequestMeta,
  ): Promise<AccountSignInAnswer> {
    // Argon2 takes tens of milliseconds: a due upgrade is hashed before the transaction, not while the account row is held.
    const upgraded = await upgradedClientPasswordHash(this.hasher, this.logger, client, password);
    await this.endStaleSession(this.cookies.readToken(request, 'account'));
    const next = nextAccountStep({ mustChangePassword: client.mustChangePassword, twofaEnabled: client.twofaEnabled });
    const opened = await this.db.runInTransaction(async (work) => {
      const current = await lockClientForSignIn(work.tx, client.id);
      // The state first; argon2 under the lock runs only for a hash that differs while no password was chosen since (an upgrade).
      if (!current || !signInStillHolds(client, current) || !(await this.stillProven(current, client, password))) {
        this.logger.warn(`Sign-in refused (the account changed during the sign-in) from ${meta.ip}`);
        throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
      }
      // Read under the row lock held above, so a rank change waits for this transaction and the cookie names the rank in force.
      const record = await this.directory.findById(work.tx, client.id);
      if (!record) throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
      await this.accountSessions.start(work, reply, {
        accountId: client.id,
        stage: accountStageOfStep(next),
        rankKind: record.rankKind,
      });
      if (upgraded !== undefined && client.passwordHash !== null) {
        await replaceClientPasswordHash(work.tx, client.id, upgraded, client.passwordHash);
      }
      if (next === 'done') await recordClientSignIn(work.tx, client.id, this.clock.now(), meta.ip);
      return { groupId: record.groupId, kind: record.rankKind };
    });
    const name = await this.ranks.nameOf(this.db.db, opened.groupId);
    return { next, rank: { id: opened.groupId, name: name ?? '', kind: opened.kind } };
  }

  /**
   * Whether the row read under the lock still holds the proven password: the same hash, or another hash of the same password.
   *
   * Why: a parallel sign-in may have upgraded the hash (decision 007) between this sign-in's check and its session; only the password
   * itself shows that the new hash is the same password, so it is verified again here, under the lock (rare: the hash rarely differs).
   * An ended password (no hash) and a temporary one past its 72 hours never count.
   */
  private async stillProven(locked: Client, proven: Client, password: string): Promise<boolean> {
    if (locked.passwordHash === proven.passwordHash) return true;
    if (locked.passwordHash === null) return false;
    return (
      (await this.hasher.verify(locked.passwordHash, password)) && !temporaryPasswordExpired(locked, this.clock.nowMs())
    );
  }

  /** Refuses an account that may not act (suspended or blocked) after its password was proven. */
  private assertMayAct(client: Client, meta: RequestMeta): void {
    if (canAct(client.status)) return;
    this.logger.warn(`Account ${client.id} signed in with a correct password but may not act (${meta.ip})`);
    throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended. Contact support.' });
  }

  /**
   * Verifies a password in the same time whether or not an account with a password exists.
   *
   * Why: an unknown email, a guest and an account with no password yet must not answer faster than a wrong password (decision 007,
   * B124): they verify against a dummy hash made at the configured cost. Exactly one verify runs per attempt.
   */
  private async passwordMatches(client: Client | undefined, password: string): Promise<boolean> {
    if (client?.passwordHash) return this.hasher.verify(client.passwordHash, password);
    this.dummyHash ??= this.hasher.hash(this.tokens.random(32));
    await this.hasher.verify(await this.dummyHash, password);
    return false;
  }

  /** Ends the session a sign-in request already carried (a new sign-in never continues an old session). */
  private async endStaleSession(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessions.lookup(token);
    if (view?.subjectType === 'account') await this.sessions.revoke(view.id);
  }
}
