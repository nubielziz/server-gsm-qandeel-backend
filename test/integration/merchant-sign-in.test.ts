// Integration tests of the merchant portal's sign-in (feature 2b, routes POST /client/auth/login, /2fa, /logout, GET
// /client/auth/me, PATCH /client/profile; MISMATCHES B124 to B126, B129, B130, B153) through HTTP on the real application:
// the flow the portal runs, every refusal the contracts list, and the rule for merchants waiting for approval both ways.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { TokenService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { CSRF_COOKIE_NAMES, SESSION_COOKIE_NAMES, SessionService, csrfTokenFor } from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, SECOND, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { logSink } from '../support/log-sink';
import {
  MERCHANT_PASSWORD,
  MerchantPortal,
  PORTAL_ORIGIN,
  clearPortalRateLimits,
  clientRow,
  makeMerchant,
  seedPortalBasics,
} from '../support/merchant-portal';
import { freshClientIp } from '../support/pipeline-routes';
import { SecurityTestController } from '../support/security-routes';
import { codeFor } from '../support/staff-console';

/** The app's clock: authenticator codes and session lifetimes follow it (decision 031). */
const clock = new TestClock();
let t: TestApp;
let defaultGroupId: number;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN }, clock, controllers: [SecurityTestController] });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  logSink.clear();
  defaultGroupId = await seedPortalBasics();
});

const portal = (ip?: string) => new MerchantPortal(t, ip ?? freshClientIp());
const problem = (res: { json: () => unknown }) => res.json() as { code: string; errors?: Array<{ field: string }> };
/** The code an authenticator app shows `steps` time steps (30 s) from the app's now. */
const codeNow = (secret: string, steps = 0): Promise<string> => codeFor(secret, clock.nowMs() + steps * 30 * SECOND);
const sessionsOf = async (clientId: number) => {
  const { db } = await testDb();
  return db.select().from(s.sessions).where(eq(s.sessions.subjectId, clientId)).orderBy(asc(s.sessions.id));
};

describe('POST /client/auth/login', () => {
  it('signs a merchant without 2FA in at once: cookies, CSRF token and a full session', async () => {
    const merchant = await makeMerchant(t);
    const p = portal();
    const res = await p.login(merchant.email.toUpperCase());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: 'done' });
    expect(res.headers['cache-control']).toBe('no-store');

    const sessionCookie = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.client)!;
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(sessionCookie.maxAge).toBeGreaterThan(29 * 24 * 3600);
    const csrfCookie = res.cookies.find((cookie) => cookie.name === CSRF_COOKIE_NAMES.client)!;
    expect(csrfCookie.httpOnly).toBeFalsy();
    const expectedCsrf = csrfTokenFor(t.config.security.csrfSecret, t.app.get(TokenService).hash(p.sessionToken!));
    expect(csrfCookie.value).toBe(expectedCsrf);
    expect(res.headers['x-csrf-token']).toBe(expectedCsrf);

    expect(await sessionsOf(merchant.id)).toMatchObject([
      { subjectType: 'client', stage: 'active', ip: expect.any(String) },
    ]);
    expect((await p.me()).statusCode).toBe(200);
  });

  it('lets a merchant waiting for approval sign in, and its status says so (B153)', async () => {
    const merchant = await makeMerchant(t, { status: 'pending' });
    const p = portal();
    expect((await p.login(merchant.email)).json()).toEqual({ next: 'done' });
    const me = await p.me();
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: merchant.id, status: 'pending', kycStatus: 'none' });
  });

  it('gives an unknown email, a wrong password and a merchant with no password yet the same 401', async () => {
    const known = await makeMerchant(t);
    const noPassword = await makeMerchant(t, { noPassword: true, status: 'pending' });
    const answers = [
      await portal().login('nobody@example.com'),
      await portal().login(known.email, 'not-the-password'),
      await portal().login(noPassword.email),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(401);
      expect(res.cookies).toEqual([]);
    }
    const bodies = answers.map((res) => {
      const { requestId: _requestId, ...rest } = res.json<Record<string, unknown>>();
      return rest;
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('says ACCOUNT_SUSPENDED only after a correct password', async () => {
    const merchant = await makeMerchant(t, { status: 'suspended' });
    const right = await portal().login(merchant.email);
    expect(right.statusCode).toBe(403);
    expect(problem(right).code).toBe('ACCOUNT_SUSPENDED');
    expect(right.cookies).toEqual([]);
    const wrong = await portal().login(merchant.email, 'not-the-password');
    expect(wrong.statusCode).toBe(401);
    expect(await sessionsOf(merchant.id)).toHaveLength(0);
  });

  it('counts attempts per email and address: the sixth is 429 with Retry-After, and a success clears the count', async () => {
    const merchant = await makeMerchant(t);
    const ip = freshClientIp();
    for (let i = 0; i < 4; i++) expect((await portal(ip).login(merchant.email, 'wrong-password')).statusCode).toBe(401);
    expect((await portal(ip).login(merchant.email)).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await portal(ip).login(merchant.email, 'wrong-password')).statusCode).toBe(401);
    const locked = await portal(ip).login(merchant.email);
    expect(locked.statusCode).toBe(429);
    expect(problem(locked).code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another address is not locked out.
    expect((await portal().login(merchant.email)).statusCode).toBe(200);
  });

  it('ends the session the request already carried, so a sign-in never continues an old session', async () => {
    const merchant = await makeMerchant(t);
    const p = portal();
    await p.login(merchant.email);
    const old = p.sessionToken!;
    await p.login(merchant.email);
    expect(p.sessionToken).not.toBe(old);
    const stale = portal();
    stale.setSessionToken(old);
    expect((await stale.me()).statusCode).toBe(401);
  });

  it('refuses a body that is wrong (422) and a request that does not come from the portal (403 CSRF_FAILED)', async () => {
    const empty = await portal().call('POST', '/client/auth/login', {});
    expect(empty.statusCode).toBe(422);
    expect(
      problem(empty)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['email', 'password']);
    const merchant = await makeMerchant(t);
    const noOrigin = await portal().login(merchant.email, MERCHANT_PASSWORD, { origin: false });
    expect(noOrigin.statusCode).toBe(403);
    expect(problem(noOrigin).code).toBe('CSRF_FAILED');
  });

  it('keeps the merchant sessions in the merchant cookie: a staff cookie opens nothing', async () => {
    const merchant = await makeMerchant(t);
    const p = portal();
    await p.login(merchant.email);
    const res = await t.app.inject({
      method: 'GET',
      url: '/client/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAMES.staff}=${p.sessionToken!}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('the authenticator step', () => {
  it('login → code → me → the rotation the portal expects, and the pending session cannot do anything else', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const p = portal();
    const login = await p.login(merchant.email);
    expect(login.json()).toEqual({ next: 'totp' });
    const pendingToken = p.sessionToken!;
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE_NAMES.client)!;
    expect(cookie.maxAge).toBeLessThanOrEqual(600);
    expect(await sessionsOf(merchant.id)).toMatchObject([{ stage: 'pending_totp' }]);

    // Nothing but the code step and logout works on a pending session.
    for (const res of [await p.me(), await p.profile({ name: 'X' }), await p.sessions(), await p.setupTwoFactor()]) {
      expect(res.statusCode).toBe(401);
    }

    const done = await p.code(await codeNow(merchant.secret));
    expect(done.statusCode).toBe(204);
    expect(done.body).toBe('');
    expect(p.sessionToken).not.toBe(pendingToken);
    expect(done.headers['x-csrf-token']).toBe(
      csrfTokenFor(t.config.security.csrfSecret, t.app.get(TokenService).hash(p.sessionToken!)),
    );
    const fullCookie = done.cookies.find((c) => c.name === SESSION_COOKIE_NAMES.client)!;
    expect(fullCookie.maxAge).toBeGreaterThan(29 * 24 * 3600);

    // The pending token died with the rotation (no fixation).
    const stale = portal();
    stale.setSessionToken(pendingToken);
    expect((await stale.me()).statusCode).toBe(401);
    expect((await p.me()).statusCode).toBe(200);
    // A full session is not a code step.
    expect((await p.code(await codeNow(merchant.secret, 1))).statusCode).toBe(401);
  });

  it('refuses a wrong code and a code in the wrong shape with 422 on code, never 401', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const p = portal();
    await p.login(merchant.email);
    for (const code of ['000000', await codeNow(merchant.secret, 5)]) {
      const res = await p.code(code);
      expect(res.statusCode).toBe(422);
      expect(problem(res).code).toBe('VALIDATION_FAILED');
      expect(problem(res).errors?.map((e) => e.field)).toEqual(['code']);
    }
    const shape = await p.code('12345');
    expect(shape.statusCode).toBe(422);
    expect(problem(shape).errors?.map((e) => e.field)).toEqual(['code']);
    // The session is still the pending step.
    expect((await p.code(await codeNow(merchant.secret))).statusCode).toBe(204);
  });

  it('accepts a time step once: the same code cannot sign in twice, the next step can', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const first = portal();
    await first.login(merchant.email);
    const code = await codeNow(merchant.secret);
    expect((await first.code(code)).statusCode).toBe(204);

    const second = portal();
    await second.login(merchant.email);
    const replay = await second.code(code);
    expect(replay.statusCode).toBe(422);
    expect(problem(replay).errors?.map((e) => e.field)).toEqual(['code']);
    expect((await clientRow(merchant.id)).totpLastStep).toBe(Math.floor(clock.nowMs() / 1000 / 30));
    clock.advance(30 * SECOND);
    expect((await second.code(await codeNow(merchant.secret))).statusCode).toBe(204);
  });

  it('lets only one of two parallel requests use a code', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const a = portal();
    const b = portal();
    await a.login(merchant.email);
    await b.login(merchant.email);
    const code = await codeNow(merchant.secret);
    const results = await Promise.all([a.code(code), b.code(code)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 422]);
  });

  it('counts code attempts per account, not per session: a new login gives no fresh guesses', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const ip = freshClientIp();
    for (let round = 0; round < 3; round++) {
      const p = portal(ip);
      await p.login(merchant.email);
      expect((await p.code('000000')).statusCode).toBe(422);
      if (round < 2) expect((await p.code('000001')).statusCode).toBe(422);
    }
    // Five wrong codes over three sessions: the sixth try is refused even though this code is the right one.
    const p = portal(ip);
    await p.login(merchant.email);
    const locked = await p.code(await codeNow(merchant.secret));
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('answers 401 when 2FA was turned off meanwhile, and 403 (ending every session) when the merchant was suspended', async () => {
    const off = await makeMerchant(t, { twofa: true });
    const a = portal();
    await a.login(off.email);
    const { db } = await testDb();
    await db.update(s.clients).set({ twofaEnabled: false }).where(eq(s.clients.id, off.id));
    expect((await a.code(await codeNow(off.secret))).statusCode).toBe(401);

    const frozen = await makeMerchant(t, { twofa: true });
    const b = portal();
    await b.login(frozen.email);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, frozen.id));
    const res = await b.code(await codeNow(frozen.secret));
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('ACCOUNT_SUSPENDED');
    expect((await sessionsOf(frozen.id)).every((session) => session.revokedAt !== null)).toBe(true);
  });

  it('keeps a merchant that waits for approval on the code step like any other (B153)', async () => {
    const merchant = await makeMerchant(t, { twofa: true, status: 'pending' });
    const p = portal();
    expect((await p.login(merchant.email)).json()).toEqual({ next: 'totp' });
    expect((await p.code(await codeNow(merchant.secret))).statusCode).toBe(204);
    expect((await p.me()).json()).toMatchObject({ status: 'pending', twofaEnabled: true });
  });

  it('needs the CSRF token of the pending session', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const p = portal();
    await p.login(merchant.email);
    const res = await p.code(await codeNow(merchant.secret), { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('CSRF_FAILED');
    expect((await p.code(await codeNow(merchant.secret))).statusCode).toBe(204);
  });
});

describe('POST /client/auth/logout', () => {
  it('ends the session, clears both cookies and answers 204', async () => {
    const merchant = await makeMerchant(t);
    const p = portal();
    await p.login(merchant.email);
    const token = p.sessionToken!;
    const res = await p.logout();
    expect(res.statusCode).toBe(204);
    expect(res.cookies.map((cookie) => [cookie.name, cookie.maxAge]).sort()).toEqual(
      [
        [CSRF_COOKIE_NAMES.client, 0],
        [SESSION_COOKIE_NAMES.client, 0],
      ].sort(),
    );
    const again = portal();
    again.setSessionToken(token);
    expect((await again.me()).statusCode).toBe(401);
    expect((await sessionsOf(merchant.id))[0]!.revokedAt).not.toBeNull();
  });

  it('works on a pending code step, refuses a missing CSRF token (the session stays) and a missing session (401)', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const p = portal();
    await p.login(merchant.email);
    const noToken = await p.logout({ csrf: false });
    expect(noToken.statusCode).toBe(403);
    expect(problem(noToken).code).toBe('CSRF_FAILED');
    expect((await sessionsOf(merchant.id))[0]!.revokedAt).toBeNull();
    expect((await p.logout()).statusCode).toBe(204);
    expect((await portal().logout({ cookies: false })).statusCode).toBe(401);
  });
});

describe('GET /client/auth/me', () => {
  it('describes the merchant, its group and its status, never a secret, and repeats the CSRF token', async () => {
    const merchant = await makeMerchant(t, {
      status: 'pending',
      company: 'Hassan Mobile',
      phone: '+962791234567',
      country: 'JO',
      emailVerifiedAt: new Date('2026-10-30T08:00:00.000Z'),
      kycStatus: 'pending',
    });
    const p = portal();
    await p.login(merchant.email);
    const res = await p.me();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-csrf-token']).toBe(p.csrf);
    expect(res.json()).toEqual({
      id: merchant.id,
      username: merchant.row.username,
      email: merchant.email,
      name: 'Test Merchant',
      company: 'Hassan Mobile',
      phone: '+962791234567',
      country: 'JO',
      status: 'pending',
      kycStatus: 'pending',
      emailVerifiedAt: '2026-10-30T08:00:00.000Z',
      twofaEnabled: false,
      referralCode: merchant.row.referralCode,
      group: { id: defaultGroupId, name: 'Standard', discountPercent: '5.0000' },
      createdAt: merchant.row.createdAt.toISOString(),
    });
    expect(JSON.stringify(res.json())).not.toMatch(/passwordHash|totp|argon2/i);
  });

  it('is 401 without a session and shows an approval at once', async () => {
    expect((await portal().me({ cookies: false })).statusCode).toBe(401);
    const merchant = await makeMerchant(t, { status: 'pending' });
    const p = portal();
    await p.login(merchant.email);
    expect((await p.me()).json()).toMatchObject({ status: 'pending' });
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'active' }).where(eq(s.clients.id, merchant.id));
    expect((await p.me()).json()).toMatchObject({ status: 'active' });
  });

  it('ends the sessions of a suspended merchant: 403 ACCOUNT_SUSPENDED, then 401', async () => {
    const merchant = await makeMerchant(t);
    const p = portal();
    await p.login(merchant.email);
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, merchant.id));
    await t.app.get(SessionService).invalidateSubject('client', merchant.id);
    const res = await p.me();
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('ACCOUNT_SUSPENDED');
    expect((await p.me()).statusCode).toBe(401);
  });

  it('ends a session that was not used for the idle time of merchants (7 days)', async () => {
    const merchant = await makeMerchant(t);
    const p = portal();
    await p.login(merchant.email);
    clock.advance(6 * DAY);
    expect((await p.me()).statusCode).toBe(200);
    clock.advance(8 * DAY);
    expect((await p.me()).statusCode).toBe(401);
  });
});

describe('PATCH /client/profile', () => {
  it('changes the fields it is given and leaves the others, and answers the merchant', async () => {
    const merchant = await makeMerchant(t, { company: 'Old Co', phone: '123', country: 'JO' });
    const p = portal();
    await p.login(merchant.email);
    const res = await p.profile({ name: '  New Name ', country: 'ae' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: merchant.id,
      name: 'New Name',
      company: 'Old Co',
      phone: '123',
      country: 'AE',
    });
    expect(await clientRow(merchant.id)).toMatchObject({ name: 'New Name', company: 'Old Co', country: 'AE' });
    // Empty strings are allowed for company and phone; an empty body changes nothing.
    expect((await p.profile({ company: '', phone: '' })).json()).toMatchObject({ company: '', phone: '' });
    expect((await p.profile({})).statusCode).toBe(200);
  });

  it('never changes the email, username, group or status, even when they are sent', async () => {
    const merchant = await makeMerchant(t);
    const p = portal();
    await p.login(merchant.email);
    const res = await p.profile({
      email: 'hacker@example.com',
      username: 'root',
      status: 'suspended',
      groupId: 99,
      name: 'Ok',
    });
    expect(res.statusCode).toBe(200);
    expect(await clientRow(merchant.id)).toMatchObject({
      email: merchant.email,
      username: merchant.row.username,
      status: 'active',
      groupId: merchant.row.groupId,
      name: 'Ok',
    });
  });

  it('answers 422 on the key of a wrong value, 403 without the CSRF token and 401 without a session', async () => {
    const merchant = await makeMerchant(t);
    const p = portal();
    await p.login(merchant.email);
    const bad = await p.profile({ name: '', country: 'JOR', phone: 'x'.repeat(41) });
    expect(bad.statusCode).toBe(422);
    expect(
      problem(bad)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['country', 'name', 'phone']);
    expect(problem(await p.profile({ name: 'X' }, { csrf: false })).code).toBe('CSRF_FAILED');
    expect((await portal().profile({ name: 'X' }, { cookies: false })).statusCode).toBe(401);
  });
});

describe('a merchant waiting for approval (user decision B153)', () => {
  it('reaches its own account routes and no others, and a refusal never signs it out', async () => {
    const merchant = await makeMerchant(t, { status: 'pending' });
    const p = portal();
    await p.login(merchant.email);

    // Every route of this feature that is open to it.
    const open = [
      await p.me(),
      await p.profile({ company: 'Co' }),
      await p.sessions(),
      await p.setupTwoFactor(),
      await p.enableTwoFactor('000000'),
      await p.disableTwoFactor('000000'),
      await p.changePassword('wrong-current-password', 'a-long-new-password'),
      await p.endSession(999_999),
    ];
    expect(open.map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 422, 409, 422, 404]);
    expect(open.some((res) => res.statusCode === 403)).toBe(false);

    // A route that does not opt in (the sample merchant routes of the security tests, default deny) is refused.
    const read = await p.call('GET', '/client/t/sec/session');
    expect(read.statusCode).toBe(403);
    expect(problem(read).code).toBe('ACCOUNT_PENDING_APPROVAL');
    const write = await p.call('POST', '/client/t/sec/write');
    expect(write.statusCode).toBe(403);
    expect(problem(write).code).toBe('ACCOUNT_PENDING_APPROVAL');

    // It stays signed in.
    expect((await p.me()).statusCode).toBe(200);
  });

  it('opens those routes once staff approve the merchant and the cached views are dropped', async () => {
    const merchant = await makeMerchant(t, { status: 'pending' });
    const p = portal();
    await p.login(merchant.email);
    expect((await p.call('GET', '/client/t/sec/session')).statusCode).toBe(403);
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'active' }).where(eq(s.clients.id, merchant.id));
    await t.app.get(SessionService).invalidateSubject('client', merchant.id);
    expect((await p.call('GET', '/client/t/sec/session')).statusCode).toBe(200);
    expect((await p.call('POST', '/client/t/sec/write')).statusCode).toBe(200);
  });

  it('is not asked of an approved merchant at all', async () => {
    const merchant = await makeMerchant(t, { status: 'active' });
    const p = portal();
    await p.login(merchant.email);
    expect((await p.call('GET', '/client/t/sec/session')).statusCode).toBe(200);
  });
});
