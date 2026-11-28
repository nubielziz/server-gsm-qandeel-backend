// AccountSignInLimiter: the rate limits of the sign-in family of every account (decision 021, decision 064), with keys that reveal no email.
import { Injectable } from '@nestjs/common';
import { TokenService } from '../../../infra/crypto';
import { RateLimitService } from '../../../infra/rate-limit';
import type { RequestMeta } from './request-meta';

/**
 * Applies the `sign-in`, `sign-in-code` and `token` limiters to the sign-in of every account, whatever its rank.
 *
 * Why: decision 021 gives sign-in 5 attempts per email + network per 15 minutes and clears the count on success; the network is the
 * IPv4 address or the IPv6 /64 (`RequestMeta.limitKey`, decision 052). The three sign-in routes (`POST /client/auth/sign-in`, `/client/auth/login`
 * and `POST /store/v1/auth/login`) run one use case and call the same `enforceLogin`, so they share one budget per email and network and
 * three routes cannot triple it (decision 064). Keys that hold an email are keyed hashes (`HMAC-SHA256(TOKEN_PEPPER, ...)`) so Redis shows
 * no address; the code, setup and password steps are limited per account, not per session, so a new sign-in does not give a thief fresh
 * guesses; the code step uses `sign-in-code`, which is never counted in process memory. "Forgot password" and the sign-in link are
 * counted whether or not the email exists, so a 429 reveals nothing. The key prefix stays `merchant-sign-in` on purpose: the counters of
 * the merchants that exist at the cut-over do not reset, and the old customer family `customer-sign-in` is no longer charged.
 *
 * Side effects: counter keys `gsm:{env}:ratelimit:sign-in:{hash}`, `...:sign-in-code:{hash}` and `...:token:{address}` on the cache Redis.
 *
 * @see docs/decisions/021-rate-limiting.md, docs/decisions/052-sign-in-and-mail-limits.md
 */
@Injectable()
export class AccountSignInLimiter {
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
   * @param accountId the account id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes, and at once (60 seconds)
   *   while the cache Redis cannot be reached
   */
  async enforceCode(accountId: number): Promise<void> {
    await this.limits.enforce('sign-in-code', this.key('code', String(accountId)));
  }

  /**
   * Clears the code counter after a correct code.
   *
   * @param accountId the account id
   */
  async resetCode(accountId: number): Promise<void> {
    await this.limits.reset('sign-in-code', this.key('code', String(accountId)));
  }

  /**
   * Counts an authenticator setup of an account.
   *
   * @param accountId the account id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth setup in 15 minutes
   */
  async enforceSetup(accountId: number): Promise<void> {
    await this.limits.enforce('sign-in', this.key('setup', String(accountId)));
  }

  /**
   * Counts a password change of an account (each try needs the current password, so this stops guessing it).
   *
   * @param accountId the account id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes
   */
  async enforcePasswordChange(accountId: number): Promise<void> {
    await this.limits.enforce('sign-in', this.key('password', String(accountId)));
  }

  /**
   * Counts a finish of a sign-up by a signed-in account (decision 079: `POST /store/v1/auth/sign-up/finish`).
   *
   * Why: each try hashes a password (argon2id, tens of milliseconds) for an account that has none yet; five tries per account in 15
   * minutes are plenty for a person correcting a form, and stop a script from spending the API's CPU through one session.
   *
   * @param accountId the account id
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes
   */
  async enforceSignUpFinish(accountId: number): Promise<void> {
    await this.limits.enforce('sign-in', this.key('sign-up-finish', String(accountId)));
  }

  /**
   * Clears the password-change counter after a correct current password.
   *
   * @param accountId the account id
   */
  async resetPasswordChange(accountId: number): Promise<void> {
    await this.limits.reset('sign-in', this.key('password', String(accountId)));
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

  /** The hashed key of one counter: the kind and the normalised parts, behind the prefix that keeps the merchant counters of before. */
  private key(kind: string, ...parts: string[]): string {
    const normalised = parts.map((part) => part.trim().toLowerCase()).join('\u0000');
    return this.tokens.hash(`merchant-sign-in\u0000${kind}\u0000${normalised}`);
  }
}
