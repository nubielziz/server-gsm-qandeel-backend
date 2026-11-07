// End-to-end walk of the map scenario `reject` (the supplier rejects the order, docs/slices/suppliers.json and orders.json), step by step
// on the real application and a fake Dhru supplier. The steps share one story, so the tests of this file run in order.
// Steps 1, 2 and 12 are the merchant's Dhru calls (placeimeiorder, getimeiorder: decision 026, feature 7a); the portal reading stays next to them.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EncryptionService } from '../../src/infra/crypto';
import { RedisService } from '../../src/infra/redis';
import { SupplierDispatch, SupplierPoll } from '../../src/modules/suppliers';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { clearApiKeyCaches, credentialsFor, dhruClient } from '../support/machine-orders';
import { ledgerTotals } from '../support/money';
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
  ({ supplierId, serviceId } = await automaticRoute(
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

describe('scenario reject: the supplier rejects the order', () => {
  it('steps 1 and 2 (placeimeiorder), orders steps 3 and 4: the order is placed with its hold, the answer is immediate, status pending (STATUS 0)', async () => {
    const { db, merchant } = world;
    const answer = await dhru.call('placeimeiorder', { ID: serviceId, IMEI: IMEIS[1] });
    expect(answer.SUCCESS).toEqual([{ MESSAGE: 'Order received', REFERENCEID: expect.any(String) }]);
    orderId = Number(answer.SUCCESS[0].REFERENCEID);
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'pending', dispatchState: 'pending', source: 'dhru' });
    expect((await dhru.call('getimeiorder', { ID: String(orderId) })).SUCCESS).toEqual([{ STATUS: 0, CODE: '' }]);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await outboxOf(db, 'order.dispatch_requested', orderId)).toHaveLength(1);
  });

  it("suppliers step 6 and orders step 7: the worker sends it, the supplier's number is stored and the status is processing", async () => {
    const { db } = world;
    expect((await t.app.get(SupplierDispatch, { strict: false }).run(orderId, { lastAttempt: false })).status).toBe(
      'sent',
    );
    reference = fake.referenceOf(1);
    expect(await orderRow(db, orderId)).toMatchObject({
      supplierRef: reference,
      status: 'processing',
      dispatchState: 'sent',
    });
    expect((await logsOf(db, supplierId))[0]).toMatchObject({
      orderId,
      action: 'placeimeiorder',
      httpStatus: 200,
      outcome: 'ok',
    });
  });

  it('suppliers step 8: the worker asks for the status on its rhythm and the supplier is still working', async () => {
    const poll = t.app.get(SupplierPoll, { strict: false });
    clock.advance(MINUTE + 1000);
    expect((await poll.tick()).queued).toBe(1);
    expect(await poll.check(orderId, { type: 'system' })).toEqual({ kind: 'running' });
    expect((await orderRow(world.db, orderId)).status).toBe('processing');
  });

  it('suppliers step 9: STATUS 3 arrives with the reason (the IMEI is not supported or the service is stopped) and the order is rejected', async () => {
    const { db } = world;
    fake.finish(reference, 3, 'IMEI not supported');
    expect(await t.app.get(SupplierPoll, { strict: false }).check(orderId, { type: 'system' })).toEqual({
      kind: 'rejected',
    });
    const logs = (await logsOf(db, supplierId)).filter((row) => row.action === 'getimeiorder');
    expect(logs.at(-1)!.response).toMatchObject({ SUCCESS: [{ STATUS: 3, CODE: 'IMEI not supported' }] });
    expect(logs.at(-1)).toMatchObject({ orderId, outcome: 'ok' });
  });

  it("orders step 10: the hold returns to the wallet in full with no cost, and the order carries the supplier's reason", async () => {
    const { db, merchant } = world;
    expect(await orderRow(db, orderId)).toMatchObject({
      status: 'rejected',
      dispatchState: 'done',
      resultCode: 'IMEI not supported',
      supplierRef: reference,
    });
    expect((await orderRow(db, orderId)).completedAt).not.toBeNull();
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'cogs')).toBe('0.0000');
    expect((await ledgerOf(db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold', 'order_release']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    const events = await eventsOf(db, orderId);
    expect(events.map((event) => event.type)).toEqual(['created', 'hold', 'dispatch', 'ack', 'rejected', 'release']);
    expect(events.at(-2)).toMatchObject({
      actorType: 'supplier',
      actorId: supplierId,
      data: { reason: 'IMEI not supported' },
    });
    expect(
      (await outboxOf(db, 'order.status_changed', orderId)).map(
        (row) => (row.payload as { toStatus: string }).toStatus,
      ),
    ).toEqual(['processing', 'rejected']);
  });

  it('step 12 (getimeiorder): the merchant reads STATUS 3 with the reason and gets the amount back', async () => {
    expect(await dhru.call('getimeiorder', { ID: String(orderId) })).toEqual({
      SUCCESS: [{ STATUS: 3, CODE: 'IMEI not supported' }],
      apiversion: '6.1',
    });
    expect((await dhru.call('accountinfo')).SUCCESS[0].AccoutInfo.credit).toBe('100.0000');
    const portal = await portalFor(t, world.merchant.id);
    const shown = json(await portal.get(`/client/orders/${orderId}`));
    expect(shown).toMatchObject({ status: 'rejected', result: { code: 'IMEI not supported' } });
    expect(json(await portal.get('/client/dashboard')).wallet).toBeDefined();
  });
});
