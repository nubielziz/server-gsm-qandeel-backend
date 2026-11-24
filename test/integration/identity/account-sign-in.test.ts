// Integration tests of the sign-in of every account (decision 064) through HTTP on the real application: the three sign-in routes run one use
// case, so one argon2 verify, one 401, one budget and one lock cover all of them; the rank of the account picks the cookies and the answer;
// two-step sign-in and the forced password change work for a retail account as for a merchant; the session opens only for an account that
// still may act (`canAct`); and a guest row that shares an email with a login row never takes part (sign-in, forgot password and the
// lock act on the login row, whatever order the two rows were inserted in).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { PasswordHasher } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { CLIENT_TOTP_AAD, TotpService } from '@src/modules/identity/application/totp.service';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import {
  ACCOUNT_SESSION_COOKIE,
  CSRF_COOKIE_BY_KIND,
  LEGACY_STORE_SESSION_COOKIE,
  openAccountSession,
} from '../../support/account-sessions';
import { accountRow, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, MINUTE, SECOND, TestClock } from '../../support/clock';
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
import { freshClientIp, freshClientPrefix } from '../../support/pipeline-routes';
import { codeFor } from '../../support/staff-console';
import {
  CUSTOMER_PASSWORD,
  STORE_ORIGIN,
  StoreClient,
  TURNSTILE_TEST_TOKEN,
  clearStoreRateLimits,
  makeCustomer,
} from '../../support/store';

/** The app's clock: the lock, codes, temporary passwords and session lifetimes follow it (decision 031). */
const clock = new TestClock('2026-11-24T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { SHOP_ORIGINS: `${PORTAL_ORIGIN},${STORE_ORIGIN}` }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-24T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await clearStoreRateLimits(t);
  await seedPortalBasics();
  captureAccountLinks(t);
});
afterEach(() => mock.restore());

const TURNSTILE = { 'x-turnstile-token': TURNSTILE_TEST_TOKEN };
const NEW_PASSWORD = 'a-quiet-harbour-at-dawn';

/** A browser of the portal: one cookie jar, the portal's Origin, and the Turnstile token on the one sign-in form. */
const browser = (ip?: string) => new MerchantPortal(t, ip ?? freshClientIp());
/** `POST /client/auth/sign-in`, the one form of both ranks. */
const signIn = (
  b: MerchantPortal,
  email: string,
  password: string,
  options: PortalCallOptions = {},
): Promise<LightMyRequestResponse> =>
  b.call('POST', '/client/auth/sign-in', { email, password }, { csrf: false, headers: TURNSTILE, ...options });
/** `POST /store/v1/auth/login`, the alias the old shop calls. */
const storeLogin = (ip: string, email: string, password: string): Promise<LightMyRequestResponse> =>
  new StoreClient(t, ip).login(email, password);
const problem = (res: { json: () => unknown }) => res.json() as { code: string; detail?: string };
const withoutRequestId = (res: { json: () => unknown }) => {
  const { requestId: _requestId, ...rest } = res.json() as Record<string, unknown>;
  return rest;
};
const uniqueEmail = (label: string) => `${label}-${randomUUID()}@example.com`;

/** The sessions of an account, oldest first. */
const sessionsOf = async (accountId: number) => {
  const { db } = await testDb();
  return db.select().from(s.sessions).where(eq(s.sessions.subjectId, accountId)).orderBy(asc(s.sessions.id));
};
const allSessions = async () => (await testDb()).db.select().from(s.sessions);

/** The cookies an answer sets (with a value and a life) and the ones it clears (Max-Age 0). */
const cookiesSet = (res: LightMyRequestResponse) =>
  res.cookies.filter((cookie) => cookie.value !== '' && cookie.maxAge !== 0).map((cookie) => cookie.name);
const cookiesCleared = (res: LightMyRequestResponse) =>
  res.cookies.filter((cookie) => cookie.value === '' || cookie.maxAge === 0).map((cookie) => cookie.name);

/** A retail account with two-step sign-in on: the secret to type codes from. */
async function makeRetailWithTwoFactor(): Promise<{ id: number; email: string; secret: string }> {
  const totp = t.app.get(TotpService);
  const secret = totp.newSecret();
  const made = await makeAccount(t, {
    rank: 'retail',
    password: CUSTOMER_PASSWORD,
    twofaEnabled: true,
    totpSecretEnc: totp.seal(secret, CLIENT_TOTP_AAD),
    emailVerifiedAt: new Date(clock.nowMs()),
  });
  return { id: made.id, email: made.email, secret };
}

describe('POST /client/auth/sign-in: the rank of the account picks the cookies and the answer', () => {
  it('signs a merchant rank in: kind merchant, its rank, the merchant CSRF cookie, one full session of subject account', async () => {
    const merchant = await makeMerchant(t);
    const b = browser();
    const res = await signIn(b, merchant.email.toUpperCase(), MERCHANT_PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      kind: 'merchant',
      next: 'done',
      rank: { id: merchant.row.groupId, name: expect.any(String), kind: 'merchant' },
    });
    expect(cookiesSet(res).sort()).toEqual([ACCOUNT_SESSION_COOKIE, CSRF_COOKIE_BY_KIND.merchant].sort());
    expect(cookiesCleared(res)).toContain(CSRF_COOKIE_BY_KIND.retail);
    expect(cookiesCleared(res)).toContain(LEGACY_STORE_SESSION_COOKIE);
    expect(await sessionsOf(merchant.id)).toMatchObject([{ subjectType: 'account', stage: 'active', revokedAt: null }]);
    expect((await accountRow(merchant.id)).lastLoginAt?.toISOString()).toBe('2026-11-24T09:00:00.000Z');
    expect((await b.me()).statusCode).toBe(200);
  });

  it('signs a retail rank in: kind customer on the wire, rank kind retail, the retail CSRF cookie, the one session cookie', async () => {
    const customer = await makeCustomer(t);
    const b = browser();
    const res = await signIn(b, customer.email, CUSTOMER_PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      kind: 'customer',
      next: 'done',
      rank: { id: customer.row.groupId, name: expect.any(String), kind: 'retail' },
    });
    expect(cookiesSet(res).sort()).toEqual([ACCOUNT_SESSION_COOKIE, CSRF_COOKIE_BY_KIND.retail].sort());
    expect(cookiesCleared(res)).toContain(CSRF_COOKIE_BY_KIND.merchant);
    expect(await sessionsOf(customer.id)).toMatchObject([{ subjectType: 'account', stage: 'active' }]);
    expect((await accountRow(customer.id)).lastLoginAt?.toISOString()).toBe('2026-11-24T09:00:00.000Z');
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);
  });

  it('answers the two alias routes with the next step only, from the same use case', async () => {
    const merchant = await makeMerchant(t);
    const customer = await makeCustomer(t);
    expect((await browser().login(merchant.email)).json()).toEqual({ next: 'done' });
    const store = await storeLogin(freshClientIp(), customer.email, CUSTOMER_PASSWORD);
    expect(store.statusCode, store.body).toBe(200);
    expect(store.json()).toEqual({ next: 'done' });
    expect(cookiesSet(store)).toContain(CSRF_COOKIE_BY_KIND.retail);
  });

  it('ends the stale session the browser carries and starts a new one (no fixation)', async () => {
    const customer = await makeCustomer(t);
    const b = browser();
    await signIn(b, customer.email, CUSTOMER_PASSWORD);
    const first = b.sessionToken!;
    await signIn(b, customer.email, CUSTOMER_PASSWORD);
    expect(b.sessionToken).not.toBe(first);
    expect(await sessionsOf(customer.id)).toMatchObject([{ revokedAt: expect.any(Date) }, { revokedAt: null }]);
    const stale = browser();
    stale.setSessionToken(first);
    expect((await stale.call('GET', '/store/v1/me')).statusCode).toBe(401);
  });
});

describe('two-step sign-in and the forced change work for every rank', () => {
  it('asks a retail account with two-step sign-in for the code (next totp); POST /client/auth/2fa completes it', async () => {
    const customer = await makeRetailWithTwoFactor();
    const b = browser();
    const res = await signIn(b, customer.email, CUSTOMER_PASSWORD);
    expect(res.json()).toMatchObject({ kind: 'customer', next: 'totp' });
    const [pending] = await sessionsOf(customer.id);
    expect(pending).toMatchObject({ stage: 'pending_totp', revokedAt: null });
    expect((await accountRow(customer.id)).lastLoginAt).toBeNull();
    // A pending session opens nothing but the code step.
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(401);

    const done = await b.code(await codeFor(customer.secret, clock.nowMs()));
    expect(done.statusCode, done.body).toBe(204);
    // The pending session ended and a full one began (a new token), with the cookies of the retail rank.
    expect(cookiesSet(done).sort()).toEqual([ACCOUNT_SESSION_COOKIE, CSRF_COOKIE_BY_KIND.retail].sort());
    expect(await sessionsOf(customer.id)).toMatchObject([
      { stage: 'pending_totp', revokedAt: expect.any(Date) },
      { stage: 'active', revokedAt: null },
    ]);
    expect((await accountRow(customer.id)).lastLoginAt?.toISOString()).toBe('2026-11-24T09:00:00.000Z');
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);
  });

  it('answers a wrong code with 422 on code (never 401) and the same code twice is refused', async () => {
    const customer = await makeRetailWithTwoFactor();
    const b = browser();
    await signIn(b, customer.email, CUSTOMER_PASSWORD);
    const wrong = await b.code('000000');
    expect(wrong.statusCode).toBe(422);
    expect(problem(wrong).code).toBe('VALIDATION_FAILED');
    const code = await codeFor(customer.secret, clock.nowMs());
    expect((await b.code(code)).statusCode).toBe(204);
    // A second pending session cannot replay the step that was accepted.
    const again = browser();
    await signIn(again, customer.email, CUSTOMER_PASSWORD);
    expect((await again.code(code)).statusCode).toBe(422);
  });

  it('sends a retail account with a temporary password to POST /client/auth/password/change, then on to its code step', async () => {
    const customer = await makeCustomer(t, { mustChangePassword: true, passwordChangedAt: new Date(clock.nowMs()) });
    const b = browser();
    expect((await signIn(b, customer.email, CUSTOMER_PASSWORD)).json()).toMatchObject({ next: 'password' });
    expect(await sessionsOf(customer.id)).toMatchObject([{ stage: 'pending_password' }]);
    const changed = await b.changeTemporaryPassword(NEW_PASSWORD);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ next: 'done' });
    expect(cookiesSet(changed)).toContain(CSRF_COOKIE_BY_KIND.retail);
    expect(await sessionsOf(customer.id)).toMatchObject([
      { stage: 'pending_password', revokedAt: expect.any(Date) },
      { stage: 'active', revokedAt: null },
    ]);
    expect((await accountRow(customer.id)).mustChangePassword).toBe(false);
    expect((await b.call('GET', '/store/v1/me')).statusCode).toBe(200);
    // The new password signs in at once.
    expect((await signIn(browser(), customer.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('keeps the account at the code step after a forced change when two-step sign-in is on', async () => {
    const merchant = await makeMerchant(t, { twofa: true, mustChangePassword: true });
    const b = browser();
    expect((await signIn(b, merchant.email, MERCHANT_PASSWORD)).json()).toMatchObject({ next: 'password' });
    expect((await b.changeTemporaryPassword(NEW_PASSWORD)).json()).toEqual({ next: 'totp' });
    expect(await sessionsOf(merchant.id)).toMatchObject([
      { stage: 'pending_password', revokedAt: expect.any(Date) },
      { stage: 'pending_totp', revokedAt: null },
    ]);
    expect((await b.code(await codeFor(merchant.secret, clock.nowMs()))).statusCode).toBe(204);
  });
});

describe('refusals', () => {
  it('gives one 401 to an unknown email, wrong passwords, no password yet, a guest and an erased account', async () => {
    const merchant = await makeMerchant(t);
    const customer = await makeCustomer(t);
    const noPassword = await makeCustomer(t, { noPassword: true });
    const guest = await makeCustomer(t, { guest: true });
    // An erased account whose row still holds its old hash: the right password is refused too.
    const erased = await makeCustomer(t, { status: 'anonymized', anonymizedAt: new Date() });
    const answers = [
      await signIn(browser(), uniqueEmail('nobody'), MERCHANT_PASSWORD),
      await signIn(browser(), merchant.email, 'not-the-password'),
      await signIn(browser(), customer.email, 'not-the-password'),
      await signIn(browser(), noPassword.email, CUSTOMER_PASSWORD),
      await signIn(browser(), guest.email, CUSTOMER_PASSWORD),
      await signIn(browser(), erased.email, CUSTOMER_PASSWORD),
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

  it('says ACCOUNT_SUSPENDED only after a correct password: suspended and blocked accounts of both ranks', async () => {
    const accounts = [
      await makeMerchant(t, { status: 'suspended' }),
      await makeMerchant(t, { status: 'blocked' }),
      await makeCustomer(t, { status: 'suspended' }),
      await makeCustomer(t, { status: 'blocked' }),
    ];
    for (const account of accounts) {
      const right = await signIn(browser(), account.email, MERCHANT_PASSWORD);
      expect(right.statusCode, account.email).toBe(403);
      expect(problem(right).code).toBe('ACCOUNT_SUSPENDED');
      expect(right.cookies).toEqual([]);
      expect((await signIn(browser(), account.email, 'not-the-password')).statusCode).toBe(401);
    }
    expect(await allSessions()).toEqual([]);
  });

  it('refuses a temporary password after 72 hours like a wrong one, and accepts it before', async () => {
    const setAt = clock.nowMs();
    const kept = await makeCustomer(t, { mustChangePassword: true, passwordChangedAt: new Date(setAt) });
    const lapsed = await makeMerchant(t, { mustChangePassword: true, passwordChangedAt: new Date(setAt) });
    clock.set(setAt + 71 * HOUR);
    expect((await signIn(browser(), kept.email, CUSTOMER_PASSWORD)).json()).toMatchObject({ next: 'password' });
    clock.set(setAt + 72 * HOUR);
    for (const email of [kept.email, lapsed.email]) {
      const res = await signIn(browser(), email, email === kept.email ? CUSTOMER_PASSWORD : MERCHANT_PASSWORD);
      expect(res.statusCode, email).toBe(401);
      expect(res.cookies).toEqual([]);
    }
  });

  it('opens no session when the account is blocked between the password check and the session (canAct under the row lock)', async () => {
    const customer = await makeCustomer(t);
    const hasher = t.app.get(PasswordHasher);
    const real = hasher.verify.bind(hasher);
    // The block commits after the password was proven and before the session opens.
    spyOn(hasher, 'verify').mockImplementation(async (hash, password) => {
      const proven = await real(hash, password);
      const { db } = await testDb();
      await db.update(s.clients).set({ status: 'blocked' }).where(eq(s.clients.id, customer.id));
      return proven;
    });
    const res = await signIn(browser(), customer.email, CUSTOMER_PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toEqual([]);
    expect(await sessionsOf(customer.id)).toEqual([]);
  });
});

describe('one password verify per attempt, and none on a 429', () => {
  /** The kinds of email the work must be the same for: unknown, a guest, a retail account, a merchant rank. */
  async function kinds() {
    const guest = await makeCustomer(t, { guest: true });
    const customer = await makeCustomer(t);
    const merchant = await makeMerchant(t);
    return [
      { kind: 'unknown', email: uniqueEmail('nobody'), password: undefined },
      { kind: 'guest', email: guest.email, password: undefined },
      { kind: 'retail', email: customer.email, password: CUSTOMER_PASSWORD },
      { kind: 'merchant', email: merchant.email, password: MERCHANT_PASSWORD },
    ];
  }

  it('runs exactly one verify for each kind of email, on a wrong and on a right password', async () => {
    const all = await kinds();
    const verify = spyOn(t.app.get(PasswordHasher), 'verify');
    for (const { kind, email, password } of all) {
      verify.mockClear();
      expect((await signIn(browser(), email, 'wrong-password')).statusCode, kind).toBe(401);
      expect(verify, kind).toHaveBeenCalledTimes(1);
      if (password === undefined) continue;
      verify.mockClear();
      expect((await signIn(browser(), email, password)).statusCode, kind).toBe(200);
      expect(verify, kind).toHaveBeenCalledTimes(1);
    }
  });

  it('answers 429 on the sixth attempt of an address for each kind, with no verify', async () => {
    const all = await kinds();
    const verify = spyOn(t.app.get(PasswordHasher), 'verify');
    for (const { kind, email } of all) {
      const ip = freshClientIp();
      for (let i = 0; i < 5; i++)
        expect((await signIn(browser(ip), email, 'wrong-password')).statusCode, kind).toBe(401);
      verify.mockClear();
      const limited = await signIn(browser(ip), email, 'wrong-password');
      expect(limited.statusCode, kind).toBe(429);
      expect(problem(limited).code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(verify, kind).not.toHaveBeenCalled();
    }
  });
});

describe('the three sign-in routes share one budget and one lock', () => {
  it('spends one budget of five per email and network over the three routes', async () => {
    const customer = await makeCustomer(t);
    const ip = freshClientIp();
    for (let i = 0; i < 3; i++)
      expect((await signIn(browser(ip), customer.email, 'wrong-password')).statusCode).toBe(401);
    expect((await browser(ip).login(customer.email, 'wrong-password')).statusCode).toBe(401);
    expect((await storeLogin(ip, customer.email, 'wrong-password')).statusCode).toBe(401);
    // The sixth attempt is refused on every route, with the right password too.
    expect((await signIn(browser(ip), customer.email, CUSTOMER_PASSWORD)).statusCode).toBe(429);
    expect((await browser(ip).login(customer.email, CUSTOMER_PASSWORD)).statusCode).toBe(429);
    expect((await storeLogin(ip, customer.email, CUSTOMER_PASSWORD)).statusCode).toBe(429);
    // Another network has a budget of its own.
    expect((await signIn(browser(), customer.email, CUSTOMER_PASSWORD)).statusCode).toBe(200);
  });

  it('locks the email for 15 minutes after ten failures over the three routes from rotating addresses; the lock ends with the clock', async () => {
    const customer = await makeCustomer(t);
    for (let i = 0; i < 4; i++)
      expect((await signIn(browser(), customer.email, 'wrong-password')).statusCode).toBe(401);
    for (let i = 0; i < 3; i++) expect((await browser().login(customer.email, 'wrong-password')).statusCode).toBe(401);
    for (let i = 0; i < 3; i++)
      expect((await storeLogin(freshClientIp(), customer.email, 'wrong-password')).statusCode).toBe(401);
    for (const locked of [
      await signIn(browser(), customer.email, CUSTOMER_PASSWORD),
      await browser().login(customer.email, CUSTOMER_PASSWORD),
      await storeLogin(freshClientIp(), customer.email, CUSTOMER_PASSWORD),
    ]) {
      expect(locked.statusCode).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBe(15 * 60);
    }
    clock.advance(15 * MINUTE + SECOND);
    expect((await signIn(browser(), customer.email, CUSTOMER_PASSWORD)).statusCode).toBe(200);
  });
});

describe('a login row and a guest row that share one email', () => {
  /** Makes the login row and the guest row of one email, in the order given (the answer must not depend on it). */
  async function pair(order: 'login first' | 'guest first') {
    const email = uniqueEmail('shared');
    const make = (guest: boolean) =>
      guest
        ? makeAccount(t, { rank: 'retail', guest: true, email })
        : makeAccount(t, { rank: 'retail', email, password: CUSTOMER_PASSWORD });
    const [first, second] = order === 'login first' ? [false, true] : [true, false];
    const one = await make(first);
    const two = await make(second);
    const [login, guest] = first ? [two, one] : [one, two];
    return { email, login, guest };
  }

  for (const order of ['login first', 'guest first'] as const) {
    it(`signs the login row in and answers forgot for it (${order})`, async () => {
      const { email, login, guest } = await pair(order);
      const b = browser();
      expect((await signIn(b, email, CUSTOMER_PASSWORD)).statusCode).toBe(200);
      expect(await sessionsOf(login.id)).toHaveLength(1);
      expect(await sessionsOf(guest.id)).toEqual([]);

      expect((await new StoreClient(t, freshClientIp()).forgot(email)).statusCode).toBe(204);
      const links = accountLinks().filter((link) => link.kind === 'password_reset');
      expect(links.map((link) => link.accountId)).toEqual([login.id]);
    });

    it(`counts the lock on the email and lets the networks of the login row's sessions through (${order})`, async () => {
      const { email, login } = await pair(order);
      const ownIp = freshClientIp();
      expect((await signIn(browser(ownIp), email, CUSTOMER_PASSWORD)).statusCode).toBe(200);
      // Ten wrong attempts from networks of their own (an IPv6 /64 each) lock the email.
      for (let i = 0; i < 10; i++) await signIn(browser(`${freshClientPrefix()}::1`), email, 'wrong-password');
      const stranger = await signIn(browser(`${freshClientPrefix()}::1`), email, CUSTOMER_PASSWORD);
      expect(stranger.statusCode).toBe(429);
      // The network of the login row's own full session still gets through: the lock named the login row, not the guest row.
      const own = await signIn(browser(ownIp), email, CUSTOMER_PASSWORD);
      expect(own.statusCode, own.body).toBe(200);
      expect(await sessionsOf(login.id)).toHaveLength(2);
    });
  }

  it('does not sign a guest row in: an email that only a guest row holds is one 401', async () => {
    const guest = await makeCustomer(t, { guest: true });
    const res = await signIn(browser(), guest.email, CUSTOMER_PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(await allSessions()).toEqual([]);
  });
});

describe('POST /client/auth/logout', () => {
  it('ends the session and clears the session cookie, both CSRF cookies and the old shop cookie', async () => {
    const customer = await makeCustomer(t);
    const b = browser();
    await signIn(b, customer.email, CUSTOMER_PASSWORD);
    const out = await b.logout();
    expect(out.statusCode, out.body).toBe(204);
    expect(cookiesCleared(out)).toEqual(
      expect.arrayContaining([
        ACCOUNT_SESSION_COOKIE,
        CSRF_COOKIE_BY_KIND.merchant,
        CSRF_COOKIE_BY_KIND.retail,
        LEGACY_STORE_SESSION_COOKIE,
      ]),
    );
    expect(cookiesSet(out)).toEqual([]);
    expect(await sessionsOf(customer.id)).toMatchObject([{ revokedAt: expect.any(Date) }]);
  });

  it('ends only the session that signs out, and the other sessions of the account stay', async () => {
    const merchant = await makeMerchant(t);
    const one = browser();
    const two = browser();
    await signIn(one, merchant.email, MERCHANT_PASSWORD);
    await signIn(two, merchant.email, MERCHANT_PASSWORD);
    expect((await one.logout()).statusCode).toBe(204);
    expect(await sessionsOf(merchant.id)).toMatchObject([{ revokedAt: expect.any(Date) }, { revokedAt: null }]);
    expect((await two.me()).statusCode).toBe(200);
  });
});

describe('passwords of a retail account', () => {
  it('sets a first password from a reset link, ends the account sessions, and signs in with it', async () => {
    const customer = await makeCustomer(t, { noPassword: true });
    expect((await new StoreClient(t, freshClientIp()).forgot(customer.email)).statusCode).toBe(204);
    const [link] = accountLinks().filter((entry) => entry.accountId === customer.id);
    expect(link?.kind).toBe('password_reset');
    const set = await new StoreClient(t, freshClientIp()).setPassword(link!.token, NEW_PASSWORD, { csrf: false });
    expect(set.statusCode, set.body).toBe(204);
    // The link is used up.
    expect(
      (await new StoreClient(t, freshClientIp()).setPassword(link!.token, NEW_PASSWORD, { csrf: false })).statusCode,
    ).toBe(410);
    expect((await signIn(browser(), customer.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('answers 410 for the link of a blocked account and keeps the old password', async () => {
    const customer = await makeCustomer(t);
    expect((await new StoreClient(t, freshClientIp()).forgot(customer.email)).statusCode).toBe(204);
    const [link] = accountLinks().filter((entry) => entry.accountId === customer.id);
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'blocked' }).where(eq(s.clients.id, customer.id));
    const set = await new StoreClient(t, freshClientIp()).setPassword(link!.token, NEW_PASSWORD, { csrf: false });
    expect(set.statusCode).toBe(410);
    expect(problem(set).code).toBe('TOKEN_INVALID');
    expect((await accountRow(customer.id)).passwordHash).toBe(customer.row.passwordHash);
  });

  it('changes the own password with the current one, keeps the session in use and ends the others; no password is a 409', async () => {
    const customer = await makeCustomer(t);
    const here = new StoreClient(t, freshClientIp());
    const there = new StoreClient(t, freshClientIp());
    await here.login(customer.email);
    await there.login(customer.email);
    const wrong = await here.changePassword('not-the-password', NEW_PASSWORD);
    expect(wrong.statusCode).toBe(422);
    expect(problem(wrong).code).toBe('VALIDATION_FAILED');
    expect((await here.changePassword(CUSTOMER_PASSWORD, NEW_PASSWORD)).statusCode).toBe(204);
    expect((await here.me()).statusCode).toBe(200);
    expect((await there.me()).statusCode).toBe(401);

    const linkOnly = await makeCustomer(t, { noPassword: true });
    const session = new StoreClient(t, freshClientIp());
    // An account that signs in by link has a session without a password: choosing one needs the mailed link.
    const opened = await openAccountSession(t, linkOnly.id);
    session.setSessionToken(opened.token);
    session.csrf = opened.csrf;
    const none = await session.changePassword('anything-at-all', NEW_PASSWORD);
    expect(none.statusCode).toBe(409);
    expect(problem(none).code).toBe('CONFLICT');
  });
});
