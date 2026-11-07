// Integration tests of delivering stocked codes at placement (RULES orders 10, resolution orders-suppliers-11): an order of a
// service with available codes completes at once with them as its result; a short stock sends the order the usual way; two
// placements at the same moment never get the same code; a bulk order uses what the stock has; a delivered code stays sold
// after a reopen. Also the placement time from the injected clock (decision 031).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  IMEIS,
  eventsOf,
  json,
  ledgerOf,
  type OrdersWorld,
  orderRow,
  ordersWorld,
  outboxOf,
  portalFor,
  systemBalance,
  walletOf,
} from '../support/orders';

const clock = new TestClock('2026-11-05T08:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-05T08:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** Imports codes for a service through the admin route, as staff would. */
async function stock(serviceId: number, codes: string[]): Promise<void> {
  const staff = await signInStaff(t, ['inventory:write']);
  const res = await t.app.inject({
    method: 'POST',
    url: `/admin/services/${serviceId}/inventory/import`,
    headers: staff.session.mutationHeaders,
    payload: { codes },
  });
  expect(res.statusCode).toBeLessThan(300);
}

/** The status and order of every stocked code of a service, oldest first. */
async function codesOf(serviceId: number) {
  const { db } = await testDb();
  return db
    .select({ status: s.inventoryCodes.status, orderId: s.inventoryCodes.orderId, last4: s.inventoryCodes.codeLast4 })
    .from(s.inventoryCodes)
    .where(eq(s.inventoryCodes.serviceId, serviceId))
    .orderBy(s.inventoryCodes.id);
}

describe('placement of a stocked service', () => {
  it('completes the order at once with the oldest code as its result, settles it and tells the merchant', async () => {
    const { db, merchant, auto } = world;
    await stock(auto.serviceId, ['GSM-STOCK-0001', 'GSM-STOCK-0002']);
    const res = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', {
      serviceId: auto.serviceId,
      imei: IMEIS[0],
    });
    expect(res.statusCode).toBe(201);
    const [placed] = json(res).orders;
    expect(placed).toMatchObject({
      status: 'completed',
      result: { code: 'GSM-STOCK-0001' },
      completedAt: '2026-11-05T08:00:00.000Z',
    });

    const row = await orderRow(db, placed.id);
    expect(row).toMatchObject({ status: 'completed', dispatchState: 'done', resultCode: 'GSM-STOCK-0001' });
    expect(row.placedAt.toISOString()).toBe('2026-11-05T08:00:00.000Z');
    expect(await codesOf(auto.serviceId)).toEqual([
      { status: 'sold', orderId: placed.id, last4: '0001' },
      { status: 'available', orderId: null, last4: '0002' },
    ]);

    // Held, then settled to revenue only: no supplier executed it (B17).
    expect((await ledgerOf(db, placed.id)).map((entry) => entry.key)).toEqual([
      `order:${placed.id}:hold`,
      `order:${placed.id}:settle`,
    ]);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');

    expect((await eventsOf(db, placed.id)).map((event) => event.type)).toEqual([
      'created',
      'hold',
      'completed',
      'settle',
    ]);
    const [changed] = await outboxOf(db, 'order.status_changed', placed.id);
    expect(changed?.payload).toMatchObject({
      orderId: placed.id,
      clientId: merchant.id,
      fromStatus: 'pending',
      toStatus: 'completed',
    });
    expect(await outboxOf(db, 'order.dispatch_requested', placed.id)).toEqual([]);
  });

  it('delivers from stock first, even for a manual service', async () => {
    const { merchant, manual } = world;
    await stock(manual.serviceId, ['MANUAL-STOCK-01']);
    const res = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', {
      serviceId: manual.serviceId,
      imei: IMEIS[1],
    });
    expect(json(res).orders[0]).toMatchObject({ status: 'completed', result: { code: 'MANUAL-STOCK-01' } });
  });

  it('places the order the usual way when no code is available, and never uses a void code', async () => {
    const { db, merchant, auto } = world;
    await stock(auto.serviceId, ['GSM-STOCK-0101']);
    const portal = await portalFor(t, merchant.id);
    const first = json(await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] })).orders[0];
    expect(first.status).toBe('completed');
    // The stock is empty now: the next order goes to the supplier.
    const second = json(await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[1] })).orders[0];
    expect(second).toMatchObject({ status: 'pending', result: { code: null } });
    expect((await orderRow(db, second.id)).dispatchState).toBe('pending');
    expect(await outboxOf(db, 'order.dispatch_requested', second.id)).toHaveLength(1);

    await db.update(s.inventoryCodes).set({ status: 'void' }).where(eq(s.inventoryCodes.serviceId, auto.serviceId));
    await stock(auto.serviceId, ['GSM-STOCK-0102']);
    await db.update(s.inventoryCodes).set({ status: 'void' }).where(eq(s.inventoryCodes.codeLast4, '0102'));
    const third = json(await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[2] })).orders[0];
    expect(third.status).toBe('pending');
  });

  it('gives one code to one order when two placements arrive together', async () => {
    const { db, merchant, auto } = world;
    await stock(auto.serviceId, ['GSM-STOCK-0201']);
    const portal = await portalFor(t, merchant.id);
    const results = await Promise.all(
      [IMEIS[0], IMEIS[1]].map((imei) => portal.post('/client/orders', { serviceId: auto.serviceId, imei })),
    );
    expect(results.map((res) => res.statusCode)).toEqual([201, 201]);
    const statuses = results.map((res) => json(res).orders[0].status as string).sort();
    expect(statuses).toEqual(['completed', 'pending']);
    const codes = await codesOf(auto.serviceId);
    expect(codes).toHaveLength(1);
    expect(codes[0]?.status).toBe('sold');
    const winner = results.map((res) => json(res).orders[0]).find((order) => order.status === 'completed');
    expect(codes[0]?.orderId).toBe(winner.id);
    expect((await walletOf(db, merchant.id)).hold).toBe('17.2800');
  });

  it('gives the codes of a bulk order to its first orders and sends the rest the usual way', async () => {
    const { merchant, auto } = world;
    await stock(auto.serviceId, ['GSM-STOCK-0301', 'GSM-STOCK-0302']);
    const res = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', {
      serviceId: auto.serviceId,
      imeis: [IMEIS[0], IMEIS[1], IMEIS[2]],
    });
    expect(res.statusCode).toBe(201);
    const orders = json(res).orders as Array<{ status: string; result: { code: string | null } }>;
    expect(orders.map((order) => [order.status, order.result.code])).toEqual([
      ['completed', 'GSM-STOCK-0301'],
      ['completed', 'GSM-STOCK-0302'],
      ['pending', null],
    ]);
  });

  it('keeps a delivered code sold when the order is reopened', async () => {
    const { merchant, auto } = world;
    await stock(auto.serviceId, ['GSM-STOCK-0401']);
    const placed = json(
      await (await portalFor(t, merchant.id)).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] }),
    ).orders[0];
    const staff = await signInStaff(t, ['orders:reopen']);
    const reopen = await t.app.inject({
      method: 'POST',
      url: `/admin/orders/${placed.id}/reopen`,
      headers: staff.session.mutationHeaders,
      payload: { reason: 'Wrong code' },
    });
    expect(reopen.statusCode).toBe(204);
    expect(await codesOf(auto.serviceId)).toEqual([{ status: 'sold', orderId: placed.id, last4: '0401' }]);
  });
});

describe('placement time', () => {
  it('stamps placed_at from the injected clock, so the SLA age is on the same clock as the rules that read it', async () => {
    const { db, merchant, auto } = world;
    clock.set('2026-11-05T09:30:00.000Z');
    const placed = json(
      await (await portalFor(t, merchant.id)).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[3] }),
    ).orders[0];
    expect((await orderRow(db, placed.id)).placedAt.toISOString()).toBe('2026-11-05T09:30:00.000Z');
  });
});
