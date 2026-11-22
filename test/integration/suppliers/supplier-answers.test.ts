// What the order path does with a supplier's answer that holds characters the database refuses, text that is far too long or an answer
// that is far too large (decision 051): the order is still recorded and its call log row is still written. Real Postgres and Redis, the fake
// Dhru supplier, no BullMQ worker: the test calls the dispatch and poll logic the way the dispatch tests do.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { ErrorReporter } from '@src/infra/observability';
import { SupplierDispatch, SupplierPoll } from '@src/modules/suppliers';
import { CALL_RECORD_NOT_STORED } from '@src/modules/suppliers/application/supplier-sync';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { fundWallet } from '../../support/money';
import { IMEIS, eventsOf, json, orderRow, ordersWorld, portalFor, type OrdersWorld } from '../../support/orders';
import { FakeDhruSupplier, SupplierTestModule, automaticRoute, logsOf } from '../../support/suppliers';

const fake = new FakeDhruSupplier();
let t: TestApp;
let world: OrdersWorld;
let dispatch: SupplierDispatch;
let poll: SupplierPoll;
let serviceId = 0;
let supplierId = 0;

beforeAll(async () => {
  t = await createTestApp({ imports: [SupplierTestModule] });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  dispatch = t.app.get(SupplierDispatch, { strict: false });
  poll = t.app.get(SupplierPoll, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  fake.reset();
  await fundWallet(world.db, world.merchant.id, '100');
  ({ serviceId, supplierId } = await automaticRoute(
    world.db,
    t.app.get(EncryptionService, { strict: false }),
    fake,
    world.auto.categoryId,
  ));
});

/** The merchant places one order for the current service through the portal. */
async function place(): Promise<number> {
  const res = await (await portalFor(t, world.merchant.id)).post('/client/orders', { serviceId, imei: IMEIS[0] });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

/** Whether any stored text of an order, its timeline and its supplier calls holds U+0000. */
async function storedNul(orderId: number): Promise<boolean> {
  const rows = [
    await orderRow(world.db, orderId),
    ...(await eventsOf(world.db, orderId)),
    ...(await world.db.select().from(s.supplierApiLogs).where(eq(s.supplierApiLogs.orderId, orderId))),
  ];
  return JSON.stringify(rows).includes('\\u0000');
}

describe('an answer with characters the database refuses', () => {
  it('records an accepted order whose reference holds NUL and broken surrogates, with its call log row', async () => {
    fake.place({ accept: 'R\u0000-7\ud800' });
    const orderId = await place();
    const outcome = await dispatch.run(orderId, { lastAttempt: false });
    expect(outcome).toEqual({ status: 'sent', reference: 'R-7' });

    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'processing',
      dispatchState: 'sent',
      supplierRef: 'R-7',
    });
    const logs = (await logsOf(world.db, supplierId)).filter((log) => log.action === 'placeimeiorder');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ orderId, outcome: 'ok', httpStatus: 200 });
    expect(await storedNul(orderId)).toBe(false);
  });

  it('stops a refused order at a 500-character reason', async () => {
    fake.place({ refuse: 'x'.repeat(30_000) });
    const orderId = await place();
    const outcome = await dispatch.run(orderId, { lastAttempt: false });
    expect(outcome.status).toBe('needs_attention');

    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'needs_attention', supplierRef: null });
    const review = (await eventsOf(world.db, orderId)).at(-1)!;
    expect(review.type).toBe('review');
    const reason = (review.data as { reason: string }).reason;
    expect(reason.endsWith('x'.repeat(500))).toBe(true);
    expect(reason.match(/x/g)).toHaveLength(500);
    const [log] = (await logsOf(world.db, supplierId)).filter((row) => row.action === 'placeimeiorder');
    expect(log).toMatchObject({ outcome: 'error', error: 'x'.repeat(500) });
  });
});

describe('a call log row the database refuses', () => {
  it('keeps a minimal row of the call and reports the refused record once, and the order is sent', async () => {
    const orderId = await place();
    const db = t.app.get(DbService, { strict: false }).db;
    const insert = db.insert.bind(db);
    const capture = spyOn(t.app.get(ErrorReporter, { strict: false }), 'capture');
    let refusals = 1;
    // Only the first insert of the call log fails (as a record the database cannot hold would); the fallback row goes through.
    const failing = spyOn(db, 'insert').mockImplementation((table: unknown) => {
      if (table === s.supplierApiLogs && refusals > 0) {
        refusals -= 1;
        throw new Error('the record was refused');
      }
      return insert(table as never);
    });
    try {
      expect(await dispatch.run(orderId, { lastAttempt: false })).toEqual({
        status: 'sent',
        reference: fake.referenceOf(1),
      });
    } finally {
      failing.mockRestore();
    }

    expect(await orderRow(world.db, orderId)).toMatchObject({
      dispatchState: 'sent',
      supplierRef: fake.referenceOf(1),
    });
    const logs = (await logsOf(world.db, supplierId)).filter((log) => log.action === 'placeimeiorder');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      orderId,
      outcome: 'ok',
      httpStatus: 200,
      request: { action: 'placeimeiorder' },
      response: null,
      error: CALL_RECORD_NOT_STORED,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toMatchObject({ message: 'the record was refused' });
    capture.mockRestore();
  });
});

describe('a device number that ends in a character outside the basic plane', () => {
  it('stores the call log row in full for a request input and an answer member, with valid text', async () => {
    const orderId = await place();
    // The request input: the portal takes digits for an IMEI, so the stored value is set directly (another service's field takes any text).
    await world.db.update(s.orders).set({ imei: '3569\u{1F600}1\u{1F600}' }).where(eq(s.orders.id, orderId));
    fake.answerRaw(
      'placeimeiorder',
      JSON.stringify({ SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 'R-41', IMEI: 'ab\u{10348}c\u{10348}' }] }),
    );
    expect(await dispatch.run(orderId, { lastAttempt: false })).toEqual({ status: 'sent', reference: 'R-41' });

    const logs = (await logsOf(world.db, supplierId)).filter((row) => row.action === 'placeimeiorder');
    expect(logs).toHaveLength(1);
    // The full record, not the minimal row (which keeps only the action and names CALL_RECORD_NOT_STORED).
    expect(logs[0]).toMatchObject({ orderId, outcome: 'ok', httpStatus: 200, error: '' });
    expect(logs[0]!.request).toMatchObject({
      action: 'placeimeiorder',
      parameters: { IMEI: '••••••••9\u{1F600}1\u{1F600}' },
    });
    expect(logs[0]!.response).toEqual({
      SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 'R-41', IMEI: '••••••••b\u{10348}c\u{10348}' }],
    });
    expect(JSON.stringify([logs[0]!.request, logs[0]!.response]).isWellFormed()).toBe(true);
  });
});

describe('a status answer with a result the order cannot hold as it is', () => {
  /** Places an order, sends it and returns its id and the supplier's reference. */
  async function sentOrder(): Promise<{ orderId: number; reference: string }> {
    const orderId = await place();
    expect((await dispatch.run(orderId, { lastAttempt: false })).status).toBe('sent');
    return { orderId, reference: fake.referenceOf(1) };
  }

  it('completes an order whose result holds NUL, a lone surrogate and 25,000 characters', async () => {
    const { orderId, reference } = await sentOrder();
    fake.finish(reference, 4, `line one\r\nline two\u0000${'z'.repeat(25_000)}\ud800`);
    expect(await poll.check(orderId, { type: 'system' })).toEqual({ kind: 'completed' });

    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({ status: 'completed', dispatchState: 'done' });
    // The answer is cut to 20,000 characters first; the CRLF inside it then reads as one line feed.
    expect(order.resultCode!.startsWith('line one\nline two')).toBe(true);
    expect(order.resultCode).toHaveLength(19_999);
    expect(order.resultCode).not.toContain('\u0000');
    expect((await eventsOf(world.db, orderId)).map((event) => event.type)).toEqual([
      'created',
      'hold',
      'dispatch',
      'ack',
      'completed',
      'settle',
    ]);
    const log = (await logsOf(world.db, supplierId)).filter((row) => row.action === 'getimeiorder').at(-1)!;
    expect(log).toMatchObject({ orderId, outcome: 'ok' });
    expect(await storedNul(orderId)).toBe(false);
  });

  it('leaves an order as it was when the status answer is over 256 KiB, and records why', async () => {
    const { orderId } = await sentOrder();
    fake.answerRaw('getimeiorder', JSON.stringify({ SUCCESS: [{ STATUS: 4, CODE: 'x'.repeat(300_000) }] }));
    const outcome = await poll.check(orderId, { type: 'system' });
    expect(outcome.kind).toBe('unreachable');
    expect(
      (outcome as { message: string }).message.endsWith(
        "The supplier's answer is larger than 256 KiB; it was not read.",
      ),
    ).toBe(true);
    expect(await orderRow(world.db, orderId)).toMatchObject({ status: 'processing', dispatchState: 'sent' });
    const log = (await logsOf(world.db, supplierId)).filter((row) => row.action === 'getimeiorder').at(-1)!;
    expect(log).toMatchObject({ outcome: 'error', httpStatus: 0 });
  });
});
