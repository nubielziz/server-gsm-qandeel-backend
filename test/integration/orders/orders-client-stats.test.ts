// The orders source of identity's ClientStatsDirectory (feature 5): GET /admin/clients shows each account's rolling 30 days of orders:
// count, spend of the orders not rejected, profit of the completed ones, margin, success rate and the latest order time, over every
// order of the account whatever the door (decision 064); the lifetime figures and the order figures of the list sorts come from the same module.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '@src/infra/db';
import { OrderClientStats } from '@src/modules/orders/application/order-client-stats';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { IMEIS, insertOrderRow, json, type OrdersWorld, ordersWorld, portalFor } from '../../support/orders';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['clients:*', 'wallet:read', 'orders:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function place(imei: string, serviceId: number): Promise<number> {
  const res = await (await portalFor(t, world.merchant.id)).post('/client/orders', { serviceId, imei });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

const statsOf = async (accountId: number) =>
  ((await staff.get('/admin/clients?_end=100')).body as Array<{ id: number; stats?: Record<string, unknown> }>).find(
    (c) => c.id === accountId,
  )!.stats;

describe('account stats from orders', () => {
  it('reads as no orders for an account without any', async () => {
    expect(await statsOf(world.other.id)).toEqual({
      orders: 0,
      spend: '0.0000',
      profit: '0.0000',
      margin: null,
      successRate: null,
      lastOrderAt: null,
    });
  });

  it('counts the orders, the spend of the ones not rejected, the profit of the completed ones and the success rate', async () => {
    const { auto, manual, db } = world;
    const done = await place(IMEIS[0], auto.serviceId);
    const rejected = await place(IMEIS[1], auto.serviceId);
    await place(IMEIS[2], manual.serviceId);
    // The supplier executed the first order, so its cost is the service's 13.50.
    await db.update(s.orders).set({ supplierId: auto.supplierId, supplierRef: 'X' });
    await staff.post(`/admin/orders/${done}/reply`, { code: 'ok' });
    await staff.post(`/admin/orders/${rejected}/reject`, { reason: 'No' });
    const stats = (await statsOf(world.merchant.id))!;
    expect(stats.orders).toBe(3);
    // 17.28 (completed) + 5.00 (pending manual order); the rejected 17.28 does not count.
    expect(stats.spend).toBe('22.2800');
    // Profit of the completed order: price 17.28 minus the cost 13.50 recorded on the order.
    expect(stats.profit).toBe('3.7800');
    expect(stats.margin).toBe('17.0');
    expect(stats.successRate).toBe(50);
    expect(typeof stats.lastOrderAt).toBe('string');
    expect(await statsOf(world.other.id)).toMatchObject({ orders: 0 });
  });

  it('counts only the last 30 days', async () => {
    const { auto } = world;
    await place(IMEIS[0], auto.serviceId);
    expect((await statsOf(world.merchant.id))!.orders).toBe(1);
    clock.advance(31 * DAY);
    staff = await adminWith(t, ['clients:*', 'wallet:read']);
    expect(await statsOf(world.merchant.id)).toMatchObject({ orders: 0, lastOrderAt: null });
  });

  it('is left out for staff without wallet:read', async () => {
    const nosey = await adminWith(t, ['clients:read']);
    const body = (await nosey.get('/admin/clients?_end=100')).body as Array<Record<string, unknown>>;
    expect(body.every((client) => !('stats' in client))).toBe(true);
  });

  it('counts the shop orders of the account with its portal orders: the figures cover every door', async () => {
    const { db, merchant, auto } = world;
    await place(IMEIS[0], auto.serviceId);
    // The same account paid an order first in the shop, when it still held the retail rank.
    await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: auto.serviceId,
      source: 'store',
      imei: IMEIS[1],
      status: 'completed',
      dispatchState: 'done',
      unitPrice: '10.0000',
      totalPrice: '10.0000',
      taxAmount: '2.0000',
      // At the test clock's time, as the portal order: the clock of this file has moved past the real time in an earlier case.
      createdAt: clock.now(),
    });
    const stats = (await statsOf(merchant.id))!;
    expect(stats.orders).toBe(2);
    // 17.28 held in the portal plus 10.00 paid in the shop.
    expect(stats.spend).toBe('27.2800');
  });
});

describe('the lifetime figures and the figures of the account list', () => {
  const lifetime = () => t.app.get(OrderClientStats, { strict: false });

  it('add up every order of the account: the count, the first and the last date, and what it paid with the tax, rejected orders left out', async () => {
    const { db, merchant, other, auto } = world;
    const first = new Date('2026-09-01T10:00:00.000Z');
    const last = new Date('2026-10-20T10:00:00.000Z');
    await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: auto.serviceId,
      imei: IMEIS[0],
      status: 'completed',
      dispatchState: 'done',
      totalPrice: '17.2800',
      unitPrice: '17.2800',
      createdAt: first,
    });
    await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: auto.serviceId,
      source: 'store',
      imei: IMEIS[1],
      status: 'completed',
      dispatchState: 'done',
      totalPrice: '10.0000',
      unitPrice: '10.0000',
      taxAmount: '2.0000',
      createdAt: last,
    });
    await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: auto.serviceId,
      imei: IMEIS[2],
      status: 'rejected',
      dispatchState: 'done',
      totalPrice: '99.0000',
      unitPrice: '99.0000',
      createdAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    const figures = await lifetime().lifetimeOf(db, [merchant.id, other.id]);
    expect(figures.get(merchant.id)).toEqual({
      ordersCount: 3,
      firstOrderAt: first.toISOString(),
      lastOrderAt: last.toISOString(),
      // 17.28 + (10.00 + 2.00 tax); the rejected 99.00 does not count.
      totalSpent: '29.2800',
    });
    // An account that never ordered has no entry.
    expect(figures.has(other.id)).toBe(false);
  });

  it('serve the account list: each row carries its order count and last order, and the list sorts by them', async () => {
    const { db, merchant, other, auto } = world;
    await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId, imei: IMEIS[0] });
    await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId, imei: IMEIS[1], source: 'store' });
    await insertOrderRow(db, { accountId: other.id, serviceId: auto.serviceId, imei: IMEIS[2] });
    const rows = (await staff.get('/admin/clients?_sort=ordersCount&_order=desc&_end=100')).body as Array<{
      id: number;
      ordersCount: number;
      lastOrderAt: string | null;
    }>;
    expect(rows.find((row) => row.id === merchant.id)).toMatchObject({ ordersCount: 2 });
    expect(rows.find((row) => row.id === other.id)).toMatchObject({ ordersCount: 1 });
    const ids = rows.map((row) => row.id);
    expect(ids.indexOf(merchant.id)).toBeLessThan(ids.indexOf(other.id));
    expect(typeof rows.find((row) => row.id === merchant.id)!.lastOrderAt).toBe('string');
  });
});
