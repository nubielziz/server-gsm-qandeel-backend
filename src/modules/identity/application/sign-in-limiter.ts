// SignInLimiter: the rate limits of the staff sign-in steps (decision 021), with keys that reveal no email address.
import { Injectable } from '@nestjs/common';
import { TokenService } from '../../../infra/crypto';
import { RateLimitService } from '../../../infra/rate-limit';
import type { RequestMeta } from './request-meta';

/**
 * Applies the `sign-in`, `sign-in-code` and `token` limiters to the staff sign-in.
 *
 * Why: decision 021 gives the sign-in 5 attempts per email + network per 15 minutes and clears the count on success; the network is
 * the IPv4 address or the IPv6 /64 (`RequestMeta.limitKey`, decision 052), the same key as every other per-client limit, so rotating
 * addresses inside one /64 does not give fresh attempts. The key holds an email, and Redis keys are visible to anyone with access to
 * the instance, so it is a keyed hash (`HMAC-SHA256(TOKEN_PEPPER, ...)`): without the pepper nobody can test a guessed email against
 * the keys. The code and setup steps are limited per account, not per session: a new login would otherwise give a thief with the
 * password five fresh guesses at the six-digit code every time. The code step uses `sign-in-code`, which is never counted in process
 * memory (while the cache Redis cannot be reached the code is refused).
 *
 * Side effects: counter keys `gsm:{env}:ratelimit:sign-in:{hash}`, `...:sign-in-code:{hash}` and `...:token:{address}` on the cache Redis.
 */
@Injectable()
export class SignInLimiter {
  constructor(
    private readonly limits: RateLimitService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Counts a login attempt of an email from a network.
   *
   * @param email the email as typed
   * @param meta the caller (its network key: the IPv4 address or the IPv6 /64)
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes
   */
  async enforceLogin(email: string, meta: Pick<RequestMeta, 'limitKey'>): Promise<void> {
    await this.limits.enforce('sign-in', this.key('login', email, meta.limitKey));
  }

  /**
   * Clears the login counter after a correct password.
   *
   * @param email the email as typed
   * @param meta the caller (its network key)
   */
  async resetLogin(email: string, meta: Pick<RequestMeta, 'limitKey'>): Promise<void> {
    await this.limits.reset('sign-in', this.key('login', email, meta.limitKey));
  }

  /**
   * Counts a code attempt of an account.
   *
   * @param staffId the staff id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes, and at once (60 seconds)
   *   while the cache Redis cannot be reached
   */
  async enforceCode(staffId: number): Promise<void> {
    await this.limits.enforce('sign-in-code', this.key('code', String(staffId)));
  }

  /**
   * Clears the code counter after a correct code.
   *
   * @param staffId the staff id
   */
  async resetCode(staffId: number): Promise<void> {
    await this.limits.reset('sign-in-code', this.key('code', String(staffId)));
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
