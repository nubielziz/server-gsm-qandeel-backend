// A stand-in for the merchant portal in tests: it keeps the cookies and the CSRF token the way a browser and the portal's API
// client do, sends the Origin header, and offers the merchant-rank accounts, TOTP secrets and emailed links the sign-in tests need.
import type { LightMyRequestResponse } from 'fastify';
import { CacheKeys } from '@src/infra/cache';
import { schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { TURNSTILE_DUMMY_TOKEN, TURNSTILE_HEADER } from '@src/infra/turnstile';
import { CLIENT_TOTP_AAD, TotpService } from '@src/modules/identity/application/totp.service';
import type { Client } from '@src/modules/identity/db/schema';
import { accountLinks, captureAccountLinks } from './account-links';
import { ACCOUNT_SESSION_COOKIE } from './account-sessions';
import { accountRow, makeAccount } from './accounts';
import type { TestApp } from './app';
import { testDb } from './db';

/** The origin the test app lists for the shop (`SHOP_ORIGINS`, or the deprecated `CORS_ORIGINS`). */
export const PORTAL_ORIGIN = 'https://portal.example.com';
/** The password of every merchant `makeMerchant` creates unless told otherwise. */
export const MERCHANT_PASSWORD = 'correct-horse-battery';
/** The name of the session cookie (not secure in tests): the one cookie of every account. */
export const CLIENT_SESSION_COOKIE = ACCOUNT_SESSION_COOKIE;
/** The readable CSRF cookie. */
export const CLIENT_CSRF_COOKIE = 'csrf_token_client';

/** One call of the portal: what to send besides the cookies. */
export interface PortalCallOptions {
  /** Send the Origin header (default true, like a browser calling from the portal). */
  readonly origin?: boolean | string;
  /** Send `X-CSRF-Token`: the remembered token (default for mutations), a given text, or false to omit it. */
  readonly csrf?: boolean | string;
  /** Send the session cookie (default true). */
  readonly cookies?: boolean;
  /**
   * Send the anti-bot token: `true` the dummy token of the development verifier, a text that text, `false` nothing. The default is
   * `false`, except on `forgot`, whose route always checks the token (decision 064).
   */
  readonly turnstile?: boolean | string;
  /** More request headers; an `x-turnstile-token` here wins over `turnstile`. */
  readonly headers?: Readonly<Record<string, string>>;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A browser plus the portal's API client, talking to the test app by `inject`. */
export class MerchantPortal {
  private readonly jar = new Map<string, string>();
  /** The last CSRF token the API sent (header or cookie), as the portal remembers it. */
  csrf: string | undefined;

  constructor(
    private readonly t: TestApp,
    private readonly ip = '127.0.0.1',
  ) {}

  /** The value of a cookie in the jar. */
  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** The merchant session token in the jar. */
  get sessionToken(): string | undefined {
    return this.jar.get(CLIENT_SESSION_COOKIE);
  }

  /** Puts a session token in the jar, as a browser that kept an old cookie would. */
  setSessionToken(token: string): void {
    this.jar.set(CLIENT_SESSION_COOKIE, token);
  }

  /** Sends a request the way the portal does and absorbs the cookies and the CSRF header of the answer. */
  async call(
    method: Method,
    url: string,
    payload?: unknown,
    options: PortalCallOptions = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    const turnstile = options.turnstile ?? false;
    if (turnstile) headers[TURNSTILE_HEADER] = turnstile === true ? TURNSTILE_DUMMY_TOKEN : turnstile;
    Object.assign(headers, options.headers);
    const origin = options.origin ?? true;
    if (origin) headers.origin = origin === true ? PORTAL_ORIGIN : origin;
    if ((options.cookies ?? true) && this.jar.size > 0) {
      headers.cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const csrf = options.csrf ?? method !== 'GET';
    if (typeof csrf === 'string') headers['x-csrf-token'] = csrf;
    else if (csrf && this.csrf !== undefined) headers['x-csrf-token'] = this.csrf;
    const res = await this.t.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    for (const cookie of res.cookies) {
      if (cookie.value === '' || cookie.maxAge === 0) this.jar.delete(cookie.name);
      else this.jar.set(cookie.name, cookie.value);
    }
    const header = res.headers['x-csrf-token'];
    if (typeof header === 'string') this.csrf = header;
    return res;
  }

  /** `POST /client/auth/verify-email`. */
  verifyEmail(token: string, options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/auth/verify-email', { token }, options);
  }

  /** `POST /client/auth/login`. */
  login(
    email: string,
    password: string = MERCHANT_PASSWORD,
    options?: PortalCallOptions,
  ): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/auth/login', { email, password }, options);
  }

  /** `POST /client/auth/2fa`. */
  code(code: string, options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/auth/2fa', { code }, options);
  }

  /** `POST /client/auth/logout`. */
  logout(options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/auth/logout', undefined, options);
  }

  /** `POST /client/auth/password/change` (the new password during a forced change). */
  changeTemporaryPassword(password: string, options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/auth/password/change', { password }, options);
  }

  /** `POST /client/auth/verify-email/resend`. */
  resendVerification(options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/auth/verify-email/resend', undefined, options);
  }

  /** `POST /client/auth/password/forgot`, with the anti-bot token unless `options.turnstile` says otherwise. */
  forgot(email: string, options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/auth/password/forgot', { email }, { turnstile: true, ...options });
  }

  /** `POST /client/auth/password/reset`. */
  reset(token: string, password: string, options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/auth/password/reset', { token, password }, options);
  }

  /** `GET /client/auth/me`. */
  me(options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('GET', '/client/auth/me', undefined, options);
  }

  /** `PATCH /client/profile`. */
  profile(body: Record<string, unknown>, options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('PATCH', '/client/profile', body, options);
  }

  /** `POST /client/security/password`. */
  changePassword(
    currentPassword: string,
    newPassword: string,
    options?: PortalCallOptions,
  ): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/security/password', { currentPassword, newPassword }, options);
  }

  /** `POST /client/security/2fa/setup`. */
  setupTwoFactor(options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/security/2fa/setup', undefined, options);
  }

  /** `POST /client/security/2fa/enable`. */
  enableTwoFactor(code: string, options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/security/2fa/enable', { code }, options);
  }

  /** `POST /client/security/2fa/disable`. */
  disableTwoFactor(code: string, options?: PortalCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/client/security/2fa/disable', { code }, options);
  }
}

/** What `makeMerchant` creates. */
export interface MadeMerchant {
  readonly id: number;
  readonly email: string;
  /** The base32 secret of the merchant's authenticator (stored, encrypted, when 2FA is on or pending). */
  readonly secret: string;
  readonly row: Client;
}

/** What a test can change about the merchant `makeMerchant` creates. */
export type MerchantOverrides = Partial<typeof s.clients.$inferInsert> & {
  /** Store no password hash (a merchant that staff invited). */
  readonly noPassword?: boolean;
  /** The password to hash (default {@link MERCHANT_PASSWORD}). */
  readonly password?: string;
  /** Turn two-factor sign-in on (stores `twofa_enabled` and the encrypted secret). */
  readonly twofa?: boolean;
};

/**
 * Creates an active account of the merchant rank with a password and no 2FA, unless told otherwise.
 *
 * Why: a merchant is a merchant-rank row of the one account table (decision 064); this is `makeAccount({ rank: 'merchant' })` with the old
 * option names and the authenticator secret.
 *
 * @param t the running test app
 * @param overrides the columns to change, `noPassword`, `password`, `twofa`
 * @returns the id, the email, the base32 secret and the stored row
 */
export async function makeMerchant(t: TestApp, overrides: MerchantOverrides = {}): Promise<MadeMerchant> {
  const { noPassword, password, twofa, ...columns } = overrides;
  const totp = t.app.get(TotpService);
  const secret = totp.newSecret();
  const made = await makeAccount(t, {
    rank: 'merchant',
    password: noPassword ? null : (password ?? MERCHANT_PASSWORD),
    twofaEnabled: twofa === true,
    totpSecretEnc: twofa === true ? totp.seal(secret, CLIENT_TOTP_AAD) : null,
    ...columns,
  });
  return { id: made.id, email: made.email, secret, row: made.row };
}

/** Reads an account row back (the same read as `accountRow`). */
export const clientRow = accountRow;

/** A link that was created for an account's email. */
export interface EmailedLink {
  /** The mail it belongs to: `email_verification`, `password_reset`, `invited` or `magic_link`. */
  readonly kind: string;
  readonly accountId: number;
  /** The same number as `accountId`, under the name the old helper used. */
  readonly clientId: number;
  readonly token: string;
}

/**
 * Starts recording the links the app creates for emails (call it in `beforeEach`, and `mock.restore()` in `afterEach`).
 *
 * Why: see {@link captureAccountLinks}: the token service is one for every rank.
 *
 * @param t the running test app
 */
export function captureEmailedLinks(t: TestApp): void {
  captureAccountLinks(t);
}

/**
 * The links created since {@link captureEmailedLinks}, oldest first.
 *
 * @returns a copy of the list
 */
export function emailedLinks(): EmailedLink[] {
  return accountLinks().map((link) => ({ ...link, clientId: link.accountId }));
}

/**
 * Inserts what a merchant needs to exist: USD (the wallet currency) and the default merchant group.
 *
 * @returns the id of the default group
 */
export async function seedPortalBasics(): Promise<number> {
  const { db } = await testDb();
  await db
    .insert(s.currencies)
    .values({ code: 'USD', name: 'US dollar', rateToBase: '1', decimals: 2 })
    .onConflictDoNothing();
  const [group] = await db
    .insert(s.clientGroups)
    .values({ name: 'Standard', isDefault: true, discountPercent: '5' })
    .returning({ id: s.clientGroups.id });
  return group!.id;
}

/**
 * Deletes the rate-limit counters of the limiters the portal's sign-in family touches (the code and mail budgets too) and the
 * failed-sign-in counters and locks (the Redis instance outlives the tests).
 *
 * @param t the running test app
 */
export async function clearPortalRateLimits(t: TestApp): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const keys = t.app.get(CacheKeys);
  for (const limiter of ['ip', 'sign-in', 'sign-in-code', 'sign-in-familiar', 'account-mail', 'token'] as const) {
    const found = await redis.keys(`${keys.rateLimit(limiter)}:*`);
    if (found.length > 0) await redis.del(...found);
  }
  const failures = await redis.keys(`${keys.keyspace}identity:sign-in-failures:*`);
  if (failures.length > 0) await redis.del(...failures);
}
