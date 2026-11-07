// End-to-end walk of the map scenario `success` (the supplier completes the order, docs/slices/suppliers.json and orders.json), step by step
// on the real application and a fake Dhru supplier: the tables and statuses each step names are read back from Postgres. The steps share
// one story, so the tests of this file run in order and keep their state in the variables below.
// Steps 1, 2 and 12 are the merchant's Dhru calls (placeimeiorder, getimeiorder, decision 026, feature 7a): the merchant places the order
// and reads STATUS 0, 1 and 4 through its Dhru endpoint; the portal reading stays next to them (same facts, same placement path).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { SupplierDispatch, SupplierPoll } from '../../src/modules/suppliers';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { clearApiKeyCaches, credentialsFor, dhruClient } from '../support/machine-orders';
import { accountFigures, ledgerTotals } from '../support/money';
import {
  IMEIS,
  eventsOf,
  json,
  ledgerOf,
  orderRow,
  ordersWorld,
  outboxOf,
  portalFor,
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
let supplierId = 0;
let serviceId = 0;
let supplierServiceId = 0;
let orderId = 0;
let reference = '';
let dhru: ReturnType<typeof dhruClient>;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [SupplierTestModule], env: { BULL_PREFIX: prefix } });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  await clearApiKeyCaches(t);
  dhru = dhruClient(t, await credentialsFor(t, world.db, world.merchant.id));
  ({ supplierId, serviceId, supplierServiceId } = await automaticRoute(
    world.db,
    t.app.get(EncryptionService, { strict: false }),
    fake,
    world.auto.categoryId,
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

describe('scenario success: the supplier completes the order', () => {
  it('steps 1 and 2 (placeimeiorder), orders step 3: price, hold and order in one transaction: the order, its event, the hold entry and the outbox job', async () => {
    const { db, merchant } = world;
    const answer = await dhru.call('placeimeiorder', { ID: serviceId, IMEI: IMEIS[0] });
    // The answer is immediate: the order number as REFERENCEID.
    expect(answer).toEqual({
      SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: expect.any(String) }],
      apiversion: '6.1',
    });
    orderId = Number(answer.SUCCESS[0].REFERENCEID);
    expect(await orderRow(db, orderId)).toMatchObject({
      status: 'pending',
      dispatchState: 'pending',
      totalPrice: '17.2800',
      source: 'dhru',
      supplierId: null,
      supplierRef: null,
    });
    expect((await eventsOf(db, orderId)).map((event) => event.type)).toEqual(['created', 'hold']);
    expect(await ledgerOf(db, orderId)).toEqual([{ kind: 'order_hold', key: `order:${orderId}:hold` }]);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await outboxOf(db, 'order.dispatch_requested', orderId)).toHaveLength(1);
  });

  it('orders step 4: the order is status pending: the merchant reads STATUS 0 with no CODE (getimeiorder)', async () => {
    expect((await dhru.call('getimeiorder', { ID: String(orderId) })).SUCCESS).toEqual([{ STATUS: 0, CODE: '' }]);
    const shown = json(await (await portalFor(t, world.merchant.id)).get(`/client/orders/${orderId}`));
    expect(shown).toMatchObject({ id: orderId, status: 'pending', completedAt: null });
  });

  it("suppliers step 6: the worker sends it through the primary supplier link, within the supplier's limits, and logs the request and the answer", async () => {
    const { db } = world;
    const dispatch = t.app.get(SupplierDispatch, { strict: false });
    const outcome = await dispatch.run(orderId, { lastAttempt: false });
    expect(outcome.status).toBe('sent');
    reference = fake.referenceOf(1);
    // The link of the service chose the supplier service; its price is the cost of the order.
    expect(await orderRow(db, orderId)).toMatchObject({ supplierId, supplierServiceId, unitCost: '13.5000' });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    expect(fake.callsOf('placeimeiorder')[0]!.parameters).toMatchObject({ ID: '4411', IMEI: IMEIS[0], QNT: 1 });
    const logs = await logsOf(db, supplierId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ orderId, action: 'placeimeiorder', httpStatus: 200, error: '', outcome: 'ok' });
    expect(logs[0]!.response).toMatchObject({ SUCCESS: [{ REFERENCEID: reference }] });
  });

  it("orders step 7: the supplier's order number is stored in supplier_ref and the status is processing (STATUS 1)", async () => {
    const { db, merchant } = world;
    expect(await orderRow(db, orderId)).toMatchObject({
      supplierRef: reference,
      status: 'processing',
      dispatchState: 'sent',
    });
    expect(json(await (await portalFor(t, merchant.id)).get(`/client/orders/${orderId}`))).toMatchObject({
      status: 'processing',
    });
    expect((await dhru.call('getimeiorder', { ID: String(orderId) })).SUCCESS).toEqual([{ STATUS: 1, CODE: '' }]);
    const [ack] = (await eventsOf(db, orderId)).filter((event) => event.type === 'ack');
    expect(ack).toMatchObject({
      actorType: 'supplier',
      actorId: supplierId,
      fromStatus: 'pending',
      toStatus: 'processing',
    });
    expect(
      (await outboxOf(db, 'order.status_changed', orderId)).map(
        (row) => (row.payload as { toStatus: string }).toStatus,
      ),
    ).toEqual(['processing']);
    // The money has not moved: the hold stays until the supplier answers.
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
  });

  it('suppliers step 8: the worker asks every minute in the first hour, then every 5 minutes, then every 30', async () => {
    const { db } = world;
    const poll = t.app.get(SupplierPoll, { strict: false });
    const queue = t.app.get(QueuesService, { strict: false }).queue('supplier-poll');
    const getCalls = () =>
      logsOf(db, supplierId).then((rows) => rows.filter((row) => row.action === 'getimeiorder').length);
    const tick = async () => (await poll.tick()).queued;
    // The tick finds due orders; each queued job is a poll (the test runs them itself instead of a worker).
    const ask = async () => {
      await poll.check(orderId, { type: 'system' });
    };
    expect(await tick()).toBe(0);
    clock.advance(61_000);
    expect(await tick()).toBe(1);
    expect(await queue.getJob(`order-poll-${orderId}-${Math.floor(clock.nowMs() / 60_000)}`)).toBeDefined();
    await ask();
    clock.advance(30_000);
    expect(await tick()).toBe(0);
    clock.advance(31_000);
    expect(await tick()).toBe(1);
    await ask();
    // An hour on, the polls are 5 minutes apart.
    clock.advance(61 * MINUTE);
    await ask();
    clock.advance(4 * MINUTE);
    expect(await tick()).toBe(0);
    clock.advance(2 * MINUTE);
    expect(await tick()).toBe(1);
    await ask();
    // After the slow limit (24 hours by default) it is every 30 minutes.
    clock.advance(25 * 60 * MINUTE);
    await ask();
    clock.advance(10 * MINUTE);
    expect(await tick()).toBe(0);
    clock.advance(21 * MINUTE);
    expect(await tick()).toBe(1);
    expect(await getCalls()).toBe(5);
    // The supplier is still running it: nothing changed on the order.
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'processing', dispatchState: 'sent' });
  });

  it('suppliers step 9: STATUS 4 with the CODE arrives and the order is completed', async () => {
    const { db } = world;
    fake.finish(reference, 4, 'Unlocked: code 8842 1113');
    expect(await t.app.get(SupplierPoll, { strict: false }).check(orderId, { type: 'system' })).toEqual({
      kind: 'completed',
    });
    const logs = (await logsOf(db, supplierId)).filter((row) => row.action === 'getimeiorder');
    expect(logs.at(-1)).toMatchObject({ orderId, httpStatus: 200, outcome: 'ok' });
    expect(logs.at(-1)!.response).toMatchObject({ SUCCESS: [{ STATUS: 4, CODE: 'Unlocked: code 8842 1113' }] });
  });

  it('orders step 10: the hold becomes revenue at the sale price and the cost is booked from the prepaid balance at the supplier', async () => {
    const { db, merchant } = world;
    expect(await orderRow(db, orderId)).toMatchObject({
      status: 'completed',
      dispatchState: 'done',
      resultCode: 'Unlocked: code 8842 1113',
      supplierRef: reference,
    });
    expect((await orderRow(db, orderId)).completedAt).not.toBeNull();
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
    expect(await systemBalance(db, 'cogs')).toBe('13.5000');
    expect((await ledgerOf(db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold', 'order_settle']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    const entries = await db
      .select({ amount: s.ledgerEntries.amount, kind: s.ledgerAccounts.kind, ownerId: s.ledgerAccounts.ownerId })
      .from(s.ledgerEntries)
      .innerJoin(s.ledgerTransactions, eq(s.ledgerTransactions.id, s.ledgerEntries.transactionId))
      .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.ledgerEntries.accountId))
      .where(and(eq(s.ledgerTransactions.idempotencyKey, `order:${orderId}:settle`)));
    expect(entries.map((entry) => [entry.kind, entry.amount]).sort()).toEqual([
      ['client_hold', '17.2800'],
      ['cogs', '13.5000'],
      ['revenue', '-17.2800'],
      ['supplier_prepaid', '-13.5000'],
    ]);
    expect(entries.find((entry) => entry.kind === 'supplier_prepaid')!.ownerId).toBe(supplierId);
    expect((await accountFigures(db, 'supplier_prepaid', { type: 'supplier', id: supplierId }))?.balance).toBe(
      '-13.5000',
    );
    const events = await eventsOf(db, orderId);
    expect(events.map((event) => event.type)).toEqual(['created', 'hold', 'dispatch', 'ack', 'completed', 'settle']);
    expect(events.at(-1)!.data).toMatchObject({ revenue: '17.2800', cost: '13.5000' });
    expect(
      (await outboxOf(db, 'order.status_changed', orderId)).map(
        (row) => (row.payload as { toStatus: string }).toStatus,
      ),
    ).toEqual(['processing', 'completed']);
  });

  it('step 12 (getimeiorder): the merchant reads STATUS 4 and the CODE, and the supplier is never shown to it', async () => {
    const answer = await dhru.call('getimeiorder', { ID: String(orderId) });
    expect(answer).toEqual({ SUCCESS: [{ STATUS: 4, CODE: 'Unlocked: code 8842 1113' }], apiversion: '6.1' });
    expect(JSON.stringify(answer)).not.toContain(reference);
    const shown = json(await (await portalFor(t, world.merchant.id)).get(`/client/orders/${orderId}`));
    expect(shown).toMatchObject({ status: 'completed', result: { code: 'Unlocked: code 8842 1113' } });
    expect(JSON.stringify(shown)).not.toContain(reference);
    expect(shown.events.map((event: { type: string }) => event.type)).not.toContain('ack');
  });

  it('a second poll or a repeated settlement changes nothing: the order is closed and the ledger balanced', async () => {
    const { db } = world;
    const poll = t.app.get(SupplierPoll, { strict: false });
    expect(await poll.check(orderId, { type: 'system' })).toEqual({ kind: 'skipped', reason: 'not_polled' });
    expect((await ledgerOf(db, orderId)).length).toBe(2);
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
  });
});
