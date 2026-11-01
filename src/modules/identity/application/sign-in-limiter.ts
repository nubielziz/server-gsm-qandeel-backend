// SignInLimiter: the rate limits of the staff sign-in steps (decision 021), with keys that reveal no email address.
import { Injectable } from '@nestjs/common';
import { TokenService } from '../../../infra/crypto';
import { RateLimitService } from '../../../infra/rate-limit';

/**
 * Applies the `sign-in` and `token` limiters to the staff sign-in.
 *
 * Why: decision 021 gives the sign-in 5 attempts per email + address per 15 minutes and clears the count on success. The
 * key holds an email, and Redis keys are visible to anyone with access to the instance, so it is a keyed hash
 * (`HMAC-SHA256(TOKEN_PEPPER, ...)`): without the pepper nobody can test a guessed email against the keys. The code and
 * setup steps are limited per account, not per session: a new login would otherwise give a thief with the password five
 * fresh guesses at the six-digit code every time.
 *
 * Side effects: counter keys `gsm:{env}:ratelimit:sign-in:{hash}` and `...:token:{address}` on the cache Redis.
 */
@Injectable()
export class SignInLimiter {
  constructor(
    private readonly limits: RateLimitService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Counts a login attempt of an email from an address.
   *
   * @param email the email as typed
   * @param ip the client address
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes
   */
  async enforceLogin(email: string, ip: string): Promise<void> {
    await this.limits.enforce('sign-in', this.key('login', email, ip));
  }

  /**
   * Clears the login counter after a correct password.
   *
   * @param email the email as typed
   * @param ip the client address
   */
  async resetLogin(email: string, ip: string): Promise<void> {
    await this.limits.reset('sign-in', this.key('login', email, ip));
  }

  /**
   * Counts a code attempt of an account.
   *
   * @param staffId the staff id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes
   */
  async enforceCode(staffId: number): Promise<void> {
    await this.limits.enforce('sign-in', this.key('code', String(staffId)));
  }

  /**
   * Clears the code counter after a correct code.
   *
   * @param staffId the staff id
   */
  async resetCode(staffId: number): Promise<void> {
    await this.limits.reset('sign-in', this.key('code', String(staffId)));
  }

  /**
   * Counts an authenticator setup of an account.
   *
   * @param staffId the staff id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth setup in 15 minutes
   */
  async enforceSetup(staffId: number): Promise<void> {
    await this.limits.enforce('sign-in', this.key('setup', String(staffId)));
  }

  /**
   * Counts a try of an emailed link from an address (guessing tokens).
   *
   * @param limitKey the address key of the request
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) beyond 30 a minute
   */
  async enforceLink(limitKey: string): Promise<void> {
    await this.limits.enforce('token', limitKey);
  }

  private key(kind: string, ...parts: string[]): string {
    const normalised = parts.map((part) => part.trim().toLowerCase()).join('\u0000');
    return this.tokens.hash(`staff-sign-in\u0000${kind}\u0000${normalised}`);
  }
}
