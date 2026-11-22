// MerchantSignInLimiter: the rate limits of the merchant portal's sign-in family (decision 021), with keys that reveal no email.
import { Injectable } from '@nestjs/common';
import { TokenService } from '../../../infra/crypto';
import { RateLimitService } from '../../../infra/rate-limit';
import type { RequestMeta } from './request-meta';

/**
 * Applies the `sign-in`, `sign-in-code` and `token` limiters to the merchant portal.
 *
 * Why: decision 021 gives sign-in 5 attempts per email + network per 15 minutes and clears the count on success; the network is the
 * IPv4 address or the IPv6 /64 (`RequestMeta.limitKey`, decision 052). Like the staff limiter, keys that hold an email are keyed hashes
 * (`HMAC-SHA256(TOKEN_PEPPER, ...)`) so Redis shows no address, and the code, setup and password steps are limited per account, not per
 * session, so a new login does not give a thief fresh guesses; the code step uses `sign-in-code`, which is never counted in process
 * memory. The `merchant-sign-in` prefix keeps these counters apart from the staff ones. Registration and "forgot password" are counted
 * whether or not the email exists, so a 429 reveals nothing.
 *
 * Side effects: counter keys `gsm:{env}:ratelimit:sign-in:{hash}`, `...:sign-in-code:{hash}` and `...:token:{address}` on the cache Redis.
 */
@Injectable()
export class MerchantSignInLimiter {
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
   * Counts a registration from an address.
   *
   * @param limitKey the address key of the request (`RequestMeta.limitKey`)
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth registration in 15 minutes
   */
  async enforceRegister(limitKey: string): Promise<void> {
    await this.limits.enforce('sign-in', this.key('register', limitKey));
  }

  /**
   * Counts a "forgot password" request for an email from a network.
   *
   * @param email the email as typed
   * @param meta the caller (its network key)
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth request in 15 minutes
   */
  async enforceForgot(email: string, meta: Pick<RequestMeta, 'limitKey'>): Promise<void> {
    await this.limits.enforce('sign-in', this.key('forgot', email, meta.limitKey));
  }

  /**
   * Counts an authenticator code attempt of an account.
   *
   * @param clientId the merchant id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes, and at once (60 seconds)
   *   while the cache Redis cannot be reached
   */
  async enforceCode(clientId: number): Promise<void> {
    await this.limits.enforce('sign-in-code', this.key('code', String(clientId)));
  }

  /**
   * Clears the code counter after a correct code.
   *
   * @param clientId the merchant id
   */
  async resetCode(clientId: number): Promise<void> {
    await this.limits.reset('sign-in-code', this.key('code', String(clientId)));
  }

  /**
   * Counts an authenticator setup of an account.
   *
   * @param clientId the merchant id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth setup in 15 minutes
   */
  async enforceSetup(clientId: number): Promise<void> {
    await this.limits.enforce('sign-in', this.key('setup', String(clientId)));
  }

  /**
   * Counts a password change of an account (each try needs the current password, so this stops guessing it).
   *
   * @param clientId the merchant id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes
   */
  async enforcePasswordChange(clientId: number): Promise<void> {
    await this.limits.enforce('sign-in', this.key('password', String(clientId)));
  }

  /**
   * Clears the password-change counter after a correct current password.
   *
   * @param clientId the merchant id
   */
  async resetPasswordChange(clientId: number): Promise<void> {
    await this.limits.reset('sign-in', this.key('password', String(clientId)));
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
    return this.tokens.hash(`merchant-sign-in\u0000${kind}\u0000${normalised}`);
  }
}
