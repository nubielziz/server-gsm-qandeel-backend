// Integration tests of the admin order reads (feature 5): GET /admin/orders (filters, derived queue, past-SLA predicate, search, sorts,
// ranges, x-total-count), GET /admin/orders/:id and GET /admin/orders/:id/events, on the real application.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import {
  ORDER_DISPATCH_STATES,
  ORDER_STATUSES,
  ORDER_VERIFICATION_STATUSES,
  deriveQueue,
  type OrderDispatchState,
  type OrderStatus,
  type OrderVerificationStatus,
} from '@src/modules/orders';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { IMEIS, insertOrderRow, type OrdersWorld, ordersWorld } from '../../support/orders';

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
  staff = await adminWith(t, ['orders:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ids = (rows: Array<{ id: number }>): number[] => rows.map((row) => row.id);

/** Orders in each state of the console's tabs: five orders held from merchant wallets and two shop orders of one guest account. */
async function seedStates() {
  const { db, merchant, other, auto, manual } = world;
  // The buyer of the shop orders: a guest row of the one retail rank (a checkout typed with an address, no login).
  const buyer = await makeAccount({
    rank: 'retail',
    guest: true,
    email: 'Hannah.Weber@example.com',
    name: 'Hannah Weber',
    db,
  });
  const buyerId = buyer.id;
  const pending = await insertOrderRow(db, {
    accountId: merchant.id,
    serviceId: auto.serviceId,
    imei: IMEIS[0],
    dispatchState: 'pending',
  });
  const manualOrder = await insertOrderRow(db, {
    accountId: merchant.id,
    serviceId: manual.serviceId,
    imei: IMEIS[1],
    dispatchState: 'manual',
  });
  const attention = await insertOrderRow(db, {
    accountId: other.id,
    serviceId: auto.serviceId,
    imei: IMEIS[2],
    status: 'processing',
    dispatchState: 'needs_attention',
    supplierId: auto.supplierId,
    supplierRef: 'NG-77',
  });
  const verifying = await insertOrderRow(db, {
    accountId: other.id,
    serviceId: auto.serviceId,
    imei: IMEIS[3],
    status: 'completed',
    dispatchState: 'done',
    verificationStatus: 'requested',
    completedAt: new Date(),
  });
  const held = await insertOrderRow(db, {
    accountId: buyerId,
    serviceId: auto.serviceId,
    imei: IMEIS[4],
    source: 'store',
    dispatchState: 'held',
    currency: 'USD',
  });
  const processing = await insertOrderRow(db, {
    accountId: merchant.id,
    serviceId: auto.serviceId,
    imei: '111',
    status: 'processing',
    dispatchState: 'sent',
  });
  const completed = await insertOrderRow(db, {
    accountId: buyerId,
    serviceId: auto.serviceId,
    imei: '222',
    source: 'store',
    status: 'completed',
    dispatchState: 'done',
  });
  const rejected = await insertOrderRow(db, {
    accountId: other.id,
    serviceId: manual.serviceId,
    imei: '333',
    status: 'rejected',
    dispatchState: 'done',
  });
  return { pending, manualOrder, attention, verifying, held, processing, completed, rejected, buyerId };
}

describe('GET /admin/orders: shape and queues', () => {
  it('sends the console row: joined names, derived queue, review reason, attempts and the main input as a string', async () => {
    const { db, merchant, auto } = world;
    const order = await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: auto.serviceId,
      imei: null,
      status: 'processing',
      dispatchState: 'needs_attention',
      supplierId: auto.supplierId,
      supplierRef: 'NG-77',
      resultCode: 'x',
      inputs: { device: 'iPhone 12' },
    });
    await db.insert(s.orderEvents).values([
      { orderId: order.id, type: 'dispatch', actorType: 'system', data: { message: 'Sent' } },
      { orderId: order.id, type: 'dispatch', actorType: 'system', data: { message: 'Sent again' } },
      {
        orderId: order.id,
        type: 'review',
        actorType: 'system',
        data: { message: 'Supplier did not answer', reason: 'Supplier did not answer' },
      },
    ]);
    const res = await staff.get('/admin/orders');
    expect(res.status).toBe(200);
    expect(res.total).toBe(1);
    expect(res.body[0]).toMatchObject({
      id: order.id,
      status: 'processing',
      queue: 'needs_attention',
      reviewReason: 'Supplier did not answer',
      dispatchState: 'needs_attention',
      channel: 'b2b',
      source: 'portal',
      imei: '',
      attempts: 2,
      inputs: { device: 'iPhone 12' },
      service: {
        id: auto.serviceId,
        name: 'AT&T USA Premier Unlock',
        type: 'imei',
        slaMinutes: 60,
        category: 'Carrier unlock',
      },
      account: {
        id: merchant.id,
        name: 'Cairo GSM Lab',
        email: expect.stringContaining('•'),
        rank: { id: expect.any(Number), name: expect.any(String), kind: 'merchant' },
        guest: false,
      },
      supplier: { id: auto.supplierId },
      supplierRef: 'NG-77',
      result: { code: 'x', comment: null, fileId: null },
      verificationStatus: null,
      completedAt: null,
      sentAt: null,
    });
    expect(res.body[0].createdAt).toBe(order.createdAt.toISOString());
    // One buyer field replaces the two of the old model: nothing is sent under the old names (decision 064, no compatibility fields).
    expect(res.body[0]).not.toHaveProperty('client');
    expect(res.body[0]).not.toHaveProperty('customer');
  });

  it('names the buyer of a shop order the same way: a guest row of the retail rank, whatever door the order came through', async () => {
    const o = await seedStates();
    const row = (await staff.get(`/admin/orders/${o.held.id}`)).body;
    expect(row).toMatchObject({
      source: 'store',
      channel: 'b2c',
      account: {
        id: o.buyerId,
        name: 'Hannah Weber',
        rank: { id: expect.any(Number), name: expect.any(String), kind: 'retail' },
        guest: true,
      },
    });
    expect(row).not.toHaveProperty('customer');
  });

  it('derives the five queues and filters by them', async () => {
    const o = await seedStates();
    const queue = async (name: string) => ids((await staff.get(`/admin/orders?queue=${name}`)).body);
    expect(await queue('pending')).toEqual([o.pending.id]);
    expect(await queue('manual')).toEqual([o.manualOrder.id]);
    expect(await queue('needs_attention')).toEqual([o.attention.id]);
    expect(await queue('verification')).toEqual([o.verifying.id]);
    expect(await queue('review')).toEqual([o.held.id]);
    const several = await staff.get('/admin/orders?queue=manual&queue=review&_sort=id&_order=asc');
    expect(ids(several.body)).toEqual([o.manualOrder.id, o.held.id]);
    expect(several.total).toBe(2);
    const all = (await staff.get('/admin/orders?_end=100')).body as Array<{ id: number; queue: string | null }>;
    expect(all.find((row) => row.id === o.processing.id)!.queue).toBeNull();
    expect(all.find((row) => row.id === o.completed.id)!.queue).toBeNull();
  });

  it('gives the reason of the event that opened the queue, and none outside a queue', async () => {
    const o = await seedStates();
    const { db } = world;
    await db.insert(s.orderEvents).values([
      {
        orderId: o.manualOrder.id,
        type: 'review',
        actorType: 'system',
        data: { reason: 'Manual service: operator dispatch required' },
      },
      {
        orderId: o.verifying.id,
        type: 'verification',
        actorType: 'account',
        actorId: world.other.id,
        data: { reason: 'The merchant asked for the result to be checked' },
      },
      { orderId: o.pending.id, type: 'review', actorType: 'system', data: { reason: 'An old reason' } },
    ]);
    const rows = (await staff.get('/admin/orders?_end=100')).body as Array<{ id: number; reviewReason: string | null }>;
    const reason = (id: number) => rows.find((row) => row.id === id)!.reviewReason;
    expect(reason(o.manualOrder.id)).toBe('Manual service: operator dispatch required');
    expect(reason(o.verifying.id)).toBe('The merchant asked for the result to be checked');
    // `pending` is a queue without a stored reason, and a stale event must not leak into it.
    expect(reason(o.pending.id)).toBeNull();
    expect(reason(o.attention.id)).toBeNull();
  });

  it('computes the queue in SQL exactly as the state machine does, for every combination of states', async () => {
    const { db, merchant, auto } = world;
    const combos: Array<[OrderStatus, OrderDispatchState, OrderVerificationStatus | null]> = [];
    for (const status of ORDER_STATUSES) {
      for (const dispatch of ORDER_DISPATCH_STATES) {
        for (const verification of [null, ...ORDER_VERIFICATION_STATUSES])
          combos.push([status, dispatch, verification]);
      }
    }
    const rows = await db
      .insert(s.orders)
      .values(
        combos.map(([status, dispatchState, verificationStatus], index) => ({
          accountId: merchant.id,
          legacyClientId: merchant.id,
          serviceId: auto.serviceId,
          type: 'imei' as const,
          source: 'portal' as const,
          imei: String(index),
          unitPrice: '1.0000',
          totalPrice: '1.0000',
          currency: 'USD',
          status,
          dispatchState,
          verificationStatus,
        })),
      )
      .returning({ id: s.orders.id });
    const expected = new Map(
      rows.map((row, index) => [
        row.id,
        deriveQueue({
          status: combos[index]![0],
          dispatchState: combos[index]![1],
          verificationStatus: combos[index]![2],
        }),
      ]),
    );
    const listed = (await staff.get('/admin/orders?_end=500')).body as Array<{ id: number; queue: string | null }>;
    expect(listed).toHaveLength(combos.length);
    for (const row of listed) expect(row.queue).toBe(expected.get(row.id) ?? null);
    // And the filter agrees with the derivation.
    for (const queue of ['pending', 'manual', 'needs_attention', 'verification', 'review']) {
      const filtered = await staff.get(`/admin/orders?queue=${queue}&_end=500`);
      expect(new Set(ids(filtered.body))).toEqual(
        new Set([...expected].filter(([, q]) => q === queue).map(([id]) => id)),
      );
    }
  });
});

describe('GET /admin/orders: filters, search, sorts and ranges', () => {
  it('filters by status (repeat for IN), type, account, rank, supplier and channel', async () => {
    const o = await seedStates();
    const { db, merchant, other, auto } = world;
    const get = async (query: string) =>
      ids((await staff.get(`/admin/orders?${query}&_sort=id&_order=asc&_end=100`)).body);
    expect(await get('status=completed')).toEqual([o.verifying.id, o.completed.id]);
    expect(await get('status=completed&status=rejected')).toEqual([o.verifying.id, o.completed.id, o.rejected.id]);
    expect(await get('type=imei')).toHaveLength(8);
    // `accountId` lists the orders of an account of either rank, through every door; `clientId` is only another name for it.
    expect(await get(`accountId=${other.id}`)).toEqual([o.attention.id, o.verifying.id, o.rejected.id]);
    expect(await get(`clientId=${other.id}`)).toEqual([o.attention.id, o.verifying.id, o.rejected.id]);
    expect(await get(`accountId=${merchant.id}&status=processing`)).toEqual([o.processing.id]);
    expect(await get(`accountId=${o.buyerId}`)).toEqual([o.held.id, o.completed.id]);
    // `rankId` is the rank the buyer holds now.
    const rankOf = async (id: number) =>
      (await db.select({ groupId: s.clients.groupId }).from(s.clients).where(eq(s.clients.id, id)))[0]!.groupId;
    expect(await get(`rankId=${await rankOf(o.buyerId)}`)).toEqual([o.held.id, o.completed.id]);
    expect(await get(`rankId=${await rankOf(merchant.id)}`)).toEqual([o.pending.id, o.manualOrder.id, o.processing.id]);
    expect(await get(`supplierId=${auto.supplierId}`)).toEqual([o.attention.id]);
    expect(await get('channel=b2c')).toEqual([o.held.id, o.completed.id]);
    expect(await get('channel=b2b')).toHaveLength(6);
  });

  it('searches the input, supplier reference and names, and the order id exactly', async () => {
    const o = await seedStates();
    const q = async (text: string) =>
      ids((await staff.get(`/admin/orders?q=${encodeURIComponent(text)}&_sort=id&_order=asc`)).body);
    expect(await q(IMEIS[0])).toEqual([o.pending.id]);
    expect(await q('352905')).toEqual([o.pending.id]);
    expect(await q('ng-77')).toEqual([o.attention.id]);
    expect(await q('erbil')).toEqual([o.attention.id, o.verifying.id, o.rejected.id]);
    expect(await q('hannah weber')).toEqual([o.held.id, o.completed.id]);
    expect(await q('manual unlock')).toEqual([o.manualOrder.id, o.rejected.id]);
    // A number that is an order id matches that order exactly (plus any input that contains it).
    expect(await q(String(o.completed.id))).toContain(o.completed.id);
    expect(await q('999999999')).toEqual([]);
    // `%` and `_` match themselves.
    expect(await q('%')).toEqual([]);
  });

  it('sorts by createdAt (newest first by default), totalPrice and status, and pages with an exact total', async () => {
    const { db, merchant, auto } = world;
    const base = Date.now();
    const rows = [];
    for (const [index, price] of ['30.0000', '10.0000', '20.0000'].entries()) {
      rows.push(
        await insertOrderRow(db, {
          accountId: merchant.id,
          serviceId: auto.serviceId,
          imei: String(index),
          totalPrice: price,
          unitPrice: price,
          createdAt: new Date(base - index * 1000),
        }),
      );
    }
    expect(ids((await staff.get('/admin/orders')).body)).toEqual(ids(rows));
    expect(ids((await staff.get('/admin/orders?_sort=totalPrice&_order=asc')).body)).toEqual([
      rows[1]!.id,
      rows[2]!.id,
      rows[0]!.id,
    ]);
    expect(ids((await staff.get('/admin/orders?_sort=createdAt&_order=asc')).body)).toEqual([...ids(rows)].reverse());
    const page = await staff.get('/admin/orders?_start=1&_end=2');
    expect(ids(page.body)).toEqual([rows[1]!.id]);
    expect(page.total).toBe(3);
    const none = await staff.get(`/admin/orders?accountId=${world.other.id}`);
    expect(none.body).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('answers 422 to the retired customerId filter (the buyer is one account, filter it with accountId)', async () => {
    const o = await seedStates();
    const res = await staff.get(`/admin/orders?customerId=${o.buyerId}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an unknown sort, an unknown filter value and an unknown parameter with 422', async () => {
    for (const query of [
      '_sort=supplier',
      'queue=bogus',
      'status=queued',
      'colour=red',
      'pastSla=maybe',
      'channel=b2x',
      'clientId=abc',
      'accountId=abc',
      'rankId=abc',
    ]) {
      const res = await staff.get(`/admin/orders?${query}`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('GET /admin/orders?pastSla=true: the one age-only predicate (B92)', () => {
  it('lists open orders older than their service SLA, whatever their queue, and never closed or fresh ones', async () => {
    const o = await seedStates();
    expect((await staff.get('/admin/orders?pastSla=true')).body).toEqual([]);
    clock.advance(61 * MINUTE);
    // The sign-in of an hour ago has gone idle: a member who signs in now reads the orders.
    staff = await adminWith(t, ['orders:read']);
    // sla is 60 minutes for the automatic service and 120 for the manual one.
    const late = async (query = '') =>
      ids((await staff.get(`/admin/orders?pastSla=true${query}&_sort=id&_order=asc`)).body);
    expect(await late()).toEqual([o.pending.id, o.attention.id, o.held.id, o.processing.id]);
    // The System health link: needs attention and past SLA lists the order (M230).
    expect(await late('&queue=needs_attention')).toEqual([o.attention.id]);
    clock.advance(60 * MINUTE);
    staff = await adminWith(t, ['orders:read']);
    expect(await late()).toContain(o.manualOrder.id);
    expect(await late()).not.toContain(o.completed.id);
    expect(await late()).not.toContain(o.rejected.id);
    expect(await late()).not.toContain(o.verifying.id);
    const notLate = ids((await staff.get('/admin/orders?pastSla=false&_end=100')).body);
    expect(notLate).toEqual(expect.arrayContaining([o.completed.id, o.rejected.id, o.verifying.id]));
    expect(notLate).not.toContain(o.pending.id);
  });
});

describe('GET /admin/orders/:id and /events', () => {
  it('shows one order like a list row, and answers 404 for an unknown id', async () => {
    const { db, merchant, auto } = world;
    const order = await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId });
    const list = (await staff.get('/admin/orders')).body[0];
    const one = await staff.get(`/admin/orders/${order.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(list);
    const missing = await staff.get('/admin/orders/999999');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
    expect((await staff.get('/admin/orders/abc')).status).toBe(422);
  });

  it('still reads an order stored with the retired source admin, and sends no client note field', async () => {
    const { db, merchant, auto } = world;
    const order = await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId, source: 'admin' });
    await db.update(s.orders).set({ clientNote: 'old note' }).where(eq(s.orders.id, order.id));
    const one = await staff.get(`/admin/orders/${order.id}`);
    expect(one.status).toBe(200);
    expect(one.body.source).toBe('admin');
    expect(one.body).not.toHaveProperty('clientNote');
    expect((await staff.get('/admin/orders')).body[0]).not.toHaveProperty('clientNote');
  });

  it('lists the timeline oldest first with the actor names joined, notes included', async () => {
    const { db, merchant, auto } = world;
    const order = await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId });
    await db.insert(s.orderEvents).values([
      {
        orderId: order.id,
        type: 'created',
        actorType: 'account',
        actorId: merchant.id,
        data: { message: 'Order received via Portal' },
      },
      { orderId: order.id, type: 'hold', actorType: 'system', data: { message: 'held' } },
      {
        orderId: order.id,
        type: 'ack',
        actorType: 'supplier',
        actorId: auto.supplierId,
        data: { message: 'Accepted by supplier' },
      },
      { orderId: order.id, type: 'note', actorType: 'staff', actorId: staff.staffId, data: { body: 'Called' } },
    ]);
    const res = await staff.get(`/admin/orders/${order.id}/events`);
    expect(res.status).toBe(200);
    expect(res.body.map((event: { type: string }) => event.type)).toEqual(['created', 'hold', 'ack', 'note']);
    expect(res.body[0].actor).toEqual({ type: 'account', id: merchant.id, name: 'Cairo GSM Lab' });
    expect(res.body[0].account).toEqual({ id: merchant.id });
    expect(res.body[1].actor).toEqual({ type: 'system', id: null, name: null });
    expect(res.body[1].account).toBeNull();
    expect(res.body[3].account).toBeNull();
    expect(res.body[2].actor).toMatchObject({ type: 'supplier', id: auto.supplierId });
    expect(res.body[2].actor.name).toMatch(/^Supplier /);
    expect(res.body[3].actor).toEqual({ type: 'staff', id: staff.staffId, name: 'Test Staff' });
    expect(res.body[3].data).toEqual({ body: 'Called' });
    expect(res.body.every((event: { createdAt: string }) => /Z$/.test(event.createdAt))).toBe(true);
    expect((await staff.get('/admin/orders/999999/events')).status).toBe(404);
  });
});

describe("the buyer's address (decision 047)", () => {
  it('shows the address of the buyer account masked without clients:read and in full with it, whatever its rank', async () => {
    const o = await seedStates();
    const emails = async (api: AdminApi) => {
      const list = await api.get(`/admin/orders?accountId=${o.buyerId}&_sort=id&_order=asc`);
      const one = await api.get(`/admin/orders/${o.completed.id}`);
      expect(list.status).toBe(200);
      expect(one.status).toBe(200);
      return [...list.body, one.body].map((row: { account: { email: string } }) => row.account.email);
    };
    expect(await emails(staff)).toEqual(Array(3).fill('Ha•••@example.com'));
    const reader = await adminWith(t, ['orders:read', 'clients:read']);
    expect(await emails(reader)).toEqual(Array(3).fill('Hannah.Weber@example.com'));
    // A wildcard of the area, and the owner, read it in full too; the name is not changed for anybody.
    expect((await emails(await adminWith(t, ['orders:*', 'clients:*'])))[0]).toBe('Hannah.Weber@example.com');
    expect((await emails(await adminWith(t, ['*'])))[0]).toBe('Hannah.Weber@example.com');
    expect((await staff.get(`/admin/orders/${o.completed.id}`)).body.account.name).toBe('Hannah Weber');
    // The address of a merchant's account is masked the same way (one rule for every account).
    expect((await staff.get(`/admin/orders/${o.pending.id}`)).body.account.email).toContain('•');
    const full = await adminWith(t, ['orders:read', 'clients:read']);
    expect((await full.get(`/admin/orders/${o.pending.id}`)).body.account.email).not.toContain('•');
  });
});

describe('access', () => {
  it('needs orders:read and a session on every read', async () => {
    const { db, merchant, auto } = world;
    const order = await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId });
    const nobody = await adminWith(t, ['staff:read']);
    for (const url of [
      '/admin/orders',
      `/admin/orders/${order.id}`,
      `/admin/orders/${order.id}/events`,
      '/admin/orders/export',
    ]) {
      expect((await nobody.get(url)).status).toBe(403);
      expect((await staff.anonymous('GET', url)).status).toBe(401);
    }
    await db.update(s.orders).set({ adminNote: 'x' }).where(eq(s.orders.id, order.id));
  });
});
