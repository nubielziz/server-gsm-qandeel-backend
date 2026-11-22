// The supplier cost of an order completed again after a reopen (decision 024, MISMATCHES B17): a reopen keeps the cost booked, and a
// later completion books the cost again only when a supplier accepted the order again since the settlement that booked it (staff
// sent it again, or changed its supplier and sent it). Real Postgres and Redis, the fake Dhru supplier, a TestClock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { EncryptionService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { b2cPay, postTransaction } from '@src/modules/money';
import { DISPATCH_ANSWER_MARGIN_MS, DispatchSweep, SupplierDispatch, SupplierPoll } from '@src/modules/suppliers';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertService } from '../../support/catalog';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { accountFigures, fundWallet, ledgerTotals } from '../../support/money';
import {
  IMEIS,
  eventsOf,
  insertOrderRow,
  json,
  orderRow,
  ordersWorld,
  portalFor,
  systemBalance,
  type OrdersWorld,
} from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { FakeDhruSupplier, SupplierTestModule, hold, insertFakeSupplier, linkService } from '../../support/suppliers';

const TIMEOUT_MS = 10_000;
const fake = new FakeDhruSupplier();
const clock = new TestClock();
const prefix = testBullPrefix();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let dispatch: SupplierDispatch;
let poll: SupplierPoll;
let sweep: DispatchSweep;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [SupplierTestModule], env: { BULL_PREFIX: prefix } });
  dispatch = t.app.get(SupplierDispatch, { strict: false });
  poll = t.app.get(SupplierPoll, { strict: false });
  sweep = t.app.get(DispatchSweep, { strict: false });
});
beforeEach(async () => {
  fake.reset();
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*', 'suppliers:*']);
  await fundWallet(world.db, world.merchant.id, '100');
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

/** An automatic service (price 17.28) whose only link goes to a fake-backed supplier at `credit` (13.50 by default). */
async function route(credit = '13.5000') {
  const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake, { timeoutMs: TIMEOUT_MS });
  const serviceId = await insertService(world.db, world.auto.categoryId, {
    name: `Settle cost route ${crypto.randomUUID().slice(0, 6)}`,
    cost: credit,
    effectiveCost: credit,
    basePrice: '17.2800',
    minProfit: '0.8100',
  });
  await linkService(world.db, serviceId, supplierId, { credit });
  return { supplierId, serviceId };
}

/** A second supplier linked to the service at 14.00. */
async function otherSupplier(serviceId: number): Promise<number> {
  const other = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake, {
    name: 'Other supplier',
    timeoutMs: TIMEOUT_MS,
  });
  await linkService(world.db, serviceId, other, { remoteId: '9001', priority: 2, credit: '14.0000' });
  return other;
}

/** Sends the order to its supplier, lets the supplier complete it and records the result through the poll. */
async function sendAndComplete(orderId: number, code: string): Promise<void> {
  expect((await dispatch.run(orderId, { lastAttempt: false })).status).toBe('sent');
  fake.finish((await orderRow(world.db, orderId)).supplierRef!, 4, code);
  expect(await poll.check(orderId, { type: 'system' })).toEqual({ kind: 'completed' });
}

/** A merchant order placed in the portal and completed by its supplier. */
async function completedBySupplier(serviceId: number): Promise<number> {
  const res = await (await portalFor(t, world.merchant.id)).post('/client/orders', { serviceId, imei: IMEIS[0] });
  expect(res.statusCode).toBe(201);
  const orderId = json(res).orders[0].id as number;
  await sendAndComplete(orderId, 'Code A');
  return orderId;
}

const prepaidOf = async (supplierId: number) =>
  (await accountFigures(world.db, 'supplier_prepaid', { type: 'supplier', id: supplierId }))?.balance ?? '0.0000';

const settleCosts = async (orderId: number) =>
  (await eventsOf(world.db, orderId))
    .filter((event) => event.type === 'settle')
    .map((event) => (event.data as { cost?: string }).cost);

describe('the supplier cost of a completion after a reopen', () => {
  it('books the cost again when staff send the order again and the supplier completes the new order', async () => {
    const { supplierId, serviceId } = await route();
    const orderId = await completedBySupplier(serviceId);
    expect(await systemBalance(world.db, 'cogs')).toBe('13.5000');

    expect((await staff.post(`/admin/orders/${orderId}/reopen`, { reason: 'The code did not work' })).status).toBe(204);
    expect(await systemBalance(world.db, 'cogs')).toBe('13.5000');
    expect((await staff.post(`/admin/orders/${orderId}/dispatch`, {})).status).toBe(204);
    await sendAndComplete(orderId, 'Code B');

    expect(fake.callsOf('placeimeiorder')).toHaveLength(2);
    expect(await systemBalance(world.db, 'cogs')).toBe('27.0000');
    expect(await prepaidOf(supplierId)).toBe('-27.0000');
    expect(await settleCosts(orderId)).toEqual(['13.5000', '13.5000']);

    // A further reopen answered by staff, with no new supplier order, books the revenue only.
    expect((await staff.post(`/admin/orders/${orderId}/reopen`, {})).status).toBe(204);
    expect((await staff.post(`/admin/orders/${orderId}/reply`, { code: 'Code C' })).status).toBe(204);
    expect(await systemBalance(world.db, 'cogs')).toBe('27.0000');
    expect(await prepaidOf(supplierId)).toBe('-27.0000');
    expect(await settleCosts(orderId)).toEqual(['13.5000', '13.5000', '0.0000']);
    expect(await systemBalance(world.db, 'revenue')).toBe('17.2800');
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
  });

  it('books the new supplier cost on the new supplier when staff change the supplier with a send', async () => {
    const { supplierId, serviceId } = await route();
    const orderId = await completedBySupplier(serviceId);
    const other = await otherSupplier(serviceId);

    expect((await staff.post(`/admin/orders/${orderId}/reopen`, {})).status).toBe(204);
    const changed = await staff.post(`/admin/orders/${orderId}/change-supplier`, { supplierId: other, dispatch: true });
    expect(changed.status).toBe(204);
    await sendAndComplete(orderId, 'Code B');

    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'completed',
      supplierId: other,
      totalCost: '14.0000',
    });
    expect(await prepaidOf(other)).toBe('-14.0000');
    expect(await prepaidOf(supplierId)).toBe('-13.5000');
    expect(await systemBalance(world.db, 'cogs')).toBe('27.5000');
    expect(await settleCosts(orderId)).toEqual(['13.5000', '14.0000']);
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
  });

  it('books the cost again for a storefront order that staff send again after a reopen', async () => {
    const { db } = world;
    const { supplierId, serviceId } = await route('10.0000');
    const [customer] = await db
      .insert(s.customers)
      .values({ email: `c-${crypto.randomUUID()}@example.com`, name: 'Jack Turner' })
      .returning({ id: s.customers.id });
    const order = await insertOrderRow(db, {
      customerId: customer!.id,
      serviceId,
      source: 'store',
      dispatchState: 'pending',
      unitPrice: '12.4900',
      totalPrice: '12.4900',
      taxAmount: '2.5000',
    });
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...b2cPay({ net: Money.of('12.49'), vat: Money.of('2.50') }),
          refId: order.id,
          idempotencyKey: `test:pay:${order.id}`,
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        new Date(),
      ),
    );
    await sendAndComplete(order.id, 'Code A');
    expect(await systemBalance(db, 'cogs')).toBe('10.0000');

    expect((await staff.post(`/admin/orders/${order.id}/reopen`, {})).status).toBe(204);
    expect((await staff.post(`/admin/orders/${order.id}/dispatch`, {})).status).toBe(204);
    await sendAndComplete(order.id, 'Code B');

    expect(fake.callsOf('placeimeiorder')).toHaveLength(2);
    expect(await systemBalance(db, 'cogs')).toBe('20.0000');
    expect(await prepaidOf(supplierId)).toBe('-20.0000');
    expect(await systemBalance(db, 'revenue')).toBe('12.4900');
    expect(await settleCosts(order.id)).toEqual(['10.0000', '10.0000']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('books no second cost when the supplier refuses the new send and the first supplier order completes the order', async () => {
    const { supplierId, serviceId } = await route();
    const orderId = await completedBySupplier(serviceId);

    expect((await staff.post(`/admin/orders/${orderId}/reopen`, {})).status).toBe(204);
    expect((await staff.post(`/admin/orders/${orderId}/dispatch`, {})).status).toBe(204);
    fake.place({ refuse: 'Not enough credit' });
    expect((await dispatch.run(orderId, { lastAttempt: false })).status).toBe('needs_attention');
    // The order still names the first supplier order, which the supplier reports as completed.
    expect((await staff.post(`/admin/orders/${orderId}/fetch`, {})).status).toBe(204);

    expect(await orderRow(world.db, orderId)).toMatchObject({ status: 'completed', supplierRef: fake.referenceOf(1) });
    expect(await systemBalance(world.db, 'cogs')).toBe('13.5000');
    expect(await prepaidOf(supplierId)).toBe('-13.5000');
    expect(await settleCosts(orderId)).toEqual(['13.5000', '0.0000']);
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
  });

  it('books the cost of a supplier acceptance that was stored on the order after it moved on', async () => {
    const { serviceId } = await route();
    const orderId = await completedBySupplier(serviceId);
    const other = await otherSupplier(serviceId);

    expect((await staff.post(`/admin/orders/${orderId}/reopen`, {})).status).toBe(204);
    expect(
      (await staff.post(`/admin/orders/${orderId}/change-supplier`, { supplierId: other, dispatch: true })).status,
    ).toBe(204);
    // The new supplier takes the order, but its answer arrives only after the sweep moved the order to the review queue.
    const held = hold();
    fake.place({ hold: held });
    const running = dispatch.run(orderId, { lastAttempt: false });
    await held.arrived;
    clock.advance(TIMEOUT_MS + DISPATCH_ANSWER_MARGIN_MS + 1_000);
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    held.release();
    expect(await running).toEqual({ status: 'skipped', reason: 'moved_on' });
    const reference = fake.referenceOf(2);
    expect(await orderRow(world.db, orderId)).toMatchObject({
      dispatchState: 'needs_attention',
      supplierRef: reference,
    });

    fake.finish(reference, 4, 'Code B');
    expect((await staff.post(`/admin/orders/${orderId}/fetch`, {})).status).toBe(204);
    expect((await orderRow(world.db, orderId)).status).toBe('completed');
    expect(await prepaidOf(other)).toBe('-14.0000');
    expect(await systemBalance(world.db, 'cogs')).toBe('27.5000');
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
  });
});
