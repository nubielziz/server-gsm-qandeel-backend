// The orders source of identity's ClientStatsDirectory (feature 5): GET /admin/clients shows each merchant's rolling 30 days of orders:
// count, spend of the orders not rejected, profit of the completed ones, margin, success rate and the latest order time.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { IMEIS, json, type OrdersWorld, ordersWorld, portalFor } from '../support/orders';

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

const statsOf = async (clientId: number) =>
  ((await staff.get('/admin/clients?_end=100')).body as Array<{ id: number; stats?: Record<string, unknown> }>).find(
    (c) => c.id === clientId,
  )!.stats;

describe('merchant stats from orders', () => {
  it('reads as no orders for a merchant without any', async () => {
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
});
