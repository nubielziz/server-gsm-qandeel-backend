// Token helpers (decision 019): keyed hashes for lookups, random tokens, constant-time comparison. Pure functions.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Fewest random bytes a token may have: 128 bits is the floor for an unguessable credential. */
export const MIN_TOKEN_BYTES = 16;

/**
 * Compares two secrets in constant time.
 *
 * Why: `===` on a secret leaks, through timing, how many leading characters were right. Both sides are hashed first, so
 * the comparison also does not reveal the length of the stored value.
 *
 * @param a first value
 * @param b second value
 * @returns true when the two are equal
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * Hashes a credential token for storage and lookup: `HMAC-SHA256(pepper, token)` as hex.
 *
 * Why: decision 019 stores session tokens, one-time tokens and API keys only as keyed hashes, looked up by a unique index
 * and compared in constant time, so a database dump alone yields no usable credential. The tokens are random with at
 * least 128 bits, so a fast keyed hash is enough (argon2 is for human-chosen passwords).
 *
 * @param pepper the server-side secret (`TOKEN_PEPPER`)
 * @param token the credential as the client sends it
 * @returns 64 lower-case hex characters
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
export function hashToken(pepper: string, token: string): string {
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

/**
 * Makes a random token.
 *
 * Why: sessions, API keys and invitation or reset links are random strings from the system's CSPRNG (decision 010, 019).
 *
 * @param bytes how many random bytes (at least 16); the string is about 4/3 longer
 * @returns the token in base64url (letters, digits, `-` and `_`)
 * @throws {RangeError} when `bytes` is below 16 or not an integer
 */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < MIN_TOKEN_BYTES) {
    throw new RangeError(`A token needs at least ${MIN_TOKEN_BYTES} random bytes, got ${bytes}`);
  }
  return randomBytes(bytes).toString('base64url');
}
