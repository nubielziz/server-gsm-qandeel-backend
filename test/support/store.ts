// A stand-in for the storefront in tests: it keeps the cookies and the CSRF token the way a browser and the storefront's API client
// do, sends the anti-bot token on every request (decision 034: the lead turns Turnstile on for the three public auth routes
// without touching the tests), and offers the retail accounts and emailed links the sign-in tests need.
import type { LightMyRequestResponse } from 'fastify';
import { CacheKeys } from '@src/infra/cache';
import { schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { ACCOUNT_SESSION_COOKIE } from './account-sessions';
import { accountLinks, captureAccountLinks } from './account-links';
import { accountRow, makeAccount } from './accounts';
import type { TestApp } from './app';

export { ensureRetailGroup, makeAccount } from './accounts';

/** The origin the storefront runs on in tests. */
export const STORE_ORIGIN = 'https://shop.example.com';
/** Cloudflare's dummy Turnstile token: the development verifier accepts exactly this one (decision 034). */
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
/** The password of every retail account `makeCustomer` creates unless told otherwise. */
export const CUSTOMER_PASSWORD = 'correct-horse-battery';
/** The name of the session cookie (not secure in tests): the one cookie of every account, the storefront reads it too (decision 064). */
export const STORE_SESSION_COOKIE = ACCOUNT_SESSION_COOKIE;
/** The readable CSRF cookie. */
export const STORE_CSRF_COOKIE = 'csrf_token_store';

/** One call of the storefront: what to send besides the cookies. */
export interface StoreCallOptions {
  /** Send `X-CSRF-Token`: the remembered token (default for mutations), a given text, or false to omit it. */
  readonly csrf?: boolean | string;
  /** Send the session cookie (default true). */
  readonly cookies?: boolean;
  /** Send the Turnstile token (default true); `false` leaves it out, a text sends that text. */
  readonly turnstile?: boolean | string;
  /** More request headers (an `idempotency-key`, a content type). */
  readonly headers?: Readonly<Record<string, string>>;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A browser plus the storefront's API client, talking to the test app by `inject`. */
export class StoreClient {
  private readonly jar = new Map<string, string>();
  /** The last CSRF token the API sent (header or cookie), as the storefront remembers it. */
  csrf: string | undefined;

  constructor(
    private readonly t: TestApp,
    private readonly ip = '127.0.0.1',
  ) {}

  /** The value of a cookie in the jar. */
  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** The account session token in the jar. */
  get sessionToken(): string | undefined {
    return this.jar.get(STORE_SESSION_COOKIE);
  }

  /** Puts a session token in the jar, as a browser that kept an old cookie would. */
  setSessionToken(token: string): void {
    this.jar.set(STORE_SESSION_COOKIE, token);
  }

  /** Sends a request the way the storefront does and absorbs the cookies and the CSRF header of the answer. */
  async call(
    method: Method,
    url: string,
    payload?: unknown,
    options: StoreCallOptions = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { origin: STORE_ORIGIN, ...options.headers };
    const turnstile = options.turnstile ?? true;
    if (turnstile) headers['x-turnstile-token'] = turnstile === true ? TURNSTILE_TEST_TOKEN : turnstile;
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

  /** `POST /store/v1/auth/magic-link`. */
  magicLink(email: string, options?: StoreCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/store/v1/auth/magic-link', { email }, options);
  }

  /** `POST /store/v1/auth/verify`. */
  verify(token: string, options?: StoreCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/store/v1/auth/verify', { token }, options);
  }

  /** `POST /store/v1/auth/login`. */
  login(
    email: string,
    password: string = CUSTOMER_PASSWORD,
    options?: StoreCallOptions,
  ): Promise<LightMyRequestResponse> {
    return this.call('POST', '/store/v1/auth/login', { email, password }, options);
  }

  /** `POST /store/v1/auth/password/forgot`. */
  forgot(email: string, options?: StoreCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/store/v1/auth/password/forgot', { email }, options);
  }

  /** `POST /store/v1/auth/password/set`. */
  setPassword(token: string, password: string, options?: StoreCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/store/v1/auth/password/set', { token, password }, options);
  }

  /** `POST /store/v1/me/password`. */
  changePassword(
    currentPassword: string,
    newPassword: string,
    options?: StoreCallOptions,
  ): Promise<LightMyRequestResponse> {
    return this.call('POST', '/store/v1/me/password', { currentPassword, newPassword }, options);
  }

  /** `POST /store/v1/auth/logout`. */
  logout(options?: StoreCallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/store/v1/auth/logout', undefined, options);
  }

  /** `GET /store/v1/me`. */
  me(options?: StoreCallOptions): Promise<LightMyRequestResponse> {
    return this.call('GET', '/store/v1/me', undefined, options);
  }

  /** `PATCH /store/v1/me`. */
  updateMe(body: Record<string, unknown>, options?: StoreCallOptions): Promise<LightMyRequestResponse> {
    return this.call('PATCH', '/store/v1/me', body, options);
  }

  /** `GET /store/v1/me/orders`. */
  orders(query = '', options?: StoreCallOptions): Promise<LightMyRequestResponse> {
    return this.call('GET', `/store/v1/me/orders${query}`, undefined, options);
  }
}

/** What a test can change about the retail account `makeCustomer` creates. */
export type CustomerOverrides = Partial<typeof s.clients.$inferInsert> & {
  /** Store no password hash (an account that was invited, or one that signs in by link). */
  readonly noPassword?: boolean;
  /** The password to hash (default {@link CUSTOMER_PASSWORD}). */
  readonly password?: string;
  /** Make a guest: no login (`has_account` false), no password, no username. */
  readonly guest?: boolean;
  /** Set `must_change_password` (a temporary password). */
  readonly mustChangePassword?: boolean;
};

/** What `makeCustomer` creates. */
export interface MadeCustomer {
  readonly id: number;
  readonly email: string;
  readonly row: typeof s.clients.$inferSelect;
}

/**
 * Creates an active retail account with a login and a password, unless told otherwise.
 *
 * Why: a customer is a retail-rank row of the one account table (decision 064); the name stays so the callers of the old helper compile.
 * It is `makeAccount({ rank: 'retail' })` with the old option names.
 *
 * @param t the running test app
 * @param overrides the columns to change, `noPassword`, `password`, `guest`, `mustChangePassword`
 * @returns the id, the email and the stored row
 */
export async function makeCustomer(t: TestApp, overrides: CustomerOverrides = {}): Promise<MadeCustomer> {
  const { noPassword, password, guest, mustChangePassword, ...columns } = overrides;
  const made = await makeAccount(t, {
    rank: 'retail',
    ...(guest === true ? { guest: true } : {}),
    password: noPassword ? null : (password ?? CUSTOMER_PASSWORD),
    ...(mustChangePassword === true ? { mustChangePassword: true } : {}),
    ...columns,
  });
  return { id: made.id, email: made.email, row: made.row };
}

/** Reads a retail account row back (the same read as `accountRow`). */
export const customerRow = accountRow;

/** A link that was created for an account's email. */
export interface CustomerLink {
  /** The mail it belongs to: `magic_link`, `password_reset`, `invited` or `email_verification`. */
  readonly kind: string;
  readonly accountId: number;
  /** The same number as `accountId`, under the name the old helper used. */
  readonly customerId: number;
  readonly token: string;
}

/**
 * Starts recording the links the app creates for account emails (call it in `beforeEach`, and `mock.restore()` in `afterEach`).
 *
 * Why: see {@link captureAccountLinks}: the token service is one for every rank.
 *
 * @param t the running test app
 */
export function captureCustomerLinks(t: TestApp): void {
  captureAccountLinks(t);
}

/**
 * The links created since {@link captureCustomerLinks}, oldest first.
 *
 * @returns a copy of the list
 */
export function customerLinks(): CustomerLink[] {
  return accountLinks().map((link) => ({ ...link, customerId: link.accountId }));
}

/**
 * Deletes the rate-limit counters of the limiters the sign-in family touches (the code and mail budgets too) and the failed-sign-in
 * counters and locks (the Redis instance outlives the tests).
 *
 * @param t the running test app
 */
export async function clearStoreRateLimits(t: TestApp): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const keys = t.app.get(CacheKeys);
  for (const limiter of [
    'ip',
    'sign-in',
    'sign-in-code',
    'sign-in-familiar',
    'account-mail',
    'token',
    'upload',
    'wallet-topup',
  ] as const) {
    const found = await redis.keys(`${keys.rateLimit(limiter)}:*`);
    if (found.length > 0) await redis.del(...found);
  }
  const failures = await redis.keys(`${keys.keyspace}identity:sign-in-failures:*`);
  if (failures.length > 0) await redis.del(...failures);
}
