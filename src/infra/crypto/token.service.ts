// Injectable wrapper of the token helpers: it holds the pepper from the config so callers never touch it (decision 019).
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { constantTimeEqual, hashToken, randomToken } from './tokens';

/**
 * Hashes, creates and compares credential tokens.
 *
 * Why: decision 019: sessions, `auth_tokens` and API keys are stored as `HMAC-SHA256(TOKEN_PEPPER, token)`. Rotating the
 * pepper invalidates every stored token, so it is a planned operation, and the pepper never leaves this class.
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
@Injectable()
export class TokenService {
  private readonly pepper: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pepper = config.security.tokenPepper;
  }

  /**
   * Hashes a token for storage or lookup.
   *
   * @param token the credential as the client sent it
   * @returns 64 hex characters
   */
  hash(token: string): string {
    return hashToken(this.pepper, token);
  }

  /**
   * Makes a random token.
   *
   * @param bytes random bytes, at least 16 (default 32)
   * @returns the token in base64url
   * @throws {RangeError} when `bytes` is below 16
   */
  random(bytes = 32): string {
    return randomToken(bytes);
  }

  /**
   * Compares two values in constant time.
   *
   * @param a first value
   * @param b second value
   * @returns true when equal
   */
  equals(a: string, b: string): boolean {
    return constantTimeEqual(a, b);
  }
}
