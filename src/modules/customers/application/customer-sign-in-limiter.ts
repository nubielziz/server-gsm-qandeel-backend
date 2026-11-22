// CustomerSignInLimiter: the rate limits of the storefront sign-in family (decision 021), with keys that reveal no email.
import { Injectable } from '@nestjs/common';
import { TokenService } from '../../../infra/crypto';
import { RateLimitService } from '../../../infra/rate-limit';
import type { RequestMeta } from '../../identity';

/**
 * Applies the `sign-in` limiter to the storefront customers.
 *
 * Why: decision 021 gives sign-in 5 attempts per email + network per 15 minutes (the IPv4 address or the IPv6 /64,
 * `RequestMeta.limitKey`, decision 052) and clears the count on success. Like the staff and merchant limiters, keys that hold an email are keyed hashes (`HMAC-SHA256(TOKEN_PEPPER, ...)`) so Redis shows no address,
 * the password-change step is limited per account, not per session, and the sign-in link and "forgot password" requests are
 * counted whether or not the email exists, so a 429 reveals nothing. The `customer-sign-in` prefix keeps these counters apart
 * from the staff and merchant ones.
 *
 * Tries of an emailed link are limited by the access guard's token lookup limit (decision 021), not here.
 *
 * Side effects: counter keys `gsm:{env}:ratelimit:sign-in:{hash}` on the cache Redis.
 */
@Injectable()
export class CustomerSignInLimiter {
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
   * Counts a sign-in link request of an email from a network.
   *
   * @param email the email as typed
   * @param meta the caller (its network key)
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth request in 15 minutes
   */
  async enforceMagicLink(email: string, meta: Pick<RequestMeta, 'limitKey'>): Promise<void> {
    await this.limits.enforce('sign-in', this.key('magic', email, meta.limitKey));
  }

  /**
   * Counts a "forgot password" request of an email from a network.
   *
   * @param email the email as typed
   * @param meta the caller (its network key)
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth request in 15 minutes
   */
  async enforceForgot(email: string, meta: Pick<RequestMeta, 'limitKey'>): Promise<void> {
    await this.limits.enforce('sign-in', this.key('forgot', email, meta.limitKey));
  }

  /**
   * Counts a password change of an account (each try needs the current password, so this stops guessing it).
   *
   * @param customerId the customer id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes
   */
  async enforcePasswordChange(customerId: number): Promise<void> {
    await this.limits.enforce('sign-in', this.key('password', String(customerId)));
  }

  /**
   * Clears the password-change counter after a correct current password.
   *
   * @param customerId the customer id
   */
  async resetPasswordChange(customerId: number): Promise<void> {
    await this.limits.reset('sign-in', this.key('password', String(customerId)));
  }

  private key(kind: string, ...parts: string[]): string {
    const normalised = parts.map((part) => part.trim().toLowerCase()).join('\u0000');
    return this.tokens.hash(`customer-sign-in\u0000${kind}\u0000${normalised}`);
  }
}
