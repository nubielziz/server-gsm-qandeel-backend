// Integration tests of the smart sign-in (feature 24A, POST /client/auth/sign-in) through HTTP on the real application: each kind's
// success and next step continued on its own routes, the merchant-wins rule for an email in both tables, one answer for every failure,
// the same limits, lock and work (one argon2 verify) for every kind of email, the budget shared with the two old login routes, and
// which stale sessions end. The app runs with TURNSTILE_MERCHANT_AUTH off (the default): the old merchant login needs no token.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { PasswordHasher, TokenService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { CSRF_COOKIE_NAMES, SESSION_COOKIE_NAMES, csrfTokenFor } from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, SECOND, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  MERCHANT_PASSWORD,
  MerchantPortal,
  PORTAL_ORIGIN,
  type PortalCallOptions,
  clearPortalRateLimits,
  makeMerchant,
  seedPortalBasics,
} from '../support/merchant-portal';
import { freshClientIp } from '../support/pipeline-routes';
import { codeFor } from '../support/staff-console';
import { TURNSTILE_TEST_TOKEN, clearStoreRateLimits, makeCustomer } from '../support/store';

/** The app's clock: the lock, codes and session lifetimes follow it (decision 031). */
const clock = new TestClock('2026-11-11T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-11T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await clearStoreRateLimits(t);
  await seedPortalBasics();
});

/** A customer's password, different from the merchant's, so a test can tell which hash matched. */
const CUSTOMER_PASSWORD = 'customer-only-password';
const TURNSTILE = { 'x-turnstile-token': TURNSTILE_TEST_TOKEN };

/** A browser on the site: one cookie jar for both kinds, the portal's Origin, and the Turnstile token on the sign-in form. */
const browser = (ip?: string) => new MerchantPortal(t, ip ?? freshClientIp());
const signIn = (
  b: MerchantPortal,
  email: string,
  password: string,
  options: PortalCallOptions = {},
): Promise<LightMyRequestResponse> =>
  b.call('POST', '/client/auth/sign-in', { email, password }, { csrf: false, headers: TURNSTILE, ...options });
const problem = (res: { json: () => unknown }) => res.json() as { code: string; errors?: Array<{ field: string }> };
const withoutRequestId = (res: { json: () => unknown }) => {
  const { requestId: _requestId, ...rest } = res.json() as Record<string, unknown>;
  return rest;
};
const sessionsOf = async (subjectType: 'client' | 'customer', subjectId: number) => {
  const { db } = await testDb();
  const rows = await db
    .select()
    .from(s.sessions)
    .where(eq(s.sessions.subjectId, subjectId))
    .orderBy(asc(s.sessions.id));
  return rows.filter((row) => row.subjectType === subjectType);
};
const allSessions = async () => {
  const { db } = await testDb();
  return db.select().from(s.sessions);
};
const uniqueEmail = (label: string) => `${label}-${randomUUID()}@example.com`;
/** The CSRF token the API binds to a session token. */
const csrfOf = (token: string) => csrfTokenFor(t.config.security.csrfSecret, t.app.get(TokenService).hash(token));

/** The four kinds of email the uniformity rules must treat alike, each with the password that signs it in (none for `none`). */
async function fourKinds(): Promise<Array<{ kind: string; email: string; password: string | undefined }>> {
  const merchant = await makeMerchant(t, { email: uniqueEmail('merchant-only') });
  const customer = await makeCustomer(t, { email: uniqueEmail('customer-only'), password: CUSTOMER_PASSWORD });
  const both = uniqueEmail('both');
  await makeMerchant(t, { email: both });
  await makeCustomer(t, { email: both, password: CUSTOMER_PASSWORD });
  return [
    { kind: 'merchant only', email: merchant.email, password: MERCHANT_PASSWORD },
    { kind: 'customer only', email: customer.email, password: CUSTOMER_PASSWORD },
    { kind: 'both', email: both, password: MERCHANT_PASSWORD },
    { kind: 'none', email: uniqueEmail('nobody'), password: undefined },
  ];
}

describe('POST /client/auth/sign-in: merchants', () => {
  it('signs a merchant in at once: kind merchant, the /client cookies and CSRF token, a full session, no-store', async () => {
    const merchant = await makeMerchant(t);
    const b = browser();
    const res = await signIn(b, merchant.email.toUpperCase(), MERCHANT_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'merchant', next: 'done' });
    expect(res.headers['cache-control']).toBe('no-store');

    const names = res.cookies.map((cookie) => cookie.name).sort();
    expect(names).toEqual([CSRF_COOKIE_NAMES.client, SESSION_COOKIE_NAMES.client].sort());
    const sessionCookie = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.client)!;
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(res.headers['x-csrf-token']).toBe(csrfOf(sessionCookie.value));
    expect(await sessionsOf('client', merchant.id)).toMatchObject([{ stage: 'active' }]);
    expect((await b.me()).statusCode).toBe(200);
  });

  it('asks a merchant with 2FA for the code (next totp), which POST /client/auth/2fa completes', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const b = browser();
    const res = await signIn(b, merchant.email, MERCHANT_PASSWORD);
    expect(res.json()).toEqual({ kind: 'merchant', next: 'totp' });
    expect(await sessionsOf('client', merchant.id)).toMatchObject([{ stage: 'pending_totp' }]);
    expect((await b.me()).statusCode).toBe(401);
    expect((await b.code(await codeFor(merchant.secret, clock.nowMs()))).statusCode).toBe(204);
    expect((await b.me()).statusCode).toBe(200);
  });

  it('sends a merchant with a temporary password to the forced change (next password, feature 20)', async () => {
    const merchant = await makeMerchant(t, { mustChangePassword: true });
    const b = browser();
    const res = await signIn(b, merchant.email, MERCHANT_PASSWORD);
    expect(res.json()).toEqual({ kind: 'merchant', next: 'password' });
    expect(await sessionsOf('client', merchant.id)).toMatchObject([{ stage: 'pending_password' }]);
    const changed = await b.changeTemporaryPassword('a-quiet-harbour-at-dawn');
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ next: 'done' });
    expect((await b.me()).statusCode).toBe(200);
  });
});

describe('POST /client/auth/sign-in: customers', () => {
  it('signs a customer in: kind customer, the /store/v1 cookies and CSRF token, a full session, last_login_at', async () => {
    const customer = await makeCustomer(t, { password: CUSTOMER_PASSWORD });
    const b = browser();
    const res = await signIn(b, customer.email, CUSTOMER_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'customer', next: 'done' });
    expect(res.headers['cache-control']).toBe('no-store');

    const names = res.cookies.map((cookie) => cookie.name).sort();
    expect(names).toEqual([CSRF_COOKIE_NAMES.customer, SESSION_COOKIE_NAMES.customer].sort());
    const token = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.customer)!.value;
    expect(res.headers['x-csrf-token']).toBe(csrfOf(token));
    expect(await sessionsOf('customer', customer.id)).toMatchObject([{ stage: 'active' }]);
    const { db } = await testDb();
    const [row] = await db.select().from(s.customers).where(eq(s.customers.id, customer.id));
    expect(row!.lastLoginAt?.toISOString()).toBe('2026-11-11T09:00:00.000Z');
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);
  });

  it('sends a customer with a temporary password to POST /store/v1/me/password (next password)', async () => {
    const customer = await makeCustomer(t, { password: CUSTOMER_PASSWORD, mustChangePassword: true });
    const b = browser();
    expect((await signIn(b, customer.email, CUSTOMER_PASSWORD)).json()).toEqual({ kind: 'customer', next: 'password' });
    expect(await sessionsOf('customer', customer.id)).toMatchObject([{ stage: 'pending_password' }]);
    const changed = await b.call('POST', '/store/v1/me/password', {
      currentPassword: CUSTOMER_PASSWORD,
      newPassword: 'a-blue-lagoon-in-winter',
    });
    expect(changed.statusCode, changed.body).toBe(204);
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);
  });
});

describe('POST /client/auth/sign-in: an email in both tables', () => {
  it('signs in as the merchant with the merchant password; the customer password is a 401 and opens nothing', async () => {
    const email = uniqueEmail('both');
    const merchant = await makeMerchant(t, { email });
    await makeCustomer(t, { email, password: CUSTOMER_PASSWORD });

    const wrong = await signIn(browser(), email, CUSTOMER_PASSWORD);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.cookies).toEqual([]);
    expect(await allSessions()).toEqual([]);

    const right = await signIn(browser(), email, MERCHANT_PASSWORD);
    expect(right.json()).toEqual({ kind: 'merchant', next: 'done' });
    expect(await sessionsOf('client', merchant.id)).toHaveLength(1);
  });

  it('signs in as the customer when the merchant has no password yet (it does not shadow the customer)', async () => {
    const email = uniqueEmail('invited');
    await makeMerchant(t, { email, noPassword: true, status: 'pending' });
    const customer = await makeCustomer(t, { email, password: CUSTOMER_PASSWORD });
    const res = await signIn(browser(), email, CUSTOMER_PASSWORD);
    expect(res.json()).toEqual({ kind: 'customer', next: 'done' });
    expect(await sessionsOf('customer', customer.id)).toHaveLength(1);
  });
});

describe('POST /client/auth/sign-in: refusals', () => {
  it('gives one 401 to an unknown email, wrong passwords, no password yet, a guest and an erased customer', async () => {
    const merchant = await makeMerchant(t);
    const customer = await makeCustomer(t, { password: CUSTOMER_PASSWORD });
    const noPasswordMerchant = await makeMerchant(t, { noPassword: true, status: 'pending' });
    const noPasswordCustomer = await makeCustomer(t, { noPassword: true });
    const guest = await makeCustomer(t, { guest: true });
    // An erased customer whose credentials row still holds its old password: the right password is refused too.
    const anonymized = await makeCustomer(t, { status: 'anonymized', password: CUSTOMER_PASSWORD });
    const answers = [
      await signIn(browser(), uniqueEmail('nobody'), MERCHANT_PASSWORD),
      await signIn(browser(), merchant.email, 'not-the-password'),
      await signIn(browser(), customer.email, 'not-the-password'),
      await signIn(browser(), noPasswordMerchant.email, MERCHANT_PASSWORD),
      await signIn(browser(), noPasswordCustomer.email, CUSTOMER_PASSWORD),
      await signIn(browser(), guest.email, CUSTOMER_PASSWORD),
      await signIn(browser(), anonymized.email, CUSTOMER_PASSWORD),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(401);
      expect(res.cookies).toEqual([]);
    }
    const first = withoutRequestId(answers[0]!);
    expect(first).toMatchObject({ code: 'UNAUTHORIZED', detail: 'The email or password is not correct.' });
    for (const res of answers) expect(withoutRequestId(res)).toEqual(first);
    expect(await allSessions()).toEqual([]);
  });

  it('says ACCOUNT_SUSPENDED only after a correct password: a suspended merchant, a suspended and a blocked customer', async () => {
    const merchant = await makeMerchant(t, { status: 'suspended' });
    const suspended = await makeCustomer(t, { status: 'suspended', password: CUSTOMER_PASSWORD });
    const blocked = await makeCustomer(t, { status: 'blocked', password: CUSTOMER_PASSWORD });
    for (const [email, password] of [
      [merchant.email, MERCHANT_PASSWORD],
      [suspended.email, CUSTOMER_PASSWORD],
      [blocked.email, CUSTOMER_PASSWORD],
    ] as const) {
      const right = await signIn(browser(), email, password);
      expect(right.statusCode).toBe(403);
      expect(problem(right).code).toBe('ACCOUNT_SUSPENDED');
      expect(right.cookies).toEqual([]);
      expect((await signIn(browser(), email, 'not-the-password')).statusCode).toBe(401);
    }
    expect(await allSessions()).toEqual([]);
  });

  it('needs the Turnstile token first: no counter charged and no password hashed without it', async () => {
    const merchant = await makeMerchant(t);
    const ip = freshClientIp();
    const verify = spyOn(t.app.get(PasswordHasher), 'verify');
    try {
      const tokens: Array<Record<string, string>> = [{}, { 'x-turnstile-token': 'not-the-dummy-token' }];
      for (const headers of tokens) {
        for (let i = 0; i < 6; i++) {
          const res = await signIn(browser(ip), merchant.email, 'not-the-password', { headers });
          expect(res.statusCode).toBe(403);
          expect(problem(res).code).toBe('TURNSTILE_FAILED');
        }
      }
      expect(verify).not.toHaveBeenCalled();
      expect((await signIn(browser(ip), merchant.email, MERCHANT_PASSWORD)).statusCode).toBe(200);
    } finally {
      verify.mockRestore();
    }
  });

  it('refuses a missing or foreign Origin (403 CSRF_FAILED) and a bad body (422)', async () => {
    const merchant = await makeMerchant(t);
    for (const origin of [false, 'https://evil.example.com'] as const) {
      const res = await signIn(browser(), merchant.email, MERCHANT_PASSWORD, { origin });
      expect(res.statusCode).toBe(403);
      expect(problem(res).code).toBe('CSRF_FAILED');
    }
    const empty = await browser().call('POST', '/client/auth/sign-in', {}, { csrf: false, headers: TURNSTILE });
    expect(empty.statusCode).toBe(422);
    expect(
      problem(empty)
        .errors?.map((error) => error.field)
        .sort(),
    ).toEqual(['email', 'password']);
    const long = await signIn(browser(), 'x'.repeat(255), MERCHANT_PASSWORD);
    expect(long.statusCode).toBe(422);
  });
});

describe('POST /client/auth/sign-in: every kind of email is treated alike', () => {
  it('answers 429 with Retry-After on the sixth attempt from one address, for each kind', async () => {
    for (const { kind, email } of await fourKinds()) {
      const ip = freshClientIp();
      for (let i = 0; i < 5; i++)
        expect((await signIn(browser(ip), email, 'wrong-password')).statusCode, kind).toBe(401);
      const limited = await signIn(browser(ip), email, 'wrong-password');
      expect(limited.statusCode, kind).toBe(429);
      expect(problem(limited).code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }
  });

  it('locks each kind for 15 minutes after ten failures from rotating addresses; the lock ends with the clock', async () => {
    const kinds = await fourKinds();
    for (const { kind, email } of kinds) {
      for (let i = 0; i < 10; i++)
        expect((await signIn(browser(), email, 'wrong-password')).statusCode, kind).toBe(401);
      const locked = await signIn(browser(), email, 'wrong-password');
      expect(locked.statusCode, kind).toBe(429);
      expect(Number(locked.headers['retry-after']), kind).toBe(15 * 60);
    }
    clock.advance(15 * MINUTE + SECOND);
    for (const { kind, email, password } of kinds) {
      const res = await signIn(browser(), email, password ?? 'any-password');
      expect(res.statusCode, kind).toBe(password === undefined ? 401 : 200);
    }
  });

  it('runs exactly one password verify per attempt for each kind, and none on a 429', async () => {
    const kinds = await fourKinds();
    const verify = spyOn(t.app.get(PasswordHasher), 'verify');
    try {
      for (const { kind, email } of kinds) {
        const ip = freshClientIp();
        verify.mockClear();
        for (let i = 0; i < 5; i++) await signIn(browser(ip), email, 'wrong-password');
        expect(verify, kind).toHaveBeenCalledTimes(5);
        verify.mockClear();
        expect((await signIn(browser(ip), email, 'wrong-password')).statusCode, kind).toBe(429);
        expect(verify, kind).not.toHaveBeenCalled();
      }
      for (const { kind, email, password } of kinds.filter((entry) => entry.password !== undefined)) {
        verify.mockClear();
        expect((await signIn(browser(), email, password!)).statusCode, kind).toBe(200);
        expect(verify, kind).toHaveBeenCalledTimes(1);
      }
    } finally {
      verify.mockRestore();
    }
  });
});

describe('POST /client/auth/sign-in: one budget with the two old login routes', () => {
  it('after five smart failures both old routes answer 429 for that email and address', async () => {
    const email = uniqueEmail('both');
    await makeMerchant(t, { email });
    await makeCustomer(t, { email, password: CUSTOMER_PASSWORD });
    const ip = freshClientIp();
    for (let i = 0; i < 5; i++) expect((await signIn(browser(ip), email, 'wrong-password')).statusCode).toBe(401);
    expect((await browser(ip).login(email)).statusCode).toBe(429);
    const store = await browser(ip).call(
      'POST',
      '/store/v1/auth/login',
      { email, password: CUSTOMER_PASSWORD },
      { csrf: false, headers: TURNSTILE },
    );
    expect(store.statusCode).toBe(429);
    // Another address still has its own budget on the old merchant route (no token needed while the switch is off).
    expect((await browser().login(email)).statusCode).toBe(200);
  });

  it('a success resets both counters and the lock', async () => {
    const email = uniqueEmail('merchant');
    await makeMerchant(t, { email });
    const ip = freshClientIp();
    for (let i = 0; i < 4; i++) await signIn(browser(ip), email, 'wrong-password');
    expect((await signIn(browser(ip), email, MERCHANT_PASSWORD)).statusCode).toBe(200);
    // Both counters start again: five wrong tries on each old route are 401, not 429.
    for (let i = 0; i < 5; i++) expect((await browser(ip).login(email, 'wrong-password')).statusCode).toBe(401);
    for (let i = 0; i < 5; i++) {
      const res = await browser(ip).call(
        'POST',
        '/store/v1/auth/login',
        { email, password: 'wrong-password' },
        { csrf: false, headers: TURNSTILE },
      );
      expect(res.statusCode).toBe(401);
    }
    // The lock starts again too: nine failures, a success, nine more failures, and the email is still open.
    const other = uniqueEmail('merchant');
    await makeMerchant(t, { email: other });
    for (let i = 0; i < 9; i++) await signIn(browser(), other, 'wrong-password');
    expect((await signIn(browser(), other, MERCHANT_PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) expect((await signIn(browser(), other, 'wrong-password')).statusCode).toBe(401);
    expect((await signIn(browser(), other, MERCHANT_PASSWORD)).statusCode).toBe(200);
  });
});

describe('POST /client/auth/sign-in: stale sessions', () => {
  it('ends the stale session of the same kind and keeps the session of the other kind', async () => {
    const merchant = await makeMerchant(t);
    const customer = await makeCustomer(t, { password: CUSTOMER_PASSWORD });
    const b = browser();
    await signIn(b, customer.email, CUSTOMER_PASSWORD);
    await signIn(b, merchant.email, MERCHANT_PASSWORD);
    const firstMerchant = b.sessionToken!;
    const customerToken = b.cookie(SESSION_COOKIE_NAMES.customer)!;

    // A second merchant sign-in from the same browser ends the first merchant session.
    await signIn(b, merchant.email, MERCHANT_PASSWORD);
    expect(b.sessionToken).not.toBe(firstMerchant);
    expect(await sessionsOf('client', merchant.id)).toMatchObject([
      { revokedAt: expect.any(Date) },
      { revokedAt: null },
    ]);
    const stale = browser();
    stale.setSessionToken(firstMerchant);
    expect((await stale.me()).statusCode).toBe(401);

    // The customer session the browser holds was never touched.
    expect(b.cookie(SESSION_COOKIE_NAMES.customer)).toBe(customerToken);
    expect(await sessionsOf('customer', customer.id)).toMatchObject([{ revokedAt: null }]);
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);
    expect((await b.me()).statusCode).toBe(200);

    // And a customer sign-in ends the stale customer session but keeps the merchant one.
    await signIn(b, customer.email, CUSTOMER_PASSWORD);
    expect(b.cookie(SESSION_COOKIE_NAMES.customer)).not.toBe(customerToken);
    expect(await sessionsOf('customer', customer.id)).toMatchObject([
      { revokedAt: expect.any(Date) },
      { revokedAt: null },
    ]);
    expect((await b.me()).statusCode).toBe(200);
  });
});

describe('the old merchant routes while TURNSTILE_MERCHANT_AUTH is off', () => {
  it('answer as before without a token', async () => {
    const merchant = await makeMerchant(t);
    const b = browser();
    const login = await b.login(merchant.email);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ next: 'done' });
    expect((await b.forgot(merchant.email)).statusCode).toBe(204);
  });
});
