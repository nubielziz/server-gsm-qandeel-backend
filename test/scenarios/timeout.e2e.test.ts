// End-to-end walk of the map scenario `timeout` (the supplier does not answer, the order needs attention, docs/slices/suppliers.json and
// orders.json), step by step on the real application and a fake Dhru supplier that takes the order and never answers. The steps share
// one story, so the tests of this file run in order.
// Steps 1 and 2 are the merchant's Dhru call (placeimeiorder, getimeiorder: decision 026, feature 7a): the merchant places the orders and reads their status.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { SupplierDispatch, SupplierPoll } from '../../src/modules/suppliers';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { clearApiKeyCaches, credentialsFor, dhruClient } from '../support/machine-orders';
import { ledgerTotals } from '../support/money';
import {
  IMEIS,
  auditOf,
  eventsOf,
  orderRow,
  ordersWorld,
  outboxOf,
  systemBalance,
  walletOf,
  type OrdersWorld,
} from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { FakeDhruSupplier, SupplierTestModule, automaticRoute, logsOf } from '../support/suppliers';

const fake = new FakeDhruSupplier();
const clock = new TestClock();
const prefix = testBullPrefix();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let dispatch: SupplierDispatch;
let supplierId = 0;
let serviceId = 0;
let orderId = 0;
let dhru: ReturnType<typeof dhruClient>;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [SupplierTestModule], env: { BULL_PREFIX: prefix } });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  await clearApiKeyCaches(t);
  dhru = dhruClient(t, await credentialsFor(t, world.db, world.merchant.id));
  staff = await adminWith(t, ['orders:*', 'suppliers:*'], { name: 'Lina S.' });
  dispatch = t.app.get(SupplierDispatch, { strict: false });
  ({ supplierId, serviceId } = await automaticRoute(
    world.db,
    t.app.get(EncryptionService, { strict: false }),
    fake,
    world.auto.categoryId,
    { supplier: { timeoutMs: 400 } },
  ));
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('scenario timeout: the supplier does not answer', () => {
  it('steps 1 and 2 (placeimeiorder), orders steps 3 and 4: the order is placed with its hold and the answer is immediate (status pending)', async () => {
    const { db, merchant } = world;
    const answer = await dhru.call('placeimeiorder', { ID: serviceId, IMEI: IMEIS[2] });
    expect(answer.SUCCESS).toEqual([{ MESSAGE: 'Order received', REFERENCEID: expect.any(String) }]);
    orderId = Number(answer.SUCCESS[0].REFERENCEID);
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'pending', dispatchState: 'pending', source: 'dhru' });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
  });

  it('suppliers steps 6 and 7: the order is sent and no answer arrives within timeout_ms; the log says timeout with no HTTP status', async () => {
    const { db } = world;
    fake.place('accept-then-hang');
    const outcome = await dispatch.run(orderId, { lastAttempt: false });
    expect(outcome).toMatchObject({ status: 'needs_attention' });
    const [log] = await logsOf(db, supplierId);
    expect(log).toMatchObject({
      orderId,
      action: 'placeimeiorder',
      httpStatus: 0,
      outcome: 'timeout',
      error: 'Timed out after 400 ms',
    });
    expect(log!.durationMs).toBeGreaterThanOrEqual(350);
    // The supplier may have run it: it did.
    expect(fake.orders.size).toBe(1);
  });

  it('orders step 8: no automatic re-send; the order stops in the needs_attention queue and the balance stays held', async () => {
    const { db, merchant } = world;
    const poll = t.app.get(SupplierPoll, { strict: false });
    expect(await orderRow(db, orderId)).toMatchObject({
      status: 'pending',
      dispatchState: 'needs_attention',
      supplierRef: null,
    });
    // Hours pass; the job queue, the poll tick and the dispatch job leave it alone.
    clock.advance(6 * HOUR);
    // Six hours is longer than a session: the member signs in again.
    staff = await adminWith(t, ['orders:*', 'suppliers:*'], { name: 'Lina S.' });
    expect(await poll.tick()).toMatchObject({ queued: 0 });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    const shown = (await staff.get(`/admin/orders/${orderId}`)).body;
    expect(shown).toMatchObject({
      queue: 'needs_attention',
      status: 'pending',
      reviewReason: expect.stringContaining('did not answer within 400 ms'),
    });
    const review = (await eventsOf(db, orderId)).at(-1)!;
    expect(review).toMatchObject({ type: 'review', actorType: 'system' });
    expect(await outboxOf(db, 'order.status_changed', orderId)).toHaveLength(0);
    // The merchant sees nothing of it: the order is still new (STATUS 0) and nothing was sent to it.
    expect((await dhru.call('getimeiorder', { ID: String(orderId) })).SUCCESS).toEqual([{ STATUS: 0, CODE: '' }]);
  });

  it('orders step 10: with no supplier reference there is nothing to fetch; the member checks with the supplier and sends it again by hand', async () => {
    const { db } = world;
    const fetched = await staff.post(`/admin/orders/${orderId}/fetch`, {});
    expect(fetched.status).toBe(409);
    expect(fetched.body).toMatchObject({ code: 'NO_REFERENCE' });

    expect((await staff.post(`/admin/orders/${orderId}/dispatch`, {})).status).toBe(204);
    expect(await orderRow(db, orderId)).toMatchObject({ dispatchState: 'pending', sentAt: null });
    expect((await eventsOf(db, orderId)).at(-1)).toMatchObject({
      type: 'retry',
      actorType: 'staff',
      actorId: staff.staffId,
    });
    expect((await auditOf(db, orderId)).at(-1)).toMatchObject({ action: 'dispatched order', actorName: 'Lina S.' });
    expect((await dispatch.run(orderId, { lastAttempt: false })).status).toBe('sent');
    expect(fake.callsOf('placeimeiorder')).toHaveLength(2);
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'processing', dispatchState: 'sent' });
    expect((await staff.get(`/admin/orders/${orderId}`)).body).toMatchObject({ queue: null, attempts: 2 });
    expect((await dhru.call('getimeiorder', { ID: String(orderId) })).SUCCESS).toEqual([{ STATUS: 1, CODE: '' }]);
  });

  it('orders step 10 (a reference exists): the member fetches the result and the order completes with the money settled', async () => {
    const { db } = world;
    // A second order that timed out after the supplier had accepted it: it has a reference and waits for attention.
    const second = await dhru.call('placeimeiorder', { ID: serviceId, IMEI: IMEIS[3] });
    const secondId = Number(second.SUCCESS[0].REFERENCEID);
    fake.place('accept');
    expect((await dispatch.run(secondId, { lastAttempt: false })).status).toBe('sent');
    const reference = (await orderRow(db, secondId)).supplierRef!;
    await db.update(s.orders).set({ dispatchState: 'needs_attention' }).where(eq(s.orders.id, secondId));
    fake.finish(reference, 4, 'Unlocked');

    expect((await staff.post(`/admin/orders/${secondId}/fetch`, {})).status).toBe(204);
    expect(await orderRow(db, secondId)).toMatchObject({
      status: 'completed',
      dispatchState: 'done',
      resultCode: 'Unlocked',
    });
    expect((await auditOf(db, secondId)).at(-1)).toMatchObject({ action: 'fetched supplier result of' });
    expect((await logsOf(db, supplierId)).filter((log) => log.orderId === secondId).map((log) => log.action)).toEqual([
      'placeimeiorder',
      'getimeiorder',
    ]);
    // The first order's hold is still held (it is processing); the second one was settled.
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
    expect(await systemBalance(db, 'cogs')).toBe('13.5000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // The merchant reads the result of the second order with getimeiorder, and the first is still in process.
    expect((await dhru.call('getimeiorder', { ID: String(secondId) })).SUCCESS).toEqual([
      { STATUS: 4, CODE: 'Unlocked' },
    ]);
    expect((await dhru.call('getimeiorder', { ID: String(orderId) })).SUCCESS).toEqual([{ STATUS: 1, CODE: '' }]);
  });
});
