// The staff order actions that involve a supplier and the status poll (feature 6): `dispatch`, `fetch` and `change-supplier` through
// HTTP (state machine of decision 025, resolutions orders-suppliers-11, -12, -17, -19) and `SupplierPoll` (the poll of a sent order and
// the tick that finds the orders due for one). Real Postgres and Redis, the fake Dhru supplier.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { SupplierDispatch, SupplierPoll } from '../../src/modules/suppliers';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertService } from '../support/catalog';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { fundWallet } from '../support/money';
import {
  IMEIS,
  auditOf,
  eventsOf,
  insertOrderRow,
  json,
  orderRow,
  ordersWorld,
  outboxOf,
  portalFor,
  type OrdersWorld,
  walletOf,
} from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService, logsOf } from '../support/suppliers';

const fake = new FakeDhruSupplier();
const clock = new TestClock();
const prefix = testBullPrefix();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let dispatch: SupplierDispatch;
let poll: SupplierPoll;
let supplierId: number;
let serviceId: number;
let sequence = 0;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [SupplierTestModule], env: { BULL_PREFIX: prefix } });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*', 'suppliers:*'], { name: 'Lina S.' });
  dispatch = t.app.get(SupplierDispatch, { strict: false });
  poll = t.app.get(SupplierPoll, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  const redis = t.app.get(RedisService, { strict: false });
  await deleteBullKeys(redis.queue, prefix);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  fake.reset();
  clock.reset();
  await fundWallet(world.db, world.merchant.id, '100');
});

/** A fresh automatic service (price 17.28, link credit 13.50) and a fresh fake-backed supplier. */
async function freshRoute(credit = '13.5000') {
  const { db } = world;
  supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
  sequence += 1;
  serviceId = await insertService(db, world.auto.categoryId, {
    name: `Action route ${sequence}`,
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
  });
  await linkService(db, serviceId, supplierId, { credit });
}

/** Places an order through the portal. */
async function place(imei: string = IMEIS[0]): Promise<number> {
  const portal = await portalFor(t, world.merchant.id);
  const res = await portal.post('/client/orders', { serviceId, imei });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

/** Places an order and sends it: it is `sent` with the fake's reference. */
async function placeAndSend(imei: string = IMEIS[0]): Promise<{ orderId: number; reference: string }> {
  const orderId = await place(imei);
  expect((await dispatch.run(orderId, { lastAttempt: false })).status).toBe('sent');
  return { orderId, reference: (await orderRow(world.db, orderId)).supplierRef! };
}

/** Places an order whose first send is refused, so it waits in needs_attention. */
async function placeRefused(imei: string = IMEIS[0]): Promise<number> {
  fake.place({ refuse: 'Not enough credits' });
  const orderId = await place(imei);
  expect((await dispatch.run(orderId, { lastAttempt: false })).status).toBe('needs_attention');
  return orderId;
}

const post = (orderId: number, action: string, body: unknown = {}) =>
  staff.post(`/admin/orders/${orderId}/${action}`, body);

describe('POST /admin/orders/:id/dispatch', () => {
  it('sends a needs_attention order again: pending, the job queued, attempts counted, audited, and the job then sends it', async () => {
    await freshRoute();
    const orderId = await placeRefused();
    const before = await orderRow(world.db, orderId);
    expect(before.sentAt).not.toBeNull();

    const res = await post(orderId, 'dispatch');
    expect(res.status).toBe(204);
    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({ status: 'pending', dispatchState: 'pending', sentAt: null, supplierId });
    expect(order.supplierServiceId).toBe(before.supplierServiceId);
    const events = await eventsOf(world.db, orderId);
    expect(events.at(-1)).toMatchObject({ type: 'retry', actorType: 'staff', actorId: staff.staffId });
    expect(events.at(-1)!.data).toMatchObject({ supplier: expect.any(String) });
    expect(await outboxOf(world.db, 'order.dispatch_requested', orderId)).toHaveLength(2);
    const audit = (await auditOf(world.db, orderId)).at(-1)!;
    expect(audit).toMatchObject({ action: 'dispatched order', entityType: 'order', actorType: 'staff' });
    expect((await staff.get(`/admin/orders/${orderId}`)).body).toMatchObject({ queue: 'pending', attempts: 1 });

    expect((await dispatch.run(orderId, { lastAttempt: false })).status).toBe('sent');
    expect(fake.callsOf('placeimeiorder')).toHaveLength(2);
    expect((await staff.get(`/admin/orders/${orderId}`)).body).toMatchObject({
      queue: null,
      status: 'processing',
      attempts: 2,
    });
  });

  it('is a 204 that changes nothing for an order already waiting for the job', async () => {
    await freshRoute();
    const orderId = await place();
    const outboxBefore = (await outboxOf(world.db, 'order.dispatch_requested', orderId)).length;
    const eventsBefore = (await eventsOf(world.db, orderId)).length;
    expect((await post(orderId, 'dispatch')).status).toBe(204);
    expect((await outboxOf(world.db, 'order.dispatch_requested', orderId)).length).toBe(outboxBefore);
    expect((await eventsOf(world.db, orderId)).length).toBe(eventsBefore);
  });

  it('refuses: an order the supplier already has (ALREADY_SENT), a closed one, a held one, an unknown one', async () => {
    await freshRoute();
    const { orderId } = await placeAndSend();
    const sent = await post(orderId, 'dispatch');
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({
      code: 'ALREADY_SENT',
      detail: expect.stringContaining('fetch it, or change supplier'),
    });
    await world.db.update(s.orders).set({ status: 'completed', dispatchState: 'done' }).where(eq(s.orders.id, orderId));
    expect((await post(orderId, 'dispatch')).body).toMatchObject({ code: 'ORDER_NOT_OPEN' });
    const held = await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      status: 'pending',
      dispatchState: 'held',
    });
    expect((await post(held.id, 'dispatch')).body).toMatchObject({ code: 'ORDER_HELD' });
    expect((await post(999_999, 'dispatch')).status).toBe(404);
  });

  it('says NO_SUPPLIER when the service has no active link and the order has no supplier', async () => {
    const manual = await insertOrderRow(world.db, {
      serviceId: world.manual.serviceId,
      clientId: world.merchant.id,
      status: 'pending',
      dispatchState: 'manual',
    });
    const res = await post(manual.id, 'dispatch');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NO_SUPPLIER' });
  });

  it('says SUPPLIER_DISABLED when the supplier of the order is paused, or every linked supplier is', async () => {
    await freshRoute();
    const orderId = await placeRefused();
    await world.db.update(s.suppliers).set({ status: 'paused' }).where(eq(s.suppliers.id, supplierId));
    expect((await post(orderId, 'dispatch')).body).toMatchObject({ code: 'SUPPLIER_DISABLED' });

    const unassigned = await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      status: 'pending',
      dispatchState: 'manual',
      imei: IMEIS[1],
    });
    expect((await post(unassigned.id, 'dispatch')).body).toMatchObject({ code: 'SUPPLIER_DISABLED' });
  });

  it('sends a manual order to the first active link, even a costlier one: no price-protection limit on a staff dispatch', async () => {
    await freshRoute('25.0000');
    const manual = await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      status: 'pending',
      dispatchState: 'manual',
      unitPrice: '17.2800',
      totalPrice: '17.2800',
    });
    expect((await post(manual.id, 'dispatch')).status).toBe(204);
    expect(await orderRow(world.db, manual.id)).toMatchObject({
      dispatchState: 'pending',
      supplierId,
      unitCost: '25.0000',
      totalCost: '25.0000',
    });
    expect((await dispatch.run(manual.id, { lastAttempt: false })).status).toBe('sent');
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
  });

  it('needs orders:update', async () => {
    await freshRoute();
    const orderId = await placeRefused();
    const reader = await adminWith(t, ['orders:read']);
    expect((await reader.post(`/admin/orders/${orderId}/dispatch`, {})).status).toBe(403);
  });
});

describe('POST /admin/orders/:id/fetch', () => {
  it('has nothing to fetch for an order no supplier accepted (NO_REFERENCE), and refuses a closed one', async () => {
    await freshRoute();
    const orderId = await placeRefused();
    const res = await post(orderId, 'fetch');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NO_REFERENCE' });
    await world.db.update(s.orders).set({ status: 'rejected', dispatchState: 'done' }).where(eq(s.orders.id, orderId));
    expect((await post(orderId, 'fetch')).body).toMatchObject({ code: 'ORDER_NOT_OPEN' });
    expect((await post(999_999, 'fetch')).status).toBe(404);
  });

  it("completes the order with the supplier's CODE on STATUS 4, books the supplier cost and settles the hold", async () => {
    await freshRoute();
    const { orderId, reference } = await placeAndSend();
    fake.finish(reference, 4, 'Unlocked: code 8842 1113');
    const walletBefore = await walletOf(world.db, world.merchant.id);
    const res = await post(orderId, 'fetch');
    expect(res.status).toBe(204);

    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({
      status: 'completed',
      dispatchState: 'done',
      resultCode: 'Unlocked: code 8842 1113',
      supplierRef: reference,
    });
    expect(order.completedAt).not.toBeNull();
    const events = await eventsOf(world.db, orderId);
    expect(events.map((event) => event.type).slice(-2)).toEqual(['completed', 'settle']);
    expect(events.at(-2)).toMatchObject({
      actorType: 'supplier',
      actorId: supplierId,
      data: { message: 'Completed by the supplier' },
    });
    expect(events.at(-1)!.data).toMatchObject({ revenue: '17.2800', cost: '13.5000' });
    const walletAfter = await walletOf(world.db, world.merchant.id);
    expect(new Decimal(walletBefore.hold).minus(walletAfter.hold).toFixed(4)).toBe('17.2800');
    expect(
      (await outboxOf(world.db, 'order.status_changed', orderId)).map(
        (row) => (row.payload as { toStatus: string }).toStatus,
      ),
    ).toEqual(['processing', 'completed']);
    expect((await auditOf(world.db, orderId)).at(-1)).toMatchObject({ action: 'fetched supplier result of' });
    const [, log] = await logsOf(world.db, supplierId);
    expect(log).toMatchObject({ orderId, action: 'getimeiorder', httpStatus: 200, outcome: 'ok' });
  });

  it("rejects the order on STATUS 3 with the supplier's reason and gives the hold back with no cost", async () => {
    await freshRoute();
    const { orderId, reference } = await placeAndSend();
    fake.finish(reference, 3, 'IMEI not supported');
    const walletBefore = await walletOf(world.db, world.merchant.id);
    expect((await post(orderId, 'fetch')).status).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'rejected',
      dispatchState: 'done',
      resultCode: 'IMEI not supported',
    });
    const events = await eventsOf(world.db, orderId);
    expect(events.map((event) => event.type).slice(-2)).toEqual(['rejected', 'release']);
    expect(events.at(-2)!.data).toMatchObject({ reason: 'IMEI not supported' });
    const walletAfter = await walletOf(world.db, world.merchant.id);
    expect(new Decimal(walletBefore.hold).minus(walletAfter.hold).toFixed(4)).toBe('17.2800');
    expect(new Decimal(walletAfter.wallet).minus(walletBefore.wallet).toFixed(4)).toBe('17.2800');
  });

  it('writes the fetch event "Supplier has not finished yet" while the supplier still runs it, and the order stays sent', async () => {
    await freshRoute();
    const { orderId } = await placeAndSend();
    expect((await post(orderId, 'fetch')).status).toBe(204);
    const events = await eventsOf(world.db, orderId);
    expect(events.at(-1)).toMatchObject({
      type: 'fetch',
      actorType: 'staff',
      data: { message: 'Supplier has not finished yet' },
    });
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'sent', status: 'processing' });
    expect((await auditOf(world.db, orderId)).at(-1)).toMatchObject({ action: 'fetched supplier result of' });
  });

  it('brings a needs_attention order that the supplier has back to sent (scenario timeout step 10)', async () => {
    await freshRoute();
    const { orderId } = await placeAndSend();
    await world.db.update(s.orders).set({ dispatchState: 'needs_attention' }).where(eq(s.orders.id, orderId));
    expect((await post(orderId, 'fetch')).status).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'sent' });
    expect((await eventsOf(world.db, orderId)).at(-1)).toMatchObject({ type: 'fetch' });
  });

  it('answers SUPPLIER_UNAVAILABLE when the supplier cannot be reached, and leaves the order as it is', async () => {
    await freshRoute();
    const { orderId } = await placeAndSend();
    fake.forceHttp = 503;
    const res = await post(orderId, 'fetch');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SUPPLIER_UNAVAILABLE', detail: expect.stringContaining('HTTP 503') });
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'sent' });
    expect((await logsOf(world.db, supplierId)).at(-1)).toMatchObject({
      action: 'getimeiorder',
      httpStatus: 503,
      outcome: 'error',
    });
  });
});

describe('POST /admin/orders/:id/change-supplier', () => {
  /** A second supplier for the same service (credit 14.00), returned with its supplier service. */
  async function secondSupplier(credit = '14.0000') {
    const second = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake, {
      name: `Second ${sequence}`,
    });
    const link = await linkService(world.db, serviceId, second, { remoteId: '9001', priority: 2, credit });
    return { second, link };
  }

  it('needs a supplier or a reference reset (422 on supplierId)', async () => {
    await freshRoute();
    const orderId = await placeRefused();
    const res = await post(orderId, 'change-supplier', {});
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ field: 'supplierId', message: 'Choose a supplier or reset the reference.' }),
    ]);
  });

  it('refuses an unknown supplier and a supplier the service has no active link to (422), and a paused target (409)', async () => {
    await freshRoute();
    const orderId = await placeRefused();
    expect((await post(orderId, 'change-supplier', { supplierId: 999_999 })).body.errors[0]).toMatchObject({
      field: 'supplierId',
    });
    const stranger = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    const noLink = await post(orderId, 'change-supplier', { supplierId: stranger });
    expect(noLink.status).toBe(422);
    expect(noLink.body.errors[0]).toMatchObject({ field: 'supplierId' });
    const { second } = await secondSupplier();
    await world.db.update(s.suppliers).set({ status: 'paused' }).where(eq(s.suppliers.id, second));
    expect((await post(orderId, 'change-supplier', { supplierId: second })).body).toMatchObject({
      code: 'SUPPLIER_DISABLED',
    });
  });

  it('points a sent order at another supplier: the reference is reset, the cost refreshed from the new link, the state needs attention', async () => {
    await freshRoute();
    const { orderId } = await placeAndSend();
    const { second, link } = await secondSupplier('14.0000');
    const res = await post(orderId, 'change-supplier', { supplierId: second, resetReference: true });
    expect(res.status).toBe(204);

    expect(await orderRow(world.db, orderId)).toMatchObject({
      supplierId: second,
      supplierServiceId: link.supplierServiceId,
      supplierRef: null,
      unitCost: '14.0000',
      totalCost: '14.0000',
      dispatchState: 'needs_attention',
      status: 'processing',
    });
    const event = (await eventsOf(world.db, orderId)).at(-1)!;
    expect(event).toMatchObject({ type: 'supplier_changed', actorType: 'staff' });
    expect(event.data).toMatchObject({
      fromSupplierId: supplierId,
      toSupplierId: second,
      resetReference: true,
      costAbovePrice: false,
    });
    expect((await auditOf(world.db, orderId)).at(-1)).toMatchObject({ action: 'changed supplier of' });
    // Nothing was sent to either supplier.
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
  });

  it('allows a costlier link for staff and records costAbovePrice in the event; dispatch: true queues the job in the same transaction', async () => {
    await freshRoute();
    const orderId = await placeRefused();
    const { second } = await secondSupplier('20.0000');
    const outboxBefore = (await outboxOf(world.db, 'order.dispatch_requested', orderId)).length;
    expect(
      (await post(orderId, 'change-supplier', { supplierId: second, resetReference: true, dispatch: true })).status,
    ).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({
      supplierId: second,
      dispatchState: 'pending',
      sentAt: null,
      unitCost: '20.0000',
    });
    expect((await eventsOf(world.db, orderId)).at(-1)!.data).toMatchObject({ costAbovePrice: true });
    expect((await outboxOf(world.db, 'order.dispatch_requested', orderId)).length).toBe(outboxBefore + 1);
    // The automatic limit does not apply to the following send: the order goes to the chosen supplier as it is.
    expect((await dispatch.run(orderId, { lastAttempt: false })).status).toBe('sent');
    expect(fake.callsOf('placeimeiorder').at(-1)!.parameters.ID).toBe('9001');
  });

  it('resets only the reference when no supplier is given, and does nothing for the same supplier without a reset', async () => {
    await freshRoute();
    const { orderId } = await placeAndSend();
    const before = (await eventsOf(world.db, orderId)).length;
    expect((await post(orderId, 'change-supplier', { supplierId })).status).toBe(204);
    expect((await eventsOf(world.db, orderId)).length).toBe(before);

    expect((await post(orderId, 'change-supplier', { resetReference: true })).status).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({
      supplierId,
      supplierRef: null,
      dispatchState: 'needs_attention',
    });
    expect((await eventsOf(world.db, orderId)).at(-1)).toMatchObject({ type: 'supplier_changed' });
  });

  it('refuses a closed order', async () => {
    await freshRoute();
    const orderId = await placeRefused();
    await world.db.update(s.orders).set({ status: 'rejected', dispatchState: 'done' }).where(eq(s.orders.id, orderId));
    expect((await post(orderId, 'change-supplier', { resetReference: true })).body).toMatchObject({
      code: 'ORDER_NOT_OPEN',
    });
  });
});

describe('the status poll', () => {
  it('completes a sent order when the supplier says STATUS 4, and leaves it alone while it runs', async () => {
    await freshRoute();
    const { orderId, reference } = await placeAndSend();
    expect(await poll.check(orderId, { type: 'system' })).toEqual({ kind: 'running' });
    expect((await orderRow(world.db, orderId)).dispatchState).toBe('sent');
    expect((await eventsOf(world.db, orderId)).map((event) => event.type)).toEqual([
      'created',
      'hold',
      'dispatch',
      'ack',
    ]);

    fake.finish(reference, 4, 'Unlocked');
    expect(await poll.check(orderId, { type: 'system' })).toEqual({ kind: 'completed' });
    expect(await orderRow(world.db, orderId)).toMatchObject({ status: 'completed', resultCode: 'Unlocked' });
    expect(await poll.check(orderId, { type: 'system' })).toEqual({ kind: 'skipped', reason: 'not_polled' });
    expect(fake.callsOf('getimeiorder')).toHaveLength(2);
  });

  it("rejects it on STATUS 3, and leaves an unreachable supplier's order as it is for the next round", async () => {
    await freshRoute();
    const { orderId, reference } = await placeAndSend();
    fake.forceHttp = 500;
    expect(await poll.check(orderId, { type: 'system' })).toMatchObject({ kind: 'unreachable' });
    expect((await orderRow(world.db, orderId)).dispatchState).toBe('sent');
    fake.forceHttp = 0;
    fake.finish(reference, 3, 'Service stopped');
    expect(await poll.check(orderId, { type: 'system' })).toEqual({ kind: 'rejected' });
    expect(await orderRow(world.db, orderId)).toMatchObject({ status: 'rejected', resultCode: 'Service stopped' });
  });

  it('the tick queues a poll for a sent order once it is due: every minute in the first hour, every five after it', async () => {
    await freshRoute();
    // Only this test's order is sent: the tick counts every sent order.
    await world.db
      .update(s.orders)
      .set({ status: 'rejected', dispatchState: 'done' })
      .where(eq(s.orders.dispatchState, 'sent'));
    const { orderId } = await placeAndSend();
    const queue = t.app.get(QueuesService, { strict: false }).queue('supplier-poll');
    const minuteOf = () => Math.floor(clock.nowMs() / 60_000);

    // Just sent: nothing is due yet.
    expect(await poll.tick()).toEqual({ due: 0, queued: 0 });

    clock.advance(61_000);
    expect(await poll.tick()).toEqual({ due: 1, queued: 1 });
    const job = await queue.getJob(`order-poll-${orderId}-${minuteOf()}`);
    expect(job!.data).toMatchObject({ orderId });

    // The poll ran: not due again before another minute.
    await poll.check(orderId, { type: 'system' });
    clock.advance(30_000);
    expect((await poll.tick()).due).toBe(0);
    clock.advance(40_000);
    expect((await poll.tick()).due).toBe(1);

    // After an hour the rhythm is five minutes.
    clock.advance(61 * MINUTE);
    await poll.check(orderId, { type: 'system' });
    clock.advance(2 * MINUTE);
    expect((await poll.tick()).due).toBe(0);
    clock.advance(4 * MINUTE);
    expect((await poll.tick()).due).toBe(1);
  });
});
