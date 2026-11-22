// Integration tests of the failed-lookup budget of session cookies (decision 053) through real HTTP: a cookie that names no live session costs one
// point per client address and audience on the `ip` limiter; once the 300 a minute are used up the address is answered 429 without a lookup.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { RateLimitService } from '@src/infra/rate-limit';
import { SESSION_COOKIE_NAMES, SessionService } from '@src/modules/identity';
import { sessionFailureKey } from '@src/modules/identity/security/session-authenticator';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, signInStaff } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
import { freshClientIp, freshClientPrefix } from '../../support/pipeline-routes';
import { SecurityTestController } from '../../support/security-routes';

const clock = new TestClock();
let t: TestApp;
let limits: RateLimitService;

beforeAll(async () => {
  t = await createTestApp({ controllers: [SecurityTestController], clock });
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
});

const STAFF_URL = '/admin/t/sec/session';
const CLIENT_URL = '/client/t/sec/as-staff';
const unknownCookie = (subject: 'staff' | 'client' | 'customer') =>
  `${SESSION_COOKIE_NAMES[subject]}=${'a'.repeat(43)}`;
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
    // The merchant audience of the same address has its own budget.
    expect((await get(CLIENT_URL, ip, { cookie: unknownCookie('client') })).statusCode).toBe(401);
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
