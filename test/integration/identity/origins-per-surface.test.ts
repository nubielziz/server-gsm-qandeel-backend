// Integration tests of the Origin rules per surface (decisions 018 and 045) through real HTTP: a session-less mutation and an
// originCheck GET are judged against the origins of their own surface, and a live stream refuses the other audience's origin.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  NOT_STARTED_HERE_DETAIL,
  ORIGIN_MISSING_DETAIL,
  ORIGIN_NOT_ALLOWED_DETAIL,
} from '@src/modules/identity/security/origin-checks';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession, signInStaff } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
import { PORTAL_ORIGIN } from '../../support/merchant-portal';
import { SecurityTestController } from '../../support/security-routes';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { STORE_ORIGIN, makeCustomer } from '../../support/store';

const clock = new TestClock();
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    controllers: [SecurityTestController],
    env: { CONSOLE_ORIGINS: CONSOLE_ORIGIN, SHOP_ORIGINS: `${STORE_ORIGIN},${PORTAL_ORIGIN}` },
    clock,
  });
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});

const send = (method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method, url, headers });

describe('a mutation without a session', () => {
  it('is accepted on the staff surface only from a console origin', async () => {
    const ok = await send('POST', '/admin/t/sec/login', { origin: CONSOLE_ORIGIN });
    expect(ok.statusCode).toBe(200);
    const fromShop = await send('POST', '/admin/t/sec/login', { origin: STORE_ORIGIN });
    expect(fromShop.statusCode).toBe(403);
    expect(fromShop.json()).toMatchObject({ code: 'CSRF_FAILED', detail: ORIGIN_NOT_ALLOWED_DETAIL });
    const bare = await send('POST', '/admin/t/sec/login');
    expect(bare.statusCode).toBe(403);
    expect(bare.json()).toMatchObject({ code: 'CSRF_FAILED', detail: ORIGIN_MISSING_DETAIL });
  });

  it('is accepted on the merchant surface only from a shop origin', async () => {
    for (const origin of [STORE_ORIGIN, PORTAL_ORIGIN]) {
      expect((await send('POST', '/client/t/sec/register', { origin })).statusCode, origin).toBe(200);
    }
    const fromConsole = await send('POST', '/client/t/sec/register', { origin: CONSOLE_ORIGIN });
    expect(fromConsole.statusCode).toBe(403);
    expect(fromConsole.json()).toMatchObject({ code: 'CSRF_FAILED' });
  });

  it('is accepted on a store route that signs a visitor in only from a shop origin, and the other public store writes are left alone', async () => {
    expect((await send('POST', '/store/v1/t/sec/sign-in', { origin: STORE_ORIGIN })).statusCode).toBe(200);
    expect((await send('POST', '/store/v1/t/sec/sign-in', { origin: CONSOLE_ORIGIN })).statusCode).toBe(403);
    expect((await send('POST', '/store/v1/t/sec/sign-in')).statusCode).toBe(403);
    // A mail provider posts the one-click unsubscribe without an Origin: such writes keep working.
    expect((await send('POST', '/store/v1/t/sec/public')).statusCode).toBe(200);
  });
});

describe('a GET with originCheck', () => {
  it("is answered when the page's own site started it: Sec-Fetch-Site same-origin, or an Origin of the route's audience", async () => {
    const { session } = await signInStaff(t, []);
    const get = (extra: Record<string, string>) =>
      send('GET', '/admin/t/sec/origin-checked', { ...session.headers, ...extra });
    expect((await get({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    const sameSite = await get({ 'sec-fetch-site': 'same-site' });
    expect(sameSite.statusCode).toBe(403);
    expect(sameSite.json()).toMatchObject({ code: 'CSRF_FAILED', detail: NOT_STARTED_HERE_DETAIL });
    expect((await get({ 'sec-fetch-site': 'same-site', origin: CONSOLE_ORIGIN })).statusCode).toBe(200);
    const fromShop = await get({ 'sec-fetch-site': 'same-site', origin: STORE_ORIGIN });
    expect(fromShop.statusCode).toBe(403);
    expect(fromShop.json()).toMatchObject({ code: 'CSRF_FAILED', detail: ORIGIN_NOT_ALLOWED_DETAIL });
    expect((await get({ 'sec-fetch-site': 'cross-site', origin: CONSOLE_ORIGIN })).statusCode).toBe(200);
    expect((await get({ 'sec-fetch-site': 'none' })).statusCode).toBe(403);
    const bare = await get({});
    expect(bare.statusCode).toBe(403);
    expect(bare.json()).toMatchObject({ code: 'CSRF_FAILED', detail: ORIGIN_MISSING_DETAIL });
    expect((await get({ origin: CONSOLE_ORIGIN })).statusCode).toBe(200);
  });

  it("uses the shop's origins on the store surface", async () => {
    const customer = await makeCustomer(t);
    const session = await openSession(t, { type: 'customer', id: customer.id });
    const get = (extra: Record<string, string>) =>
      send('GET', '/store/v1/t/sec/origin-checked', { ...session.headers, ...extra });
    expect((await get({ origin: STORE_ORIGIN })).statusCode).toBe(200);
    expect((await get({ origin: CONSOLE_ORIGIN })).statusCode).toBe(403);
    expect((await get({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
  });
});

describe('a live stream', () => {
  it("refuses the other audience's origin, with no CORS grant", async () => {
    const { session } = await signInStaff(t, []);
    const staff = await send('GET', '/admin/stream', { ...session.headers, origin: STORE_ORIGIN });
    expect(staff.statusCode).toBe(403);
    expect(staff.json()).toMatchObject({ code: 'CSRF_FAILED' });
    expect(staff.headers['access-control-allow-origin']).toBeUndefined();
    const customer = await makeCustomer(t);
    const customerSession = await openSession(t, { type: 'customer', id: customer.id });
    const shop = await send('GET', '/store/v1/me/stream', { ...customerSession.headers, origin: CONSOLE_ORIGIN });
    expect(shop.statusCode).toBe(403);
    expect(shop.json()).toMatchObject({ code: 'CSRF_FAILED' });
    expect(shop.headers['access-control-allow-origin']).toBeUndefined();
  });
});
