// MerchantSignInService: the use cases of POST /client/auth/login, /2fa and /logout (map domain A, stage 2; MISMATCHES B124 to
// B126). Sensitive steps read the merchant from the database, not from the session's cached copy (decision 018).
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import type { Client } from '../db/schema';
import { type MerchantSignInStep, merchantStageOfStep, nextMerchantStep } from '../domain/merchant-sign-in-step';
import { temporaryPasswordExpired } from '../domain/temporary-password';
import {
  acceptClientSignInStep,
  findClientByEmail,
  findClientById,
  recordClientSignIn,
} from '../infra/merchant-auth.repository';
import type { MerchantPrincipal } from '../security/principal';
import { SessionService } from '../security/session.service';
import type { IssuedSession } from '../security/session.types';
import { CodeStepLock } from './code-step-lock';
import { MerchantAccountReader } from './merchant-account-reader';
import { invalidCode } from './merchant-errors';
import { upgradeClientPasswordHash } from './merchant-password-hash';
import { MerchantSignInLimiter } from './merchant-sign-in-limiter';
import type { RequestMeta } from './request-meta';
import { SignInLock } from './sign-in-lock';
import { CLIENT_TOTP_AAD, TotpService } from './totp.service';

/** The answer of `login` and `startSession`: the next step and the session to put in the cookies. */
export interface MerchantLoginResult {
  readonly next: MerchantSignInStep;
  readonly session: IssuedSession;
}

const WRONG_CREDENTIALS = 'The email or password is not correct.';

/**
 * The merchant sign-in: password, the optional authenticator code, and sign-out.
 *
 * Why: B124 to B126 and decisions 018 and 052. The order of `login` is part of the contract: rate limit per email and network, then the
 * email's lock (shared with the storefront sign-in; the attempt is counted before the password is checked and refused while the email is
 * locked, with an exception for networks the account signed in from), then credentials (one indistinguishable `401` for an unknown
 * email, a wrong password, a temporary password older than 72 hours and a merchant with no password yet, with the same work done in each
 * case, each staying counted; a correct password takes back only its own count), then suspension, then a session: pending when a
 * new password or a code is still needed, active otherwise (the step logic
 * is `nextMerchantStep`; `startSession` holds everything after a proven password, for the smart sign-in of feature 24A to reuse). A
 * merchant waiting for approval signs in like any other (B153); what it may then call is decided by the routes' `pendingMerchant` field.
 *
 * Side effects: reads and writes `clients` (the last sign-in time and address when a session becomes full, the count of wrong
 * authenticator codes) and `sessions`; counts rate-limit attempts; a failed attempt is logged without the email. Merchant sign-ins write
 * no audit rows (the audit log records staff writes), except one: the wrong code that closes the code step (`CodeStepLock`: twenty
 * wrong codes within 24 hours close it until those 24 hours end, a new password is set by a reset link or by staff, or staff reset
 * two-factor sign-in).
 *
 * @see docs/contract/MISMATCHES.md (B124, B125, B126)
 */
@Injectable()
export class MerchantSignInService implements OnModuleInit {
  private readonly logger = new Logger(MerchantSignInService.name);
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly limiter: MerchantSignInLimiter,
    private readonly lock: SignInLock,
    private readonly totp: TotpService,
    private readonly reader: MerchantAccountReader,
    private readonly codeLock: CodeStepLock,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Makes the dummy hash at boot, so the first unknown-email login takes as long as every other one. */
  onModuleInit(): void {
    this.dummyHash ??= this.hasher.hash(this.tokens.random(32));
  }

  /**
   * Checks the email and password and opens a session.
   *
   * @param input the credentials as typed
   * @param meta the caller's address and user agent
   * @param staleToken the session cookie the request already carried, ended here so it cannot be fixated
   * @returns the next step (`password`, `totp` or `done`) and the session
   * @throws {AppError} `RATE_LIMITED` (429: too many tries from this network, or the email is locked after ten failures and the
   *   merchant has not signed in from this network), `UNAUTHORIZED` (401: unknown email, wrong password, expired temporary password
   *   or no password yet; each stays counted towards the lock), `ACCOUNT_SUSPENDED` (403: correct password, suspended merchant)
   */
  async login(
    input: { readonly email: string; readonly password: string },
    meta: RequestMeta,
    staleToken?: string,
  ): Promise<MerchantLoginResult> {
    await this.limiter.enforceLogin(input.email, meta);
    const client = await findClientByEmail(this.db.db, input.email);
    await this.lock.assertMayTry(
      'shop',
      input.email,
      client ? { subjectType: 'client', subjectId: client.id } : undefined,
      meta,
    );
    const verified = await this.passwordMatches(client, input.password);
    // A temporary password runs out after 72 hours and is then refused like a wrong one (decision 052).
    const expired = client !== undefined && verified && temporaryPasswordExpired(client, this.clock.nowMs());
    if (!client || !verified || expired) {
      this.logger.warn(
        `Merchant sign-in refused (${
          client
            ? expired
              ? 'temporary password expired'
              : client.passwordHash
                ? 'wrong password'
                : 'no password yet'
            : 'unknown email'
        }) from ${meta.ip}`,
      );
      // The attempt stays counted, whoever the email belongs to (or nobody): a lock only some emails reach would tell which have accounts.
      throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
    }
    // A correct password is no guess: only its own count goes back (a 403 below included). The failures of other attempts stay, so
    // a merchant registered on a customer's email cannot cancel the guesses at that customer's password by signing in (decision 052).
    await this.lock.giveBack('shop', input.email);
    this.assertNotSuspended(client, meta);

    await this.limiter.resetLogin(input.email, meta);
    await upgradeClientPasswordHash(this.db.db, this.hasher, this.logger, client, input.password);
    return this.startSession(client, meta, staleToken);
  }

  /**
   * Opens the session of a merchant whose credentials are already proven.
   *
   * Why: every password-verified sign-in ends here, the portal's login and the smart sign-in of feature 24A (`MerchantPasswordSignIn`,
   * which verifies the password itself, once, and calls this): the suspension refusal, ending the stale session, the step (`nextMerchantStep`), the session of
   * that step's stage, and the last-sign-in record when the session is already full.
   *
   * Side effects: ends the session of `staleToken`; inserts a `sessions` row; writes `clients.last_login_at` and `last_login_ip` when `next` is `done`.
   *
   * @param client the merchant whose password was just proven
   * @param meta the caller's address and user agent
   * @param staleToken the session cookie the request already carried, ended here so it cannot be fixated
   * @returns the next step and the session
   * @throws {AppError} `ACCOUNT_SUSPENDED` (403)
   */
  async startSession(client: Client, meta: RequestMeta, staleToken?: string): Promise<MerchantLoginResult> {
    this.assertNotSuspended(client, meta);
    await this.endStaleSession(staleToken);
    const next = nextMerchantStep({
      mustChangePassword: client.mustChangePassword,
      twofaEnabled: client.twofaEnabled,
    });
    const session = await this.sessions.create({
      subjectType: 'client',
      subjectId: client.id,
      stage: merchantStageOfStep(next),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    if (next === 'done') await recordClientSignIn(this.db.db, client.id, this.clock.now(), meta.ip);
    return { next, session };
  }

  private assertNotSuspended(client: Client, meta: RequestMeta): void {
    if (client.status !== 'suspended') return;
    this.logger.warn(`Merchant ${client.id} signed in with a correct password but is suspended (${meta.ip})`);
    throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended. Contact support.' });
  }

  /**
   * Checks the authenticator code and opens the full session.
   *
   * @param principal the pending session's merchant
   * @param code the six digits
   * @param meta the caller's address and user agent
   * @returns the full session (a new token; the pending one is revoked)
   * @throws {AppError} `RATE_LIMITED` (429: five codes per 15 minutes, or the code step is closed after twenty wrong codes within 24
   *   hours until they end, a new password is set or staff reset 2FA), `ACCOUNT_SUSPENDED` (403), `UNAUTHORIZED` (401: the merchant is gone or 2FA is no longer
   *   on), `VALIDATION_FAILED` (422 on `code`: wrong, expired or already used)
   */
  async verifyTwoFactor(principal: MerchantPrincipal, code: string, meta: RequestMeta): Promise<IssuedSession> {
    await this.limiter.enforceCode(principal.clientId);
    const client = await this.reader.current(principal.clientId);
    // The session was opened for a code step; if 2FA was turned off meanwhile the merchant must sign in again.
    if (principal.stage !== 'pending_totp' || !client.twofaEnabled || client.totpSecretEnc === null) {
      throw new AppError('UNAUTHORIZED');
    }
    const secretEnc = client.totpSecretEnc;
    // Counted before the code is checked; a correct code takes back only its own count, so a success never resets the others.
    const account = { type: 'client', id: client.id } as const;
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

    const issued = await this.db.runInTransaction(async (work) => {
      // False: a parallel request used this code first, the merchant was suspended, or the secret was replaced.
      if (!(await acceptClientSignInStep(work.tx, { id: client.id, step, secretEnc }))) {
        throw invalidCode('That code was already used. Wait for the next code and try again.');
      }
      await recordClientSignIn(work.tx, client.id, this.clock.now(), meta.ip);
      return this.sessions.rotate(principal.session, { stage: 'active', ip: meta.ip, userAgent: meta.userAgent }, work);
    });
    await this.limiter.resetCode(client.id);
    return issued;
  }

  /**
   * Ends the caller's session.
   *
   * Why: sign-out always works. If the merchant was suspended meanwhile, every session of it ends, not only this one.
   *
   * @param principal the session's merchant (pending code step or full)
   */
  async logout(principal: MerchantPrincipal): Promise<void> {
    const client = await findClientById(this.db.db, principal.clientId);
    await this.db.runInTransaction(async (work) => {
      if (client?.status === 'suspended') {
        await this.sessions.revokeAllOf('client', client.id, {}, work);
        return;
      }
      await this.sessions.revoke(principal.session.id, work);
    });
  }

  /**
   * Verifies a password in the same time whether or not the merchant exists.
   *
   * Why: an unknown email and a merchant with no password yet must not answer faster than a wrong password (decision 007,
   * B124): they verify against a dummy hash made at the configured cost.
   */
  private async passwordMatches(client: Client | undefined, password: string): Promise<boolean> {
    if (client?.passwordHash) return this.hasher.verify(client.passwordHash, password);
    this.dummyHash ??= this.hasher.hash(this.tokens.random(32));
    await this.hasher.verify(await this.dummyHash, password);
    return false;
  }

  /** Ends the merchant session a login request already carried (a new sign-in never continues an old session). */
  private async endStaleSession(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessions.lookup(token);
    if (view?.subjectType === 'client') await this.sessions.revoke(view.id);
  }
}
