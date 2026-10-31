// AES-256-GCM encryption of columns at rest (decision 019): a keyring with key ids, AAD = `<table>.<column>`, text format
// `v1:<kid>:<iv>:<tag>:<ciphertext>` (base64url parts). Used for TOTP secrets and supplier/gateway credentials (`*_enc`).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';

const FORMAT = 'v1';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is designed for
const TAG_BYTES = 16;
/** `<table>.<column>` in snake case, as in the database schema. */
const AAD_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Why a value could not be decrypted. Never contains the value, the key or the plaintext. */
export type DecryptionFailure = 'malformed' | 'unknown_key' | 'authentication_failed';

/**
 * Raised when a stored value cannot be decrypted.
 *
 * Why: a wrong key, a changed column or a modified ciphertext must be a loud, typed failure, never garbage plaintext.
 */
export class DecryptionError extends Error {
  constructor(readonly reason: DecryptionFailure) {
    super(`Cannot decrypt the value: ${reason}.`);
    this.name = 'DecryptionError';
  }
}

function decodePart(part: string | undefined, expectedBytes?: number): Buffer {
  if (part === undefined || !BASE64URL.test(part)) throw new DecryptionError('malformed');
  const bytes = Buffer.from(part, 'base64url');
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) throw new DecryptionError('malformed');
  return bytes;
}

/**
 * Encrypts and decrypts column values with the configured keyring.
 *
 * Why: decision 019 keeps supplier and gateway credentials, TOTP secrets and checkout IMEIs unreadable in a database
 * dump. Every value carries the id of the key that sealed it, so keys can be rotated: new values use the active key,
 * old keys stay in `ENCRYPTION_KEYS` for decryption until a maintenance job has re-encrypted the rows
 * ({@link EncryptionService.needsRotation}). The AAD ties a ciphertext to its column, so a value copied into another
 * column fails to decrypt. Keys never leave this class and are never logged.
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
@Injectable()
export class EncryptionService {
  /** The key id used for new values (`ENCRYPTION_ACTIVE_KID`). */
  readonly activeKid: string;
  private readonly keys: Readonly<Record<string, Buffer>>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.keys = config.security.encryptionKeys;
    this.activeKid = config.security.encryptionActiveKid;
  }

  /**
   * Encrypts a value with the active key.
   *
   * Why: see the class comment. A fresh random 96-bit IV is used for every call, so encrypting the same text twice gives
   * different ciphertexts.
   *
   * @param plaintext the secret text (for example a JSON document of credentials)
   * @param aad the column the value is stored in, as `<table>.<column>` (for example `suppliers.credentials_enc`)
   * @returns `v1:<kid>:<iv>:<tag>:<ciphertext>`
   * @throws {RangeError} when `aad` is not `<table>.<column>`
   */
  encrypt(plaintext: string, aad: string): string {
    this.assertAad(aad);
    const key = this.keys[this.activeKid];
    if (!key) throw new Error(`The active encryption key "${this.activeKid}" is not in the keyring`);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [FORMAT, this.activeKid, iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (Buffer.isBuffer(part) ? part.toString('base64url') : part))
      .join(':');
  }

  /**
   * Decrypts a stored value with the key it names.
   *
   * Why: values sealed by an older key still decrypt while that key is in the keyring.
   *
   * @param text a value produced by {@link EncryptionService.encrypt}
   * @param aad the column the value is read from; must equal the one used to encrypt
   * @returns the plaintext
   * @throws {DecryptionError} `malformed` (not our format), `unknown_key` (the key id is not in the keyring) or
   *   `authentication_failed` (modified ciphertext, wrong key or wrong column)
   * @throws {RangeError} when `aad` is not `<table>.<column>`
   */
  decrypt(text: string, aad: string): string {
    this.assertAad(aad);
    const parts = text.split(':');
    if (parts.length !== 5 || parts[0] !== FORMAT) throw new DecryptionError('malformed');
    const [, kid, ivPart, tagPart, ciphertextPart] = parts;
    const key = kid === undefined ? undefined : Object.hasOwn(this.keys, kid) ? this.keys[kid] : undefined;
    if (!key) throw new DecryptionError(kid ? 'unknown_key' : 'malformed');
    const iv = decodePart(ivPart, IV_BYTES);
    const tag = decodePart(tagPart, TAG_BYTES);
    const ciphertext = decodePart(ciphertextPart);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new DecryptionError('authentication_failed');
    }
  }

  /**
   * Reads the key id from a stored value without decrypting it.
   *
   * @param text a stored value
   * @returns the key id, or `undefined` when the text is not in our format
   */
  keyIdOf(text: string): string | undefined {
    const parts = text.split(':');
    return parts.length === 5 && parts[0] === FORMAT ? parts[1] : undefined;
  }

  /**
   * Tells whether a stored value was sealed by a key other than the active one.
   *
   * Why: the maintenance job of decision 019 re-encrypts such rows so an old key can be retired.
   *
   * @param text a stored value
   * @returns true when the value should be re-encrypted
   */
  needsRotation(text: string): boolean {
    return this.keyIdOf(text) !== this.activeKid;
  }

  /**
   * Decrypts a value and encrypts it again with the active key.
   *
   * @param text a stored value
   * @param aad the column it is stored in
   * @returns the new stored value
   * @throws {DecryptionError} when the old value cannot be decrypted
   */
  rotate(text: string, aad: string): string {
    return this.encrypt(this.decrypt(text, aad), aad);
  }

  private assertAad(aad: string): void {
    if (!AAD_PATTERN.test(aad)) throw new RangeError(`The AAD must be "<table>.<column>" in snake case, got "${aad}"`);
  }
}
