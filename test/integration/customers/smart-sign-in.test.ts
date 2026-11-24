// Integration tests of the one sign-in (feature 24A, decision 064, POST /client/auth/sign-in) through HTTP on the real application: each rank's
// success and next step continued on its own routes, one login row per email (a guest row never signs in), one answer for every failure, the
// same limits, lock and work (one argon2 verify) for every kind of email, the budget shared with the two other sign-in routes, and which
// sessions a second sign-in ends. The app runs with TURNSTILE_MERCHANT_AUTH off (the default): the merchant login route needs no token.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { PasswordHasher, TokenService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { SESSION_COOKIE_NAMES, csrfTokenFor } from '@src/modules/identity';
import { csrfCookieNameOf } from '../../support/account-sessions';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { MINUTE, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  MERCHANT_PASSWORD,
  MerchantPortal,
  PORTAL_ORIGIN,
  type PortalCallOptions,
  clearPortalRateLimits,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { freshClientIp } from '../../support/pipeline-routes';
import { codeFor } from '../../support/staff-console';
import { TURNSTILE_TEST_TOKEN, clearStoreRateLimits, makeCustomer } from '../../support/store';

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

/** A retail account's password, different from the merchant's, so a test can tell which hash matched. */
const RETAIL_PASSWORD = 'retail-only-password';
const TURNSTILE = { 'x-turnstile-token': TURNSTILE_TEST_TOKEN };

/** A browser on the site: one cookie jar for both ranks, the portal's Origin, and the Turnstile token on the sign-in form. */
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
const sessionsOf = async (accountId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.sessions)
    .where(eq(s.sessions.subjectId, accountId))
    .orderBy(asc(s.sessions.id))
    .then((rows) => rows.filter((row) => row.subjectType === 'account'));
};
const allSessions = async () => {
  const { db } = await testDb();
  return db.select().from(s.sessions);
};
const uniqueEmail = (label: string) => `${label}-${randomUUID()}@example.com`;
/** The id and name of the rank an account holds, as the sign-in answers them in `rank` (the test adds the kind it expects). */
const rankOf = async (accountId: number) => {
  const { db } = await testDb();
  const [row] = await db
    .select({ id: s.clientGroups.id, name: s.clientGroups.name })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, accountId));
  return row!;
};
/** The CSRF token the API binds to a session token. */
const csrfOf = (token: string) => csrfTokenFor(t.config.security.csrfSecret, t.app.get(TokenService).hash(token));

/** The three kinds of email the uniformity rules must treat alike, each with the password that signs it in (none for `none`). */
async function threeKinds(): Promise<Array<{ kind: string; email: string; password: string | undefined }>> {
  const merchant = await makeMerchant(t, { email: uniqueEmail('merchant-only') });
  const retail = await makeCustomer(t, { email: uniqueEmail('retail-only'), password: RETAIL_PASSWORD });
  return [
    { kind: 'merchant rank', email: merchant.email, password: MERCHANT_PASSWORD },
    { kind: 'retail rank', email: retail.email, password: RETAIL_PASSWORD },
    { kind: 'none', email: uniqueEmail('nobody'), password: undefined },
  ];
}

describe('POST /client/auth/sign-in: the merchant rank', () => {
  it('signs a merchant in at once: kind merchant, the one session cookie and the merchant CSRF cookie, a full session, no-store', async () => {
    const merchant = await makeMerchant(t);
    const b = browser();
    const res = await signIn(b, merchant.email.toUpperCase(), MERCHANT_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'merchant',
      next: 'done',
      rank: { ...(await rankOf(merchant.id)), kind: 'merchant' },
    });
    expect(res.headers['cache-control']).toBe('no-store');

    // The cookies it sets: the sign-in also clears the names it no longer uses (the old shop cookie, the other family's CSRF cookie).
    const names = res.cookies
      .filter((cookie) => cookie.value !== '')
      .map((cookie) => cookie.name)
      .sort();
    expect(names).toEqual([csrfCookieNameOf('merchant'), SESSION_COOKIE_NAMES.account].sort());
    const sessionCookie = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.account)!;
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(res.headers['x-csrf-token']).toBe(csrfOf(sessionCookie.value));
    expect(await sessionsOf(merchant.id)).toMatchObject([{ stage: 'active' }]);
    expect((await b.me()).statusCode).toBe(200);
  });

  it('asks a merchant with 2FA for the code (next totp), which POST /client/auth/2fa completes', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const b = browser();
    const res = await signIn(b, merchant.email, MERCHANT_PASSWORD);
    expect(res.json()).toEqual({
      kind: 'merchant',
      next: 'totp',
      rank: { ...(await rankOf(merchant.id)), kind: 'merchant' },
    });
    expect(await sessionsOf(merchant.id)).toMatchObject([{ stage: 'pending_totp' }]);
    expect((await b.me()).statusCode).toBe(401);
    expect((await b.code(await codeFor(merchant.secret, clock.nowMs()))).statusCode).toBe(204);
    expect((await b.me()).statusCode).toBe(200);
  });

  it('sends a merchant with a temporary password to the forced change (next password, feature 20)', async () => {
    const merchant = await makeMerchant(t, { mustChangePassword: true });
    const b = browser();
    const res = await signIn(b, merchant.email, MERCHANT_PASSWORD);
    expect(res.json()).toEqual({
      kind: 'merchant',
      next: 'password',
      rank: { ...(await rankOf(merchant.id)), kind: 'merchant' },
    });
    expect(await sessionsOf(merchant.id)).toMatchObject([{ stage: 'pending_password' }]);
    const changed = await b.changeTemporaryPassword('a-quiet-harbour-at-dawn');
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ next: 'done' });
    expect((await b.me()).statusCode).toBe(200);
  });
});

describe('POST /client/auth/sign-in: the retail rank', () => {
  it('signs a retail account in: the retail rank (kind customer until the contract release), the shop CSRF cookie, a full session, last_login_at', async () => {
    const account = await makeCustomer(t, { password: RETAIL_PASSWORD });
    const b = browser();
    const res = await signIn(b, account.email, RETAIL_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'customer',
      next: 'done',
      rank: { ...(await rankOf(account.id)), kind: 'retail' },
    });
    expect(res.headers['cache-control']).toBe('no-store');

    // The cookies it sets: the sign-in also clears the names it no longer uses (the old shop cookie, the other family's CSRF cookie).
    const names = res.cookies
      .filter((cookie) => cookie.value !== '')
      .map((cookie) => cookie.name)
      .sort();
    expect(names).toEqual([csrfCookieNameOf('retail'), SESSION_COOKIE_NAMES.account].sort());
    const token = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.account)!.value;
    expect(res.headers['x-csrf-token']).toBe(csrfOf(token));
    expect(await sessionsOf(account.id)).toMatchObject([{ stage: 'active' }]);
    const { db } = await testDb();
    const [row] = await db.select().from(s.clients).where(eq(s.clients.id, account.id));
    expect(row!.lastLoginAt?.toISOString()).toBe('2026-11-11T09:00:00.000Z');
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);
  });

  it('sends a retail account with a temporary password to POST /store/v1/me/password (next password)', async () => {
    const account = await makeCustomer(t, { password: RETAIL_PASSWORD, mustChangePassword: true });
    const b = browser();
    expect((await signIn(b, account.email, RETAIL_PASSWORD)).json()).toEqual({
      kind: 'customer',
      next: 'password',
      rank: { ...(await rankOf(account.id)), kind: 'retail' },
    });
    expect(await sessionsOf(account.id)).toMatchObject([{ stage: 'pending_password' }]);
    const changed = await b.call('POST', '/store/v1/me/password', {
      currentPassword: RETAIL_PASSWORD,
      newPassword: 'a-blue-lagoon-in-winter',
    });
    expect(changed.statusCode, changed.body).toBe(204);
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);
  });
});

describe('POST /client/auth/sign-in: one login row per email', () => {
  it('signs the login row in when a guest row holds the same email, whatever the order they were made in', async () => {
    const email = uniqueEmail('shared');
    const guest = await makeCustomer(t, { email, guest: true });
    const account = await makeCustomer(t, { email, password: RETAIL_PASSWORD });
    const res = await signIn(browser(), email, RETAIL_PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      kind: 'customer',
      next: 'done',
      rank: { ...(await rankOf(account.id)), kind: 'retail' },
    });
    expect(await sessionsOf(account.id)).toHaveLength(1);
    expect(await sessionsOf(guest.id)).toEqual([]);
  });

  it('never signs a guest row in, and keeps its answer the same as for an unknown email', async () => {
    const guest = await makeCustomer(t, { guest: true });
    const guestAnswer = await signIn(browser(), guest.email, RETAIL_PASSWORD);
    const unknownAnswer = await signIn(browser(), uniqueEmail('nobody'), RETAIL_PASSWORD);
    expect(guestAnswer.statusCode).toBe(401);
    expect(withoutRequestId(guestAnswer)).toEqual(withoutRequestId(unknownAnswer));
    expect(await allSessions()).toEqual([]);
  });
});

describe('POST /client/auth/sign-in: refusals', () => {
  it('gives one 401 to an unknown email, wrong passwords, no password yet, a guest and an erased account', async () => {
    const merchant = await makeMerchant(t);
    const retail = await makeCustomer(t, { password: RETAIL_PASSWORD });
    const noPasswordMerchant = await makeMerchant(t, { noPassword: true });
    const noPasswordRetail = await makeCustomer(t, { noPassword: true });
    const guest = await makeCustomer(t, { guest: true });
    // An erased account whose row still holds an old password: the right password is refused too.
    const anonymized = await makeCustomer(t, {
      status: 'anonymized',
      anonymizedAt: new Date('2026-11-01T00:00:00.000Z'),
      password: RETAIL_PASSWORD,
    });
    const answers = [
      await signIn(browser(), uniqueEmail('nobody'), MERCHANT_PASSWORD),
      await signIn(browser(), merchant.email, 'not-the-password'),
      await signIn(browser(), retail.email, 'not-the-password'),
      await signIn(browser(), noPasswordMerchant.email, MERCHANT_PASSWORD),
      await signIn(browser(), noPasswordRetail.email, RETAIL_PASSWORD),
      await signIn(browser(), guest.email, RETAIL_PASSWORD),
      await signIn(browser(), anonymized.email, RETAIL_PASSWORD),
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

  it('says ACCOUNT_SUSPENDED only after a correct password: a suspended merchant, a suspended and a blocked retail account', async () => {
    const merchant = await makeMerchant(t, { status: 'suspended' });
    const suspended = await makeCustomer(t, { status: 'suspended', password: RETAIL_PASSWORD });
    const blocked = await makeCustomer(t, { status: 'blocked', password: RETAIL_PASSWORD });
    for (const [email, password] of [
      [merchant.email, MERCHANT_PASSWORD],
      [suspended.email, RETAIL_PASSWORD],
      [blocked.email, RETAIL_PASSWORD],
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
    for (const { kind, email } of await threeKinds()) {
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
    const kinds = await threeKinds();
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
    const kinds = await threeKinds();
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

describe('POST /client/auth/sign-in: one budget with the two other sign-in routes', () => {
  it('after five failures the merchant login and the shop login answer 429 for that email and address', async () => {
    const email = uniqueEmail('retail');
    await makeCustomer(t, { email, password: RETAIL_PASSWORD });
    const ip = freshClientIp();
    for (let i = 0; i < 5; i++) expect((await signIn(browser(ip), email, 'wrong-password')).statusCode).toBe(401);
    expect((await browser(ip).login(email)).statusCode).toBe(429);
    const store = await browser(ip).call(
      'POST',
      '/store/v1/auth/login',
      { email, password: RETAIL_PASSWORD },
      { csrf: false, headers: TURNSTILE },
    );
    expect(store.statusCode).toBe(429);
    // Another address still has its own budget on the shop route.
    const other = await browser().call(
      'POST',
      '/store/v1/auth/login',
      { email, password: RETAIL_PASSWORD },
      { csrf: false, headers: TURNSTILE },
    );
    expect(other.statusCode).toBe(200);
  });
});

describe('POST /client/auth/sign-in: stale sessions', () => {
  it('ends the earlier session of the browser, whatever its rank: there is one session cookie', async () => {
    const merchant = await makeMerchant(t);
    const retail = await makeCustomer(t, { password: RETAIL_PASSWORD });
    const b = browser();
    await signIn(b, retail.email, RETAIL_PASSWORD);
    const retailToken = b.cookie(SESSION_COOKIE_NAMES.account)!;
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);

    // The same browser signs in as the merchant: the one cookie now names the merchant session, and the retail one is ended.
    await signIn(b, merchant.email, MERCHANT_PASSWORD);
    expect(b.cookie(SESSION_COOKIE_NAMES.account)).not.toBe(retailToken);
    expect(await sessionsOf(retail.id)).toMatchObject([{ revokedAt: expect.any(Date) }]);
    expect(await sessionsOf(merchant.id)).toMatchObject([{ revokedAt: null }]);
    expect((await b.me()).statusCode).toBe(200);
    const stale = browser();
    stale.setSessionToken(retailToken);
    expect((await stale.call('GET', '/store/v1/me')).statusCode).toBe(401);

    // A second merchant sign-in ends the first merchant session.
    const firstMerchant = b.sessionToken!;
    await signIn(b, merchant.email, MERCHANT_PASSWORD);
    expect(b.sessionToken).not.toBe(firstMerchant);
    expect(await sessionsOf(merchant.id)).toMatchObject([{ revokedAt: expect.any(Date) }, { revokedAt: null }]);
  });
});
