// Integration tests of the failed-lookup budget of session cookies (decision 053) through real HTTP: a cookie that names no live session costs one
// point per client address and audience on the `ip` limiter; once the 300 a minute are used up the address is answered 429 without a database
// lookup, except for a session whose live view is in the cache: a session in use keeps its view fresh and stays answered.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { CacheKeys, cacheMacKey, openEntry } from '@src/infra/cache';
import { TokenService } from '@src/infra/crypto';
import { DbService } from '@src/infra/db';
import { RateLimitService } from '@src/infra/rate-limit';
import { RedisService } from '@src/infra/redis';
import { SESSION_COOKIE_NAMES, SessionService } from '@src/modules/identity';
import { sessionFailureKey } from '@src/modules/identity/security/session-authenticator';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, clearRateLimits, signInStaff } from '../../support/auth';
import { SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { MerchantPortal, PORTAL_ORIGIN, makeMerchant, seedPortalBasics } from '../../support/merchant-portal';
import { freshClientIp, freshClientPrefix } from '../../support/pipeline-routes';
import { SecurityTestController } from '../../support/security-routes';
import { CONSOLE_ORIGIN, StaffConsole, codeFor, makeStaff } from '../../support/staff-console';

const clock = new TestClock();
let t: TestApp;
let limits: RateLimitService;

beforeAll(async () => {
  t = await createTestApp({
    controllers: [SecurityTestController],
    env: { CORS_ORIGINS: `${CONSOLE_ORIGIN},${PORTAL_ORIGIN}` },
    clock,
  });
  limits = t.app.get(RateLimitService);
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
  await clearRateLimits(t);
});

const STAFF_URL = '/admin/t/sec/session';
const CLIENT_URL = '/client/t/sec/as-staff';
const unknownCookie = (subject: 'staff' | 'account') => `${SESSION_COOKIE_NAMES[subject]}=${'a'.repeat(43)}`;
const get = (url: string, ip: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, remoteAddress: ip, headers });

describe('the session failure budget', () => {
  it('answers 429 without a lookup once an address used 300 unknown session cookies of one audience in a minute', async () => {
    const ip = freshClientIp();
    // 299 of the 300 points are used: the next failed lookup takes the last one.
    expect(await limits.consume('ip', sessionFailureKey('staff', ip), 299)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    const lookup = spyOn(t.app.get(SessionService), 'lookup');
    try {
      const last = await get(STAFF_URL, ip, { cookie: unknownCookie('staff') });
      expect(last.statusCode).toBe(401);
      expect(lookup).toHaveBeenCalledTimes(1);
      lookup.mockClear();
      // The budget is used up: the address is refused before anything is looked up.
      const refused = await get(STAFF_URL, ip, { cookie: unknownCookie('staff') });
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it('charges one point per failed lookup and none without a cookie or for a live session', async () => {
    const ip = freshClientIp();
    const { session } = await signInStaff(t, []);
    for (let n = 0; n < 3; n += 1)
      expect((await get(STAFF_URL, ip, { cookie: unknownCookie('staff') })).statusCode).toBe(401);
    // No cookie and a live session cost nothing; a cookie that is not even shaped like a token names no session and costs a point like any other.
    expect((await get(STAFF_URL, ip)).statusCode).toBe(401);
    expect((await get(STAFF_URL, ip, session.headers)).statusCode).toBe(200);
    expect(await limits.peek('ip', sessionFailureKey('staff', ip))).toMatchObject({ allowed: true, remaining: 297 });
    expect((await get(STAFF_URL, ip, { cookie: `${SESSION_COOKIE_NAMES.staff}=not-a-token` })).statusCode).toBe(401);
    expect(await limits.peek('ip', sessionFailureKey('staff', ip))).toMatchObject({ allowed: true, remaining: 296 });
  });

  it('leaves the other audiences and other addresses alone', async () => {
    const ip = freshClientIp();
    await limits.consume('ip', sessionFailureKey('staff', ip), 300);
    // The account audience of the same address has its own budget.
    expect((await get(CLIENT_URL, ip, { cookie: unknownCookie('account') })).statusCode).toBe(401);
    // Another address has its own budget for the staff audience.
    expect((await get(STAFF_URL, freshClientIp(), { cookie: unknownCookie('staff') })).statusCode).toBe(401);
    // An IPv6 address shares the budget of its /64 network, not of its neighbour network.
    const network = freshClientPrefix();
    await limits.consume('ip', sessionFailureKey('staff', `${network}::1`), 300);
    expect((await get(STAFF_URL, `${network}::2`, { cookie: unknownCookie('staff') })).statusCode).toBe(429);
  });

  it('a live staff session from another address still passes', async () => {
    const exhausted = freshClientIp();
    await limits.consume('ip', sessionFailureKey('staff', exhausted), 300);
    await get(STAFF_URL, exhausted, { cookie: unknownCookie('staff') });
    const { session, staffId } = await signInStaff(t, []);
    const res = await get(STAFF_URL, freshClientIp(), session.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'staff', id: staffId });
  });
});

/** The `me` route of each audience these tests sign in to. */
const ME_URL = { staff: '/admin/auth/me', account: '/client/auth/me' } as const;

/** A cookie of an audience (default staff), shaped like a token, that names no session. */
const inventedCookie = (subject: keyof typeof ME_URL = 'staff') =>
  `${SESSION_COOKIE_NAMES[subject]}=${randomBytes(32).toString('base64url')}`;

/** Sends `count` requests with invented cookies of an audience (default staff) from one address, 50 at a time, and returns their status codes. */
async function inventedCookies(ip: string, count: number, subject: keyof typeof ME_URL = 'staff'): Promise<number[]> {
  const codes: number[] = [];
  for (let sent = 0; sent < count; sent += 50) {
    const batch = Array.from({ length: Math.min(50, count - sent) }, () =>
      get(ME_URL[subject], ip, { cookie: inventedCookie(subject) }),
    );
    codes.push(...(await Promise.all(batch)).map((res) => res.statusCode));
  }
  return codes;
}

/** The statements that read the sessions or the staff accounts while `work` runs. */
async function sessionReadsDuring(work: () => Promise<void>): Promise<string[]> {
  const query = spyOn(t.app.get(DbService).pool, 'query');
  try {
    await work();
    return query.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : (call[0] as { text: string }).text))
      .filter((text) => /"sessions"|"staff"/.test(text));
  } finally {
    query.mockRestore();
  }
}

/** Sends `count` requests 2 ms apart, each without waiting for the answers before it, and returns their status codes in order. */
async function sideBySide(count: number, send: () => Promise<{ statusCode: number }>): Promise<number[]> {
  const pending: Promise<{ statusCode: number }>[] = [];
  for (let sent = 0; sent < count; sent += 1) {
    pending.push(send());
    await Bun.sleep(2);
  }
  return (await Promise.all(pending)).map((res) => res.statusCode);
}

/** How many milliseconds the cached view of a session token stays fresh on the app's clock (0 when nothing is cached). */
async function freshForMs(token: string): Promise<number> {
  const key = t.app.get(CacheKeys).session(t.app.get(TokenService).hash(token));
  const text = (await t.app.get(RedisService).cache.get(key)) ?? '';
  const opened = openEntry(cacheMacKey(t.config.security.tokenPepper), key, text);
  return typeof opened === 'string' ? 0 : opened.freshUntil - clock.nowMs();
}

describe('a live session of an address that used up its budget', () => {
  it('is answered from the cache on the console routes, while invented cookies stay refused without a database read', async () => {
    const shared = freshClientIp();
    const { session } = await signInStaff(t, ['*']);
    expect((await get('/admin/auth/me', shared, session.headers)).statusCode).toBe(200);
    // An unknown cookie is looked up in the database while the budget lasts.
    expect(
      await sessionReadsDuring(async () => void (await get('/admin/auth/me', shared, { cookie: inventedCookie() }))),
    ).not.toEqual([]);
    const codes = await inventedCookies(shared, 299);
    expect(codes.filter((code) => code === 401)).toHaveLength(299);

    const reads = await sessionReadsDuring(async () => {
      const refused = await get('/admin/auth/me', shared, { cookie: inventedCookie() });
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    });
    expect(reads, 'no database read for an invented cookie once the budget is used up').toEqual([]);

    expect((await get('/admin/auth/me', shared, session.headers)).statusCode).toBe(200);
    expect((await get('/admin/sessions', shared, session.headers)).statusCode).toBe(200);
    const logout = await t.app.inject({
      method: 'POST',
      url: '/admin/auth/logout',
      remoteAddress: shared,
      headers: session.mutationHeaders,
    });
    expect(logout.statusCode).toBe(204);
    // The session it ended is not served from the cache afterwards.
    expect((await get('/admin/auth/me', shared, session.headers)).statusCode).toBe(429);
    expect((await get('/admin/auth/me', freshClientIp(), session.headers)).statusCode).toBe(401);
  }, 60_000);

  it('is answered for an address of the same IPv6 /64 as the address that used up the budget', async () => {
    const prefix = freshClientPrefix();
    const { session } = await signInStaff(t, ['*']);
    expect((await get('/admin/auth/me', `${prefix}::1`, session.headers)).statusCode).toBe(200);
    await inventedCookies(`${prefix}::bad`, 300);
    expect((await get('/admin/auth/me', `${prefix}::bad`, { cookie: inventedCookie() })).statusCode).toBe(429);
    expect((await get('/admin/auth/me', `${prefix}::1`, session.headers)).statusCode).toBe(200);
  }, 60_000);

  for (const cadence of [60, 65, 90]) {
    it(`stays answered while it is used every ${cadence} seconds for five minutes with the budget used up the whole time`, async () => {
      const ip = freshClientIp();
      const budget = sessionFailureKey('staff', ip);
      const { session } = await signInStaff(t, []);
      expect((await get(STAFF_URL, ip, session.headers)).statusCode).toBe(200);
      await limits.consume('ip', budget, 300);
      // Five minutes on the app's clock, one request per step: each step comes later than the shortest life of a fresh view (51 s).
      for (let step = 1; step <= Math.ceil(300 / cadence); step += 1) {
        clock.advance(cadence * SECOND);
        expect(await limits.peek('ip', budget), `budget after ${step * cadence} s`).toMatchObject({ allowed: false });
        expect((await get(STAFF_URL, ip, session.headers)).statusCode, `after ${step * cadence} s`).toBe(200);
        // The request left a view loaded at this moment behind it.
        await eventually(async () => ((await freshForMs(session.token)) >= 50 * SECOND ? true : undefined));
      }
      expect((await get(STAFF_URL, ip, { cookie: inventedCookie() })).statusCode).toBe(429);
    }, 60_000);
  }

  it('stays answered when it sends requests side by side while its once-a-minute last-use write runs', async () => {
    const ip = freshClientIp();
    const budget = sessionFailureKey('staff', ip);
    const { session } = await signInStaff(t, []);
    expect((await get(STAFF_URL, ip, session.headers)).statusCode).toBe(200);
    await limits.consume('ip', budget, 300);
    // Each round comes after the last-use write is due, so the 20 requests of a round overlap that write and the reload of the view behind it.
    for (let round = 1; round <= 6; round += 1) {
      clock.advance(61 * SECOND);
      expect(await limits.peek('ip', budget), `budget in round ${round}`).toMatchObject({ allowed: false });
      const codes = await sideBySide(20, () => get(STAFF_URL, ip, session.headers));
      expect(codes, `round ${round}`).toEqual(Array.from({ length: 20 }, () => 200));
    }
    expect((await get(STAFF_URL, ip, { cookie: inventedCookie() })).statusCode).toBe(429);
  }, 60_000);

  it('is refused while the budget is used up once its view left the cache, and answered again when the budget is back', async () => {
    const ip = freshClientIp();
    const { session } = await signInStaff(t, []);
    expect((await get(STAFF_URL, ip, session.headers)).statusCode).toBe(200);
    await limits.consume('ip', sessionFailureKey('staff', ip), 300);
    // Unused for longer than a view stays in the cache, its grace included (69 s + 60 s at most): a cache miss, which is not looked up
    // while the budget is used up.
    clock.advance(130 * SECOND);
    const reads = await sessionReadsDuring(async () => {
      expect((await get(STAFF_URL, ip, session.headers)).statusCode).toBe(429);
    });
    expect(reads).toEqual([]);
    await limits.reset('ip', sessionFailureKey('staff', ip));
    expect((await get(STAFF_URL, ip, session.headers)).statusCode).toBe(200);
  });
});

describe('a sign-in from an address that used up its budget', () => {
  it('finishes for staff: the code step on the pending session and the rotated session are answered', async () => {
    const ip = freshClientIp();
    const staff = await makeStaff(t);
    expect((await inventedCookies(ip, 300)).filter((code) => code === 401)).toHaveLength(300);
    expect((await get(ME_URL.staff, ip, { cookie: inventedCookie() })).statusCode).toBe(429);

    const browser = new StaffConsole(t, ip);
    const login = await browser.login(staff.email);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ next: 'totp' });
    expect((await browser.code(await codeFor(staff.secret, clock.nowMs()))).statusCode).toBe(204);
    const me = await browser.me();
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: staff.id });
    expect(await limits.peek('ip', sessionFailureKey('staff', ip))).toMatchObject({ allowed: false });
  }, 60_000);

  it('finishes for an account, with and without two-factor sign-in', async () => {
    await seedPortalBasics();
    const ip = freshClientIp();
    const oneStep = await makeMerchant(t);
    const twoSteps = await makeMerchant(t, { twofa: true });
    expect((await inventedCookies(ip, 300, 'account')).filter((code) => code === 401)).toHaveLength(300);
    expect((await get(ME_URL.account, ip, { cookie: inventedCookie('account') })).statusCode).toBe(429);

    const first = new MerchantPortal(t, ip);
    expect((await first.login(oneStep.email)).json()).toEqual({ next: 'done' });
    expect((await first.me()).statusCode).toBe(200);

    const second = new MerchantPortal(t, ip);
    expect((await second.login(twoSteps.email)).json()).toEqual({ next: 'totp' });
    expect((await second.code(await codeFor(twoSteps.secret, clock.nowMs()))).statusCode).toBe(204);
    const me = await second.me();
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: twoSteps.id });
    expect(await limits.peek('ip', sessionFailureKey('account', ip))).toMatchObject({ allowed: false });
  }, 60_000);
});

describe('one budget for both URL families of the accounts (decision 064)', () => {
  it('charges the cookies invented on the shop routes and on the portal routes to one budget per address', async () => {
    const ip = freshClientIp();
    const cookie = { cookie: `${SESSION_COOKIE_NAMES.account}=${'a'.repeat(43)}` };
    // Both families read the one account cookie, so they count in the one key `session-failures:account:<address>`.
    for (let sent = 0; sent < 150; sent += 1) {
      expect((await get('/store/v1/me', ip, cookie)).statusCode).toBe(401);
      expect((await get('/client/auth/me', ip, cookie)).statusCode).toBe(401);
    }
    expect(await limits.peek('ip', sessionFailureKey('account', ip))).toMatchObject({ allowed: false });
    expect((await get('/store/v1/me', ip, cookie)).statusCode).toBe(429);
    expect((await get('/client/auth/me', ip, cookie)).statusCode).toBe(429);
    // The staff budget of the same address is another key.
    expect(await limits.peek('ip', sessionFailureKey('staff', ip))).toMatchObject({ allowed: true });
  }, 60_000);
});
