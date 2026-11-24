// AccountTwoFactorService: the use cases of POST /client/security/2fa/setup, /enable and /disable and of POST /store/v1/me/2fa/setup, /enable and
// /disable (map domain A, stage 2; MISMATCHES B132 to B134; decision 064). Two-step sign-in is optional for every account with a password.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import type { Client } from '../db/schema';
import {
  disableClientTwoFactor,
  enableClientTwoFactor,
  lockClientById,
  savePendingClientTotpSecret,
} from '../infra/merchant-auth.repository';
import { type AccountTwoFactorSetup, type AccountTwoFactorSetupAnswer } from '../ports/account-auth';
import type { AccountPrincipal } from '../ports/account-principal';
import { SessionService } from '../security/session.service';
import { AccountSignInLimiter } from './account-sign-in-limiter';
import { MerchantAccountReader } from './merchant-account-reader';
import { invalidCode } from './merchant-errors';
import { CLIENT_TOTP_AAD, TotpService } from './totp.service';

/**
 * Sets up, enables and disables the authenticator of an account.
 *
 * Why: B132 to B134, decision 052 and decision 064. A setup stores a pending secret (encrypted, `twofa_enabled` still false); a current
 * code confirms it and turns two-step sign-in on; disabling needs a current code too. The use case is the same for a merchant rank and a
 * retail rank, and it needs a password: an account without one has no signed-in holder to protect, so it is refused with `409 CONFLICT`
 * ("Choose a password first."), never `401`, which would sign the caller out. Two-step sign-in can be switched on only for a confirmed
 * email address (`email_verified_at` set): a setup and an enable on an unconfirmed address are refused with `409 CONFLICT`, so an address
 * that nobody confirmed never carries a second step. Switching it off and using it at sign-in do not depend on the address. Every
 * change of the two-step state ends the account's other sessions (the one making the change stays), and a wrong code is `422` on
 * `code`, never `401`.
 *
 * Side effects: locks the account row and updates `clients` (`totp_secret_enc`, `twofa_enabled`, `totp_last_step`) in one
 * transaction; revokes the other sessions; counts rate-limit attempts per account.
 *
 * @see docs/contract/MISMATCHES.md (B132, B133, B134)
 * @see POST /client/security/2fa/setup, POST /store/v1/me/2fa/setup
 */
@Injectable()
export class AccountTwoFactorService implements AccountTwoFactorSetup {
  constructor(
    private readonly db: DbService,
    private readonly totp: TotpService,
    private readonly sessions: SessionService,
    private readonly limiter: AccountSignInLimiter,
    private readonly reader: MerchantAccountReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Starts the authenticator setup: a new pending secret.
   *
   * @param principal the signed-in account
   * @returns the key to type, the `otpauth://` link and the QR code
   * @throws {AppError} `RATE_LIMITED` (429), `TWOFA_ALREADY_ENABLED` (409), `CONFLICT` (409: no password yet, or the email address is not
   *   confirmed yet; nothing is stored and no secret is made), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async setup(principal: AccountPrincipal): Promise<AccountTwoFactorSetupAnswer> {
    await this.limiter.enforceSetup(principal.accountId);
    const client = await this.reader.current(principal.accountId);
    // A session alone must not enrol a new authenticator once 2FA is on.
    if (client.twofaEnabled) throw alreadyEnabled();
    const secret = await this.db.runInTransaction(async (work) => {
      // The row is read under its lock before any secret exists, so a refusal leaves nothing behind.
      await lockedForEnrolment(work.tx, client.id);
      const fresh = this.totp.newSecret();
      if (!(await savePendingClientTotpSecret(work.tx, client.id, this.totp.seal(fresh, CLIENT_TOTP_AAD)))) {
        throw alreadyEnabled();
      }
      return fresh;
    });
    const otpauthUrl = this.totp.uriFor(client.email, secret);
    return { secret, otpauthUrl, qrSvg: await this.totp.qrSvg(otpauthUrl) };
  }

  /**
   * Turns 2FA on after the pending secret was confirmed with a code.
   *
   * @param principal the signed-in account
   * @param code the six digits from the authenticator
   * @throws {AppError} `RATE_LIMITED` (429), `TWOFA_ALREADY_ENABLED` (409), `CONFLICT` (409: no password yet, or the email address is not
   *   confirmed yet; nothing is changed), `VALIDATION_FAILED` (422 on `code`: wrong, already used, or no setup started), `UNAUTHORIZED`
   *   (401), `ACCOUNT_SUSPENDED` (403)
   */
  async enable(principal: AccountPrincipal, code: string): Promise<void> {
    await this.limiter.enforceCode(principal.accountId);
    const client = await this.reader.current(principal.accountId);
    if (client.twofaEnabled) throw alreadyEnabled();
    if (client.passwordHash === null) throw passwordFirst();
    // Refused before the code is looked at (an unconfirmed address gets the same answer whatever it sends); the check that decides
    // is the one under the row lock below.
    if (client.emailVerifiedAt === null) throw emailNotConfirmed();
    if (client.totpSecretEnc === null)
      throw invalidCode('Start the setup first, then enter the code of your authenticator.');
    const secretEnc = client.totpSecretEnc;
    const step = await this.checkCode(client, secretEnc, code);
    await this.db.runInTransaction(async (work) => {
      // Two tabs enabling at once: the second one finds 2FA on once the first has committed.
      await lockedForEnrolment(work.tx, client.id);
      if (!(await enableClientTwoFactor(work.tx, { id: client.id, step, secretEnc }))) {
        // A new setup replaced the secret the code was checked against.
        throw invalidCode('That code does not match the current setup. Scan the new key and try again.');
      }
      await this.sessions.revokeAllOf('account', client.id, { exceptSessionId: principal.session.id }, work);
    });
    await this.limiter.resetCode(client.id);
  }

  /**
   * Turns 2FA off after a current code and forgets the secret.
   *
   * @param principal the signed-in account
   * @param code the six digits from the authenticator
   * @throws {AppError} `RATE_LIMITED` (429), `TWOFA_NOT_ENABLED` (409), `VALIDATION_FAILED` (422 on `code`), `UNAUTHORIZED`
   *   (401), `ACCOUNT_SUSPENDED` (403)
   */
  async disable(principal: AccountPrincipal, code: string): Promise<void> {
    await this.limiter.enforceCode(principal.accountId);
    const client = await this.reader.current(principal.accountId);
    if (!client.twofaEnabled) throw new AppError('TWOFA_NOT_ENABLED', { detail: 'Two-factor sign-in is already off.' });
    if (client.totpSecretEnc === null)
      throw invalidCode('That code is not correct or has expired. Enter the current code.');
    const secretEnc = client.totpSecretEnc;
    const step = await this.checkCode(client, secretEnc, code);
    await this.db.runInTransaction(async (work) => {
      if (!(await disableClientTwoFactor(work.tx, { id: client.id, step, secretEnc }))) {
        throw invalidCode('That code was already used. Wait for the next code and try again.');
      }
      await this.sessions.revokeAllOf('account', client.id, { exceptSessionId: principal.session.id }, work);
    });
    await this.limiter.resetCode(client.id);
  }

  /** Verifies a code against a stored secret and returns its time step, or refuses it with `422` on `code`. */
  private async checkCode(client: Client, secretEnc: string, code: string): Promise<number> {
    const step = await this.totp.check(
      this.totp.open(secretEnc, CLIENT_TOTP_AAD),
      code,
      client.totpLastStep,
      this.clock.nowMs(),
    );
    if (step === undefined) throw invalidCode('That code is not correct or has expired. Enter the current code.');
    return step;
  }
}

function alreadyEnabled(): AppError {
  return new AppError('TWOFA_ALREADY_ENABLED', { detail: 'Two-factor sign-in is already on for this account.' });
}

function emailNotConfirmed(): AppError {
  return new AppError('CONFLICT', {
    detail: 'Confirm your email address first; two-step sign-in can be switched on after that.',
  });
}

function passwordFirst(): AppError {
  return new AppError('CONFLICT', { detail: 'Choose a password first.' });
}

/**
 * Locks the account row and refuses an enrolment unless the account holds a password, the email address is confirmed and 2FA is still
 * off.
 *
 * Why: decision 052 and decision 064. The state is read inside the transaction that writes the secret or the flag, under the row lock,
 * so a change that lands at the same time cannot slip between the check and the write. An account without a password has no signed-in
 * holder (a session that is still in use belongs to nobody who can prove it), so it enrols nothing and is told to choose a password
 * first with `409`, which does not sign it out.
 *
 * @throws {AppError} `UNAUTHORIZED` (401: the account is gone), `CONFLICT` (409: no password, or the email is not confirmed),
 *   `TWOFA_ALREADY_ENABLED` (409)
 */
async function lockedForEnrolment(tx: DbExecutor, accountId: number): Promise<void> {
  const locked = await lockClientById(tx, accountId);
  if (!locked) throw new AppError('UNAUTHORIZED');
  if (locked.passwordHash === null) throw passwordFirst();
  if (locked.twofaEnabled) throw alreadyEnabled();
  if (locked.emailVerifiedAt === null) throw emailNotConfirmed();
}
