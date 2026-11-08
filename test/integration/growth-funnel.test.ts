// Integration tests of the storefront sales funnel (feature 19, resolution b2c-10): GET /admin/reports/funnel counts IMEI checks, checkouts
// started, paid and delivered over a window of the injected clock, with the dashboard's own function, for 7, 30 or 90 days.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertAbandoned } from '../support/growth';
import { insertStoreOrder, storefrontWorld, type StorefrontWorld } from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;
let world: StorefrontWorld;

const ago = (ms: number) => new Date(clock.nowMs() - ms);

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  world = await storefrontWorld(db);
  admin = await adminWith(t, ['reports:growth']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** An IMEI check of the storefront at a moment. */
async function check(source: 'storefront_free' | 'pre_order', createdAt: Date) {
  const { db } = await testDb();
  await db.insert(s.imeiChecks).values({ checkType: 'basic', source, createdAt, updatedAt: createdAt });
}

/** A checkout at a moment; `order` makes it paid, with an order that is `completed` or still `processing`. */
async function checkout(createdAt: Date, order?: 'completed' | 'processing') {
  const { db } = await testDb();
  const row = await insertAbandoned(t, db, { serviceId: world.icloud.serviceId, createdAt });
  if (order) {
    const orderId = await insertStoreOrder(db, world.icloud.serviceId, row.customerId!, { status: order });
    await db
      .update(s.checkoutSessions)
      .set({ orderId, status: 'paid' })
      .where(eq(s.checkoutSessions.id, row.sessionId));
  }
}

describe('GET /admin/reports/funnel', () => {
  it('counts the four steps of the storefront over the window, records not people, and nothing outside it', async () => {
    await check('storefront_free', ago(2 * HOUR));
    await check('pre_order', ago(3 * DAY));
    await check('storefront_free', ago(20 * DAY));
    await check('storefront_free', ago(60 * DAY));
    await checkout(ago(HOUR), 'completed');
    await checkout(ago(2 * DAY), 'processing');
    await checkout(ago(3 * DAY));
    await checkout(ago(10 * DAY), 'completed');
    await checkout(ago(45 * DAY), 'completed');

    const get = async (days: string) => (await admin.get(`/admin/reports/funnel?days=${days}`)).body;
    expect(await get('7')).toEqual({ days: 7, imeiChecks: 2, paymentStarted: 3, paid: 2, delivered: 1 });
    expect(await get('30')).toEqual({ days: 30, imeiChecks: 3, paymentStarted: 4, paid: 3, delivered: 2 });
    expect(await get('90')).toEqual({ days: 90, imeiChecks: 4, paymentStarted: 5, paid: 4, delivered: 3 });
  });

  it('opens the window exactly `days` x 24 hours back on the clock', async () => {
    await check('storefront_free', ago(7 * DAY));
    await check('storefront_free', ago(7 * DAY + 1));
    await checkout(ago(7 * DAY));
    await checkout(ago(7 * DAY + 1));
    expect((await admin.get('/admin/reports/funnel?days=7')).body).toMatchObject({ imeiChecks: 1, paymentStarted: 1 });
    clock.advance(1);
    expect((await admin.get('/admin/reports/funnel?days=7')).body).toMatchObject({ imeiChecks: 0, paymentStarted: 0 });
  });

  it('closes the window at the clock: a record made at this very moment is not counted, one made a millisecond before is', async () => {
    await check('storefront_free', ago(0));
    await check('storefront_free', ago(1));
    await checkout(ago(0), 'completed');
    await checkout(ago(1), 'completed');
    // `[now - days x 24 h, now)`: the end is exclusive, like the start is inclusive.
    expect((await admin.get('/admin/reports/funnel?days=7')).body).toEqual({
      days: 7,
      imeiChecks: 1,
      paymentStarted: 1,
      paid: 1,
      delivered: 1,
    });
    clock.advance(1);
    expect((await admin.get('/admin/reports/funnel?days=7')).body).toMatchObject({ imeiChecks: 2, paymentStarted: 2 });
  });

  it('answers 30 days when `days` is left out, and zeros on a quiet shop', async () => {
    const res = await admin.get('/admin/reports/funnel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ days: 30, imeiChecks: 0, paymentStarted: 0, paid: 0, delivered: 0 });
  });

  it('agrees with the dashboard storefront block, which counts with the same function over 30 days', async () => {
    await check('storefront_free', ago(DAY));
    await checkout(ago(DAY), 'completed');
    await checkout(ago(2 * DAY));
    const funnel = (await admin.get('/admin/reports/funnel?days=30')).body;
    const dash = await (await adminWith(t, ['dashboard:read'])).get('/admin/dashboard?scope=b2c');
    expect(dash.status).toBe(200);
    expect(dash.body.storefront.funnel).toMatchObject({
      imeiChecks: funnel.imeiChecks,
      checkoutsStarted: funnel.paymentStarted,
      paid: funnel.paid,
      delivered: funnel.delivered,
    });
  });

  it('refuses a period other than 7, 30 or 90 with a 422 on `days`', async () => {
    for (const days of ['14', '0', '-7', '7.5', 'abc', '']) {
      const res = await admin.get(`/admin/reports/funnel?days=${days}`);
      expect(res.status, days).toBe(422);
      expect(res.body.errors[0], days).toMatchObject({ field: 'days' });
    }
  });

  it('needs reports:growth', async () => {
    const outsider = await adminWith(t, ['growth:read', 'dashboard:read']);
    const refused = await outsider.get('/admin/reports/funnel?days=7');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect((await outsider.anonymous('GET', '/admin/reports/funnel?days=7')).status).toBe(401);
  });
});
