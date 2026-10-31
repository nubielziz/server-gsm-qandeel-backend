// The CSRF token of cookie-authenticated surfaces (decision 018): HMAC(CSRF_SECRET, session token hash), compared in
// constant time with the X-CSRF-Token header. Pure function plus a thin injectable that holds the secret.
import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { constantTimeEqual } from '../../../infra/crypto';

/**
 * The request header that carries the CSRF token (and, in responses, repeats it for consoles that cannot read the cookie).
 *
 * Why: ALIGNMENT § 6: the console sends `X-CSRF-Token` on every non-GET request and reads it from any response.
 */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Derives the CSRF token of a session.
 *
 * Why: decision 018 binds the token to the session without storing it: `HMAC-SHA256(CSRF_SECRET, session token hash)`. A
 * page of another site cannot compute or read it, and rotating the session (sign-in step, new token) changes it.
 *
 * @param secret the server-side secret (`CSRF_SECRET`)
 * @param sessionTokenHash the keyed hash of the session token (`sessions.token_hash`)
 * @returns 64 lower-case hex characters (safe in a cookie and a header)
 */
export function csrfTokenFor(secret: string, sessionTokenHash: string): string {
  return createHmac('sha256', secret).update(sessionTokenHash, 'utf8').digest('hex');
}

/**
 * Issues and checks CSRF tokens.
 *
 * Why: the secret stays inside this class (decision 019). A mutation that carries a session must send the token
 * (`403 CSRF_FAILED`, which never signs the caller out: ALIGNMENT § 3).
 */
@Injectable()
export class CsrfService {
  private readonly secret: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secret = config.security.csrfSecret;
  }

  /**
   * Returns the token of a session.
   *
   * @param sessionTokenHash `sessions.token_hash` of the session
   * @returns the token to put in the cookie and the response header
   */
  tokenFor(sessionTokenHash: string): string {
    return csrfTokenFor(this.secret, sessionTokenHash);
  }

  /**
   * Checks the token a request presented against the session's.
   *
   * @param sessionTokenHash `sessions.token_hash` of the session
   * @param presented the `X-CSRF-Token` header (a repeated header arrives as a list and never matches)
   * @returns true when it matches
   */
  matches(sessionTokenHash: string, presented: string | readonly string[] | undefined): boolean {
    if (typeof presented !== 'string' || presented === '') return false;
    return constantTimeEqual(presented, this.tokenFor(sessionTokenHash));
  }

  /**
   * Refuses a request whose token does not match its session.
   *
   * @param sessionTokenHash `sessions.token_hash` of the session
   * @param presented the `X-CSRF-Token` header
   * @throws {AppError} `CSRF_FAILED` (403) when the header is missing or does not match
   */
  assert(sessionTokenHash: string, presented: string | readonly string[] | undefined): void {
    if (this.matches(sessionTokenHash, presented)) return;
    throw new AppError('CSRF_FAILED', {
      detail:
        presented === undefined || presented === ''
          ? 'The X-CSRF-Token header is missing. Reload the page and try again.'
          : 'The X-CSRF-Token header does not match your session. Reload the page and try again.',
    });
  }
}
