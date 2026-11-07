// MerchantTwoFactorService: the use cases of POST /client/security/2fa/setup, /enable and /disable (map domain A, stage 2;
// MISMATCHES B132 to B134). Merchant 2FA is optional; a used TOTP step is never accepted twice.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { Client } from '../db/schema';
import {
  disableClientTwoFactor,
  enableClientTwoFactor,
  findClientById,
  savePendingClientTotpSecret,
} from '../infra/merchant-auth.repository';
import type { MerchantPrincipal } from '../security/principal';
import { SessionService } from '../security/session.service';
import { MerchantAccountReader } from './merchant-account-reader';
import { invalidCode } from './merchant-errors';
import { MerchantSignInLimiter } from './merchant-sign-in-limiter';
import { CLIENT_TOTP_AAD, TotpService } from './totp.service';

/** The answer of `setup`: the key to type, the `otpauth://` link and the QR code. */
export interface MerchantTwoFactorSetup {
  readonly secret: string;
  readonly otpauthUrl: string;
  readonly qrSvg: string;
}

/**
 * Sets up, enables and disables the authenticator of a merchant.
 *
 * Why: B132 to B134. A setup stores a pending secret (encrypted, `twofa_enabled` still false); a current code confirms it and
 * turns 2FA on; disabling needs a current code too. Every change of the 2FA state ends the merchant's other sessions (the one
 * making the change stays), and a wrong code is `422` on `code`, never `401`.
 *
 * Side effects: updates `clients` (`totp_secret_enc`, `twofa_enabled`, `totp_last_step`); revokes the other sessions; counts
 * rate-limit attempts per account.
 *
 * @see docs/contract/MISMATCHES.md (B132, B133, B134)
 */
@Injectable()
export class MerchantTwoFactorService {
  constructor(
    private readonly db: DbService,
    private readonly totp: TotpService,
    private readonly sessions: SessionService,
    private readonly limiter: MerchantSignInLimiter,
    private readonly reader: MerchantAccountReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Starts the authenticator setup: a new pending secret.
   *
   * @param principal the signed-in merchant
   * @returns the key to type, the `otpauth://` link and the QR code
   * @throws {AppError} `RATE_LIMITED` (429), `TWOFA_ALREADY_ENABLED` (409), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async setup(principal: MerchantPrincipal): Promise<MerchantTwoFactorSetup> {
    await this.limiter.enforceSetup(principal.clientId);
    const client = await this.reader.current(principal.clientId);
    // A session alone must not enrol a new authenticator once 2FA is on.
    if (client.twofaEnabled) throw alreadyEnabled();
    const secret = this.totp.newSecret();
    if (!(await savePendingClientTotpSecret(this.db.db, client.id, this.totp.seal(secret, CLIENT_TOTP_AAD)))) {
      throw alreadyEnabled();
    }
    const otpauthUrl = this.totp.uriFor(client.email, secret);
    return { secret, otpauthUrl, qrSvg: await this.totp.qrSvg(otpauthUrl) };
  }

  /**
   * Turns 2FA on after the pending secret was confirmed with a code.
   *
   * @param principal the signed-in merchant
   * @param code the six digits from the authenticator
   * @throws {AppError} `RATE_LIMITED` (429), `TWOFA_ALREADY_ENABLED` (409), `VALIDATION_FAILED` (422 on `code`: wrong, already
   *   used, or no setup started), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async enable(principal: MerchantPrincipal, code: string): Promise<void> {
    await this.limiter.enforceCode(principal.clientId);
    const client = await this.reader.current(principal.clientId);
    if (client.twofaEnabled) throw alreadyEnabled();
    if (client.totpSecretEnc === null)
      throw invalidCode('Start the setup first, then enter the code of your authenticator.');
    const secretEnc = client.totpSecretEnc;
    const step = await this.checkCode(client, secretEnc, code);
    await this.db.runInTransaction(async (work) => {
      if (!(await enableClientTwoFactor(work.tx, { id: client.id, step, secretEnc }))) {
        // Two tabs enabled it at once, or a new setup replaced the secret the code was checked against.
        const now = await findClientById(work.tx, client.id);
        if (now?.twofaEnabled) throw alreadyEnabled();
        throw invalidCode('That code does not match the current setup. Scan the new key and try again.');
      }
      await this.sessions.revokeAllOf('client', client.id, { exceptSessionId: principal.session.id }, work);
    });
    await this.limiter.resetCode(client.id);
  }

  /**
   * Turns 2FA off after a current code and forgets the secret.
   *
   * @param principal the signed-in merchant
   * @param code the six digits from the authenticator
   * @throws {AppError} `RATE_LIMITED` (429), `TWOFA_NOT_ENABLED` (409), `VALIDATION_FAILED` (422 on `code`), `UNAUTHORIZED`
   *   (401), `ACCOUNT_SUSPENDED` (403)
   */
  async disable(principal: MerchantPrincipal, code: string): Promise<void> {
    await this.limiter.enforceCode(principal.clientId);
    const client = await this.reader.current(principal.clientId);
    if (!client.twofaEnabled) throw new AppError('TWOFA_NOT_ENABLED', { detail: 'Two-factor sign-in is already off.' });
    if (client.totpSecretEnc === null)
      throw invalidCode('That code is not correct or has expired. Enter the current code.');
    const secretEnc = client.totpSecretEnc;
    const step = await this.checkCode(client, secretEnc, code);
    await this.db.runInTransaction(async (work) => {
      if (!(await disableClientTwoFactor(work.tx, { id: client.id, step, secretEnc }))) {
        throw invalidCode('That code was already used. Wait for the next code and try again.');
      }
      await this.sessions.revokeAllOf('client', client.id, { exceptSessionId: principal.session.id }, work);
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
