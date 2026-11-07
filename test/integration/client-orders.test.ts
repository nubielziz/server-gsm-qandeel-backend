// Integration tests of the merchant portal's order routes beyond placement (feature 5): GET /client/dashboard, GET /client/orders (filters,
// search, sorts, ranges), GET /client/orders/:id with its timeline, POST /client/orders/:id/cancel and GET /client/orders/export, with a
// merchant session: isolation between merchants, what a merchant never sees, and the refusals.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { fundWallet } from '../support/money';
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
  walletOf,
} from '../support/orders';

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
  staff = await adminWith(t, ['orders:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function place(serviceId: number, imei: string = IMEIS[0], clientId = world.merchant.id): Promise<number> {
  const res = await (await portalFor(t, clientId)).post('/client/orders', { serviceId, imei });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

const ids = (rows: Array<{ id: number }>): number[] => rows.map((row) => row.id);

describe('GET /client/orders', () => {
  it("lists only the signed-in merchant's orders, newest first, with the merchant's view of each", async () => {
    const { merchant, other, auto, manual } = world;
    const first = await place(auto.serviceId, IMEIS[0]);
    const second = await place(manual.serviceId, IMEIS[1]);
    const foreign = await place(auto.serviceId, IMEIS[2], other.id);
    const portal = await portalFor(t, merchant.id);
    const res = await portal.get('/client/orders');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('2');
    expect(ids(json(res))).toEqual([second, first]);
    expect(ids(json(res))).not.toContain(foreign);
    for (const row of json(res)) {
      for (const hidden of [
        'unitCost',
        'totalCost',
        'supplier',
        'supplierRef',
        'adminNote',
        'queue',
        'dispatchState',
        'pricingSnapshot',
        'customer',
        'client',
      ]) {
        expect(Object.keys(row)).not.toContain(hidden);
      }
    }
  });

  it('filters by status, type and service, searches the input and the service name, sorts and pages', async () => {
    const { merchant, auto, manual, server, db } = world;
    const a = await place(auto.serviceId, IMEIS[0]);
    const b = await place(manual.serviceId, IMEIS[1]);
    const c = await place(auto.serviceId, IMEIS[2]);
    const d = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', { serviceId: server.serviceId, inputs: { username: 'amir92' } });
    expect(d.statusCode).toBe(201);
    await staff.post(`/admin/orders/${c}/reject`, { reason: 'No' });
    const portal = await portalFor(t, merchant.id);
    const get = async (query: string) => ids(json(await portal.get(`/client/orders?${query}&_sort=id&_order=asc`)));
    expect(await get('status=rejected')).toEqual([c]);
    expect(await get('status_ne=rejected')).toEqual([a, b, json(d).orders[0].id]);
    expect(await get('type=server')).toEqual([json(d).orders[0].id]);
    expect(await get(`serviceId=${manual.serviceId}`)).toEqual([b]);
    expect(await get('q=amir')).toEqual([json(d).orders[0].id]);
    expect(await get(`q=${IMEIS[0]}`)).toEqual([a]);
    expect(await get('q=manual')).toEqual([b]);
    expect(await get(`q=${a}`)).toContain(a);
    const range = await portal.get('/client/orders?_sort=id&_order=asc&_start=1&_end=3');
    expect(ids(json(range))).toEqual([b, c]);
    expect(range.headers['x-total-count']).toBe('4');
    const future = await portal.get(
      `/client/orders?createdAt_gte=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`,
    );
    expect(json(future)).toEqual([]);
    expect((await portal.get('/client/orders?_sort=totalPrice&_order=asc')).statusCode).toBe(200);
    // No filter on a field the merchant list does not offer.
    expect((await portal.get('/client/orders?clientId=1')).statusCode).toBe(422);
    expect((await portal.get('/client/orders?queue=manual')).statusCode).toBe(422);
    expect(await orderRow(db, a)).toBeTruthy();
  });

  it('refuses a pending merchant and a call without a session', async () => {
    const pendingId = await insertMerchant((await testDb()).db, { status: 'pending' });
    const pending = await (await portalFor(t, pendingId)).get('/client/orders');
    expect(pending.statusCode).toBe(403);
    expect(json(pending).code).toBe('ACCOUNT_PENDING_APPROVAL');
    expect((await t.app.inject({ method: 'GET', url: '/client/orders' })).statusCode).toBe(401);
  });
});

describe('GET /client/orders/:id', () => {
  it('shows the order with the timeline lines a merchant may see, and no supplier, note, risk or settlement line', async () => {
    const { db, merchant, auto } = world;
    const id = await place(auto.serviceId);
    await db.insert(s.orderEvents).values([
      { orderId: id, type: 'dispatch', actorType: 'system', data: { message: 'Sent to Nordic GSM' } },
      {
        orderId: id,
        type: 'ack',
        actorType: 'supplier',
        actorId: auto.supplierId,
        data: { message: 'Accepted by supplier, ref NG-1' },
      },
      { orderId: id, type: 'risk', actorType: 'system', data: { message: 'Risk review' } },
    ]);
    await staff.post(`/admin/orders/${id}/notes`, { body: 'internal' });
    await staff.post(`/admin/orders/${id}/reply`, { code: 'Unlocked: 8842' });
    const res = await (await portalFor(t, merchant.id)).get(`/client/orders/${id}`);
    expect(res.statusCode).toBe(200);
    const order = json(res);
    expect(order).toMatchObject({ id, status: 'completed', result: { code: 'Unlocked: 8842' }, imei: IMEIS[0] });
    expect(order.events.map((event: { type: string }) => event.type)).toEqual(['created', 'hold', 'completed']);
    expect(order.events[0].message).toBe('Order received via Portal');
    expect(JSON.stringify(order)).not.toMatch(/Nordic|supplier|internal|Risk|Settled|cost/i);
    expect((await eventsOf(db, id)).length).toBeGreaterThan(order.events.length);
  });

  it("answers 404 for another merchant's order and for an unknown one, never 403", async () => {
    const { other, auto } = world;
    const id = await place(auto.serviceId, IMEIS[0], other.id);
    const portal = await portalFor(t, world.merchant.id);
    expect((await portal.get(`/client/orders/${id}`)).statusCode).toBe(404);
    expect((await portal.get('/client/orders/999999')).statusCode).toBe(404);
    expect((await portal.post(`/client/orders/${id}/cancel`)).statusCode).toBe(404);
    expect((await portal.post(`/client/orders/${id}/verify`)).statusCode).toBe(404);
  });
});

describe('GET /client/dashboard', () => {
  it('shows the wallet, the order counts by status and the five latest orders', async () => {
    const { merchant, auto } = world;
    const imeis = [...IMEIS, '490154203237518'];
    const placed: number[] = [];
    for (const [index, imei] of imeis.entries()) {
      // The wallet holds 100 USD: five orders at 17.28 fit, so the sixth is paid for by a top-up first.
      if (index === 5) await fundWallet(world.db, merchant.id, '50');
      placed.push(await place(auto.serviceId, imei));
    }
    await staff.post(`/admin/orders/${placed[0]}/reject`, { reason: 'No' });
    await staff.post(`/admin/orders/${placed[1]}/reply`, { code: 'ok' });
    const res = await (await portalFor(t, merchant.id)).get('/client/dashboard');
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.counts).toEqual({ pending: 4, processing: 0, completed: 1, rejected: 1 });
    expect(body.openOrders).toBe(4);
    expect(body.latestOrders).toHaveLength(5);
    expect(ids(body.latestOrders)).toEqual([...placed].reverse().slice(0, 5));
    // 150 funded, six orders of 17.28 placed (103.68), one released (+17.28): 63.60 left, 4 pending held, one settled.
    expect(body.wallet).toEqual({
      balance: '63.6000',
      reserved: '69.1200',
      creditLimit: '0.0000',
      available: '63.6000',
    });
  });

  it('is empty for a merchant without orders', async () => {
    const res = await (await portalFor(t, world.merchant.id)).get('/client/dashboard');
    expect(json(res)).toMatchObject({
      counts: { pending: 0, processing: 0, completed: 0, rejected: 0 },
      openOrders: 0,
      latestOrders: [],
      wallet: { balance: '100.0000', reserved: '0.0000' },
    });
  });
});

describe('POST /client/orders/:id/cancel', () => {
  async function cancellable(serviceKey: 'auto' | 'manual' = 'auto'): Promise<number> {
    const { db, auto, manual } = world;
    const serviceId = serviceKey === 'auto' ? auto.serviceId : manual.serviceId;
    await db.update(s.services).set({ allowCancel: true }).where(eq(s.services.id, serviceId));
    return place(serviceId);
  }

  it('cancels an order that was never sent: rejected as cancelled by the merchant, the hold released, no audit row', async () => {
    const { db, merchant } = world;
    const id = await cancellable();
    const portal = await portalFor(t, merchant.id);
    expect(json(await portal.get(`/client/orders/${id}`)).canCancel).toBe(true);
    const res = await portal.post(`/client/orders/${id}/cancel`);
    expect(res.statusCode).toBe(204);
    expect(await orderRow(db, id)).toMatchObject({
      status: 'rejected',
      dispatchState: 'done',
      resultCode: 'Cancelled by the merchant',
    });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect((await ledgerOf(db, id)).map((entry) => entry.kind)).toEqual(['order_hold', 'order_release']);
    expect((await eventsOf(db, id)).slice(-2).map((event) => [event.type, event.actorType])).toEqual([
      ['rejected', 'client'],
      ['release', 'system'],
    ]);
    expect((await outboxOf(db, 'order.status_changed', id))[0]!.payload).toMatchObject({
      fromStatus: 'pending',
      toStatus: 'rejected',
    });
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    // The order says it cannot be cancelled any more, and a second call is refused.
    expect(json(await portal.get(`/client/orders/${id}`)).canCancel).toBe(false);
    expect(json(await portal.post(`/client/orders/${id}/cancel`)).code).toBe('ORDER_NOT_OPEN');
  });

  it('cancels a manual order, and refuses an order already sent to a supplier (ALREADY_SENT)', async () => {
    const { db, merchant, auto } = world;
    const portal = await portalFor(t, merchant.id);
    const manualId = await cancellable('manual');
    expect((await portal.post(`/client/orders/${manualId}/cancel`)).statusCode).toBe(204);
    const sent = await cancellable('auto');
    await db.update(s.orders).set({ status: 'processing', dispatchState: 'sent' }).where(eq(s.orders.id, sent));
    const refused = await portal.post(`/client/orders/${sent}/cancel`);
    expect(refused.statusCode).toBe(409);
    expect(json(refused).code).toBe('ALREADY_SENT');
    expect((await orderRow(db, sent)).status).toBe('processing');
    expect(auto.serviceId).toBeGreaterThan(0);
  });

  it('refuses when the service does not allow cancellation, and an order staff are already working on', async () => {
    const { db, merchant, auto, manual } = world;
    const portal = await portalFor(t, merchant.id);
    const id = await place(auto.serviceId);
    const refused = await portal.post(`/client/orders/${id}/cancel`);
    expect(refused.statusCode).toBe(409);
    expect(json(refused)).toMatchObject({
      code: 'INVALID_TRANSITION',
      detail: 'This service does not allow cancellation.',
    });
    expect(json(await portal.get(`/client/orders/${id}`)).canCancel).toBe(false);

    await db.update(s.services).set({ allowCancel: true }).where(eq(s.services.id, manual.serviceId));
    const accepted = await place(manual.serviceId, IMEIS[1]);
    await staff.post(`/admin/orders/${accepted}/accept`, {});
    const working = await portal.post(`/client/orders/${accepted}/cancel`);
    expect(working.statusCode).toBe(409);
    expect(json(working).code).toBe('INVALID_TRANSITION');
    expect((await orderRow(db, accepted)).status).toBe('processing');
  });
});

describe('GET /client/orders/export', () => {
  it('exports the merchant orders as CSV with no cost and no supplier, protected against formulas', async () => {
    const { merchant, auto, server, db } = world;
    const first = await place(auto.serviceId, IMEIS[0]);
    const portal = await portalFor(t, merchant.id);
    const formula = await portal.post('/client/orders', {
      serviceId: server.serviceId,
      inputs: { username: '=HYPERLINK("http://x")' },
    });
    expect(formula.statusCode).toBe(201);
    await place(auto.serviceId, IMEIS[1], world.other.id);
    const res = await portal.get('/client/orders/export?_sort=id&_order=asc');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="orders.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe('id,created,service,input,quantity,status,price,currency');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      `${first},${(await orderRow(db, first)).createdAt.toISOString()},AT&T USA Premier Unlock,${IMEIS[0]},1,pending,17.2800,USD`,
    );
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(res.body).not.toMatch(/13\.5|Supplier/);
    const filtered = await portal.get('/client/orders/export?status=completed');
    expect(filtered.body).toBe('id,created,service,input,quantity,status,price,currency\r\n');
  });
});
