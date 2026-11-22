// A storefront order is sent to a supplier only while its payment stands: the dispatch job stops an order whose payment is disputed or was
// charged back in needs_attention with the reason (no supplier call), and staff cannot send it or change its supplier with a send until
// the dispute is won. Merchant orders are not concerned. Real Postgres and Redis, a stand-in card gateway with its signed dispute webhooks
// and the fake Dhru supplier; no BullMQ worker: the test calls the job's logic.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EncryptionService } from '@src/infra/crypto';
import type { Database } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { DispatchSweep, SupplierDispatch } from '@src/modules/suppliers';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, disputeEvent, hook, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, ledgerOf, orderRow, outboxOf } from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService } from '../../support/suppliers';

const clock = new TestClock('2026-11-21T12:00:00.000Z');
const gateway = new B2cGateway();
const supplier = new FakeDhruSupplier();
const prefix = testBullPrefix();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;
let dispatch: SupplierDispatch;
let counter = 0;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, SupplierTestModule], env: { BULL_PREFIX: prefix } });
  dispatch = t.app.get(SupplierDispatch, { strict: false });
});
afterAll(async () => {
  await gateway.stop();
  await supplier.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-21T12:00:00.000Z');
  gateway.reset();
  supplier.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, gateway);
  await seedDefaultTemplates(db);
  // The shop's iCloud check is linked to a supplier, so a paid order waits for the dispatch job.
  const supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService, { strict: false }), supplier);
  await linkService(db, world.icloud.serviceId, supplierId, { credit: '0.0800' });
  staff = await adminWith(t, ['orders:*', 'suppliers:*', 'disputes:*'], { name: 'Order desk' });
});

const unique = () => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;

/** The gateway reports a dispute of the order's payment: opened, or closed as won or lost. */
async function dispute(paid: PaidOrder, gatewayId: string, status?: 'won' | 'lost') {
  const body = disputeEvent(`evt_${unique()}`, {
    dispute: gatewayId,
    intent: paid.intent,
    ...(status === undefined ? {} : { type: 'charge.dispute.closed', status }),
  });
  expect((await hook(t, clock, 'disputes', world.gateway.code, body)).statusCode).toBe(200);
}

/** A paid storefront order waiting for its first send. */
async function waitingOrder(): Promise<PaidOrder> {
  const paid = await paidOrder(t, clock, world);
  expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'pending', sentAt: null });
  return paid;
}

const post = (orderId: number, action: string, body: unknown = {}) =>
  staff.post(`/admin/orders/${orderId}/${action}`, body);
const run = (orderId: number) => dispatch.run(orderId, { lastAttempt: false });

/** The reason of the newest review line of the order. */
async function lastReviewReason(orderId: number): Promise<unknown> {
  const reviews = (await eventsOf(db, orderId)).filter((event) => event.type === 'review');
  return (reviews.at(-1)?.data as { reason?: unknown } | undefined)?.reason;
}

describe('a storefront order whose payment is disputed', () => {
  it('is not sent by the dispatch job, and staff cannot send it until the dispute is won', async () => {
    const paid = await waitingOrder();
    await dispute(paid, 'dp_open');
    // Staff are refused even while the placement's request is still on its way.
    expect((await post(paid.orderId, 'dispatch')).body).toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });

    const outcome = await run(paid.orderId);
    expect(outcome.status).toBe('needs_attention');
    expect(supplier.callsOf('placeimeiorder')).toHaveLength(0);
    expect(await orderRow(db, paid.orderId)).toMatchObject({
      status: 'pending',
      dispatchState: 'needs_attention',
      sentAt: null,
    });
    expect(await lastReviewReason(paid.orderId)).toEqual(expect.stringContaining('disputed'));

    // Staff cannot send it while the dispute is open, neither directly nor with a change of supplier.
    const sent = await post(paid.orderId, 'dispatch');
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(sent.body.detail).toContain('disputed');
    const changed = await post(paid.orderId, 'change-supplier', { resetReference: true, dispatch: true });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await orderRow(db, paid.orderId)).toMatchObject({ dispatchState: 'needs_attention' });
    // Only the request of the placement exists.
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(1);
    // A change that sends nothing is still allowed.
    expect((await post(paid.orderId, 'change-supplier', { resetReference: true })).status).toBe(204);

    // The dispute is won: staff send it and the job sends it.
    await dispute(paid, 'dp_open', 'won');
    expect((await post(paid.orderId, 'dispatch')).status).toBe(204);
    expect((await run(paid.orderId)).status).toBe('sent');
    expect(supplier.callsOf('placeimeiorder')).toHaveLength(1);
  });
});

describe('a storefront order that waits for staff when its payment is disputed', () => {
  it('cannot be sent again by staff, directly or with a change of supplier, while the dispute is open', async () => {
    supplier.place({ refuse: 'Not enough credits' });
    const paid = await waitingOrder();
    expect((await run(paid.orderId)).status).toBe('needs_attention');
    await dispute(paid, 'dp_after_refusal');

    const sent = await post(paid.orderId, 'dispatch');
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(sent.body.detail).toContain('disputed');
    const changed = await post(paid.orderId, 'change-supplier', { resetReference: true, dispatch: true });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'needs_attention' });
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(1);
    expect(supplier.callsOf('placeimeiorder')).toHaveLength(1);
  });
});

describe('a storefront order whose payment was charged back', () => {
  it('is not sent by the dispatch job and staff cannot send it', async () => {
    const paid = await waitingOrder();
    await dispute(paid, 'dp_lost');
    await dispute(paid, 'dp_lost', 'lost');

    expect((await run(paid.orderId)).status).toBe('needs_attention');
    expect(supplier.callsOf('placeimeiorder')).toHaveLength(0);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'needs_attention' });
    expect(await lastReviewReason(paid.orderId)).toEqual(expect.stringContaining('charged back'));

    const sent = await post(paid.orderId, 'dispatch');
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(sent.body.detail).toContain('charged back');
    expect((await post(paid.orderId, 'change-supplier', { resetReference: true, dispatch: true })).status).toBe(409);
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(1);
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).not.toContain('order_settle');
  });

  it('is not sent when the dispatch sweep asks for its lost request again: the job stops it', async () => {
    const paid = await waitingOrder();
    await dispute(paid, 'dp_lost_again');
    await dispute(paid, 'dp_lost_again', 'lost');
    const sweep = t.app.get(DispatchSweep, { strict: false });
    expect(await sweep.apply({ items: [{ kind: 'requeue', orderId: paid.orderId }], unknown: 0 })).toMatchObject({
      requeued: 1,
    });
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(2);

    expect((await run(paid.orderId)).status).toBe('needs_attention');
    expect(supplier.callsOf('placeimeiorder')).toHaveLength(0);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'needs_attention' });
    expect(await lastReviewReason(paid.orderId)).toEqual(expect.stringContaining('charged back'));
  });
});
