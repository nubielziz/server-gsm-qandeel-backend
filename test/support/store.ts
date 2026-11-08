// A stand-in for the storefront in tests: it keeps the cookies and the CSRF token the way a browser and the storefront's API client
// do, sends the anti-bot token on every request (decision 034: the lead turns Turnstile on for the three public auth routes
// without touching the tests), and offers the customers and emailed links the sign-in tests need.
import { randomUUID } from 'node:crypto';
import { spyOn } from 'bun:test';
import type { LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { PasswordHasher } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { CustomerAuthTokens } from '../../src/modules/identity';
import type { Customer } from '../../src/modules/customers/db/schema';
import type { TestApp } from './app';
import { testDb } from './db';

/** The origin the storefront runs on in tests. */
export const STORE_ORIGIN = 'https://shop.example.com';
/** Cloudflare's dummy Turnstile token: the development verifier accepts exactly this one (decision 034). */
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
/** The password of every customer `makeCustomer` creates unless told otherwise. */
export const CUSTOMER_PASSWORD = 'correct-horse-battery';
/** The name of the session cookie (not secure in tests). */
export const STORE_SESSION_COOKIE = 'gsm_store_session';
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

  /** The customer session token in the jar. */
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
    const headers: Record<string, string> = { origin: STORE_ORIGIN };
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

/** What a test can change about the customer `makeCustomer` creates. */
export type CustomerOverrides = Partial<typeof s.customers.$inferInsert> & {
  /** Store no password hash (an account that was invited, or one that signs in by link). */
  readonly noPassword?: boolean;
  /** The password to hash (default {@link CUSTOMER_PASSWORD}). */
  readonly password?: string;
  /** Make a guest: no account, no credentials row. */
  readonly guest?: boolean;
  /** Set `must_change_password` (a temporary password). */
  readonly mustChangePassword?: boolean;
};

/** What `makeCustomer` creates. */
export interface MadeCustomer {
  readonly id: number;
  readonly email: string;
  readonly row: Customer;
}

/** Creates an active customer with an account and a password, unless told otherwise. */
export async function makeCustomer(t: TestApp, overrides: CustomerOverrides = {}): Promise<MadeCustomer> {
  const { db } = await testDb();
  const { noPassword, password, guest, mustChangePassword, ...columns } = overrides;
  const unique = randomUUID();
  const [row] = await db
    .insert(s.customers)
    .values({
      email: `customer-${unique}@example.com`,
      name: 'Test Customer',
      country: 'GB',
      locale: 'en',
      hasAccount: guest !== true,
      status: 'active',
      ...columns,
    })
    .returning();
  if (guest !== true) {
    await db.insert(s.customerCredentials).values({
      customerId: row!.id,
      passwordHash: noPassword ? null : await t.app.get(PasswordHasher).hash(password ?? CUSTOMER_PASSWORD),
      mustChangePassword: mustChangePassword === true,
      passwordChangedAt: noPassword ? null : new Date(),
    });
  }
  return { id: row!.id, email: row!.email, row: row! };
}

/** Reads a customer row back. */
export async function customerRow(id: number): Promise<Customer> {
  const { db } = await testDb();
  const [row] = await db.select().from(s.customers).where(eq(s.customers.id, id));
  return row!;
}

/** A link that was created for a customer's email. */
export interface CustomerLink {
  /** The mail it belongs to: `magic_link`, `password_reset`, `invited` or `email_verification`. */
  readonly kind: string;
  readonly customerId: number;
  readonly token: string;
}

const emailed: CustomerLink[] = [];
const MAIL_KIND = {
  magic_link: 'magic_link',
  reset: 'password_reset',
  invite: 'invited',
  verify_email: 'email_verification',
} as const;

/**
 * Starts recording the links the app creates for customer emails (call it in `beforeEach`, and `mock.restore()` in `afterEach`).
 *
 * Why: the outbox carries ids only and the clear token of a mail is made later, inside the mail job, which rotates the token (decision 033).
 * The token the request makes is a placeholder nobody receives, but it works until the job rotates it, so a test that follows a link
 * without running the job takes the placeholder from the token service as it is issued. A test of the mail itself runs the job and reads
 * the link from the mailbox (`customer-mail.test.ts`).
 *
 * @param t the running test app
 */
export function captureCustomerLinks(t: TestApp): void {
  emailed.length = 0;
  const tokens = t.app.get(CustomerAuthTokens);
  const issue = tokens.issue.bind(tokens);
  spyOn(tokens, 'issue').mockImplementation(async (work, input) => {
    const issued = await issue(work, input);
    emailed.push({ kind: MAIL_KIND[input.purpose], customerId: input.customerId, token: issued.token });
    return issued;
  });
}

/**
 * The links created since {@link captureCustomerLinks}, oldest first.
 *
 * @returns a copy of the list
 */
export function customerLinks(): CustomerLink[] {
  return [...emailed];
}

/**
 * Deletes the rate-limit counters of the limiters the sign-in family touches and the customers' wrong-password counters (the Redis
 * instance outlives the tests).
 *
 * @param t the running test app
 */
export async function clearStoreRateLimits(t: TestApp): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const keys = t.app.get(CacheKeys);
  for (const limiter of ['ip', 'sign-in', 'token'] as const) {
    const found = await redis.keys(`${keys.rateLimit(limiter)}:*`);
    if (found.length > 0) await redis.del(...found);
  }
  const failures = await redis.keys(`${keys.keyspace}customers:sign-in-failures:*`);
  if (failures.length > 0) await redis.del(...failures);
}
