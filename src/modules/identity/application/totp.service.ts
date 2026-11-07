// TotpService: the TOTP side of the staff sign-in (RFC 6238, decision 019): new secrets, the stored (encrypted) form, the
// authenticator link with its QR code, and code checks with the replay rule. The only file that touches otplib and qrcode.
import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { EncryptionService } from '../../../infra/crypto';

/** The additional authenticated data of the encrypted column: a copy in another column does not decrypt (decision 019). */
export const STAFF_TOTP_AAD = 'staff_users.totp_secret_enc';
/** The additional authenticated data of `clients.totp_secret_enc` (merchant 2FA, feature 2b): a staff secret does not decrypt there. */
export const CLIENT_TOTP_AAD = 'clients.totp_secret_enc';
/** The name an authenticator app shows for the account. */
export const TOTP_ISSUER = 'GSM Supply';
/** Seconds a code is valid: a time step (RFC 6238 default). */
export const TOTP_PERIOD_SECONDS = 30;

/**
 * Creates, stores and checks TOTP secrets.
 *
 * Why: staff 2FA is mandatory (map admin-team step 5, decision 018). Six digits, 30-second steps, one step of tolerance
 * either side for clock drift, and a step that was accepted once is never accepted again.
 *
 * Side effects: none of its own (the callers persist the secret and the last accepted step).
 */
@Injectable()
export class TotpService {
  constructor(private readonly encryption: EncryptionService) {}

  /**
   * Makes a new base32 secret (160 bits).
   *
   * @returns the secret as the authenticator app expects it
   */
  newSecret(): string {
    return generateSecret();
  }

  /**
   * Encrypts a secret for a `*.totp_secret_enc` column.
   *
   * @param secret the base32 secret
   * @param aad the encryption context of the column: {@link STAFF_TOTP_AAD} (default) or {@link CLIENT_TOTP_AAD}
   * @returns the encrypted text (`v1:<kid>:...`)
   */
  seal(secret: string, aad: string = STAFF_TOTP_AAD): string {
    return this.encryption.encrypt(secret, aad);
  }

  /**
   * Decrypts a stored secret.
   *
   * @param stored the text from `staff_users.totp_secret_enc` or `clients.totp_secret_enc`
   * @param aad the encryption context of the column it came from (default {@link STAFF_TOTP_AAD})
   * @returns the base32 secret
   * @throws {DecryptionError} when the text is damaged, its key is gone or it belongs to another column
   */
  open(stored: string, aad: string = STAFF_TOTP_AAD): string {
    return this.encryption.decrypt(stored, aad);
  }

  /**
   * Builds the `otpauth://` link of an account.
   *
   * @param email the account's email (the label in the app)
   * @param secret the base32 secret
   * @returns the link an authenticator app opens from a QR code
   */
  uriFor(email: string, secret: string): string {
    return generateURI({ issuer: TOTP_ISSUER, label: email, secret });
  }

  /**
   * Draws the QR code of an `otpauth://` link.
   *
   * @param uri the link
   * @returns raw SVG markup (the console wraps it in a data URL)
   */
  qrSvg(uri: string): Promise<string> {
    return QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }

  /**
   * Checks a six-digit code.
   *
   * Why: the replay rule: a code whose time step is not newer than the last accepted one is refused even when the code is
   * right. The caller stores the returned step with a guarded write, so two simultaneous requests cannot both succeed.
   *
   * @param secret the base32 secret
   * @param code the six digits the person typed
   * @param lastStep the last accepted time step of this account, or null
   * @param nowMs the current time in milliseconds (the injected clock's, decision 031)
   * @returns the time step the code belongs to, or `undefined` for a wrong, expired or already used code
   */
  async check(secret: string, code: string, lastStep: number | null, nowMs: number): Promise<number | undefined> {
    let result: Awaited<ReturnType<typeof verify>>;
    try {
      result = await verify({
        secret,
        token: code,
        epoch: nowMs / 1000,
        // One step either side of now (±30 s) for clock drift between the phone and the server.
        epochTolerance: TOTP_PERIOD_SECONDS,
        ...(lastStep === null ? {} : { afterTimeStep: lastStep }),
      });
    } catch {
      // otplib throws when the last accepted step lies ahead of now (a clock that stepped back, or instances whose
      // clocks disagree): the code cannot be accepted, which is a wrong code (422), not a server fault.
      return undefined;
    }
    // The default strategy is TOTP, whose valid result carries the time step; the type is shared with HOTP.
    return result.valid && 'timeStep' in result ? result.timeStep : undefined;
  }
}
