// MerchantSignInService: the use cases of POST /client/auth/login, /2fa and /logout (map domain A, stage 2; MISMATCHES B124 to
// B126). Sensitive steps read the merchant from the database, not from the session's cached copy (decision 018).
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import type { Client } from '../db/schema';
import { type MerchantSignInStep, merchantStageOfStep, nextMerchantStep } from '../domain/merchant-sign-in-step';
import {
  acceptClientSignInStep,
  findClientByEmail,
  findClientById,
  replaceClientPasswordHash,
} from '../infra/merchant-auth.repository';
import type { MerchantPrincipal } from '../security/principal';
import { SessionService } from '../security/session.service';
import type { IssuedSession } from '../security/session.types';
import { MerchantAccountReader } from './merchant-account-reader';
import { invalidCode } from './merchant-errors';
import { MerchantSignInLimiter } from './merchant-sign-in-limiter';
import type { RequestMeta } from './request-meta';
import { CLIENT_TOTP_AAD, TotpService } from './totp.service';

/** The answer of `login`: the next step and the session to put in the cookies. */
export interface MerchantLoginResult {
  readonly next: MerchantSignInStep;
  readonly session: IssuedSession;
}

const WRONG_CREDENTIALS = 'The email or password is not correct.';

/**
 * The merchant sign-in: password, the optional authenticator code, and sign-out.
 *
 * Why: B124 to B126 and decision 018. The order of `login` is part of the contract: rate limit, then credentials (one
 * indistinguishable `401` for an unknown email, a wrong password and a merchant with no password yet, with the same work done in
 * each case), then suspension, then a session: pending when a code is still needed, active otherwise. A merchant waiting for
 * approval signs in like any other (B153); what it may then call is decided by the routes' `pendingMerchant` field.
 *
 * Side effects: reads and writes `clients` and `sessions`; counts rate-limit attempts; a failed attempt is logged without the
 * email. Merchant sign-ins write no audit rows (the audit log records staff writes).
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
    private readonly totp: TotpService,
    private readonly reader: MerchantAccountReader,
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
   * @returns the next step (`totp` or `done`) and the session
   * @throws {AppError} `RATE_LIMITED` (429), `UNAUTHORIZED` (401: unknown email, wrong password or no password yet),
   *   `ACCOUNT_SUSPENDED` (403: correct password, suspended merchant)
   */
  async login(
    input: { readonly email: string; readonly password: string },
    meta: RequestMeta,
    staleToken?: string,
  ): Promise<MerchantLoginResult> {
    await this.limiter.enforceLogin(input.email, meta.ip);
    const client = await findClientByEmail(this.db.db, input.email);
    const correct = await this.passwordMatches(client, input.password);
    if (!client || !correct) {
      this.logger.warn(
        `Merchant sign-in refused (${client ? (client.passwordHash ? 'wrong password' : 'no password yet') : 'unknown email'}) from ${meta.ip}`,
      );
      throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
    }
    if (client.status === 'suspended') {
      this.logger.warn(`Merchant ${client.id} signed in with a correct password but is suspended (${meta.ip})`);
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended. Contact support.' });
    }

    await this.limiter.resetLogin(input.email, meta.ip);
    await this.upgradeHash(client, input.password);
    await this.endStaleSession(staleToken);
    const next = nextMerchantStep(client.twofaEnabled);
    const session = await this.sessions.create({
      subjectType: 'client',
      subjectId: client.id,
      stage: merchantStageOfStep(next),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { next, session };
  }

  /**
   * Checks the authenticator code and opens the full session.
   *
   * @param principal the pending session's merchant
   * @param code the six digits
   * @param meta the caller's address and user agent
   * @returns the full session (a new token; the pending one is revoked)
   * @throws {AppError} `RATE_LIMITED` (429), `ACCOUNT_SUSPENDED` (403), `UNAUTHORIZED` (401: the merchant is gone or 2FA is no
   *   longer on), `VALIDATION_FAILED` (422 on `code`: wrong, expired or already used)
   */
  async verifyTwoFactor(principal: MerchantPrincipal, code: string, meta: RequestMeta): Promise<IssuedSession> {
    await this.limiter.enforceCode(principal.clientId);
    const client = await this.reader.current(principal.clientId);
    // The session was opened for a code step; if 2FA was turned off meanwhile the merchant must sign in again.
    if (principal.stage !== 'pending_totp' || !client.twofaEnabled || client.totpSecretEnc === null) {
      throw new AppError('UNAUTHORIZED');
    }
    const secretEnc = client.totpSecretEnc;
    const step = await this.totp.check(
      this.totp.open(secretEnc, CLIENT_TOTP_AAD),
      code,
      client.totpLastStep,
      this.clock.nowMs(),
    );
    if (step === undefined) throw invalidCode('That code is not correct or has expired. Enter the current code.');

    const issued = await this.db.runInTransaction(async (work) => {
      // False: a parallel request used this code first, the merchant was suspended, or the secret was replaced.
      if (!(await acceptClientSignInStep(work.tx, { id: client.id, step, secretEnc }))) {
        throw invalidCode('That code was already used. Wait for the next code and try again.');
      }
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

  /** Re-hashes a correct password made at a lower cost than the configured one (decision 007); never fails the sign-in. */
  private async upgradeHash(client: Client, password: string): Promise<void> {
    if (!client.passwordHash || !this.hasher.needsRehash(client.passwordHash)) return;
    try {
      await replaceClientPasswordHash(this.db.db, client.id, await this.hasher.hash(password));
    } catch (error) {
      this.logger.warn(`Could not upgrade the password hash of merchant ${client.id}: ${String(error)}`);
    }
  }

  /** Ends the merchant session a login request already carried (a new sign-in never continues an old session). */
  private async endStaleSession(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessions.lookup(token);
    if (view?.subjectType === 'client') await this.sessions.revoke(view.id);
  }
}
