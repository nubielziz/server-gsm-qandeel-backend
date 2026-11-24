// A supplier send in flight (decision 044): while the supplier call is held, the order is `dispatching` (the console still reads `pending`),
// the actions that would change it wait, and the answer applies only to its own claim; an acceptance that arrives after the order moved on,
// or whose own recording failed, is kept; an order claimed once is never cancelled by its merchant. Real Postgres and Redis, the fake Dhru
// supplier with a held answer, a TestClock, no sleeps.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Logger } from '@nestjs/common';
import { EncryptionService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { ErrorReporter } from '@src/infra/observability';
import { RedisService } from '@src/infra/redis';
import { OrderSupplierMoves, SEND_IN_PROGRESS_DETAIL } from '@src/modules/orders';
import { DISPATCH_ANSWER_MARGIN_MS, DispatchSweep, SupplierDispatch } from '@src/modules/suppliers';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertService } from '../../support/catalog';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearApiKeyCaches } from '../../support/machine-orders';
import {
  IMEIS,
  eventsOf,
  json,
  ledgerOf,
  orderRow,
  ordersWorld,
  portalFor,
  walletOf,
  type OrdersWorld,
} from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { expectRejection } from '../../support/rejection';
import {
  FakeDhruSupplier,
  SupplierTestModule,
  hold,
  insertFakeSupplier,
  linkService,
  logsOf,
} from '../../support/suppliers';

const TIMEOUT_MS = 10_000;
const clock = new TestClock();
const fake = new FakeDhruSupplier();
const prefix = testBullPrefix();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let dispatch: SupplierDispatch;
let sweep: DispatchSweep;
let supplierId: number;
let serviceId: number;
let sequence = 0;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [SupplierTestModule], env: { BULL_PREFIX: prefix } });
  dispatch = t.app.get(SupplierDispatch, { strict: false });
  sweep = t.app.get(DispatchSweep, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*', 'suppliers:*']);
});

/** A fresh automatic service (cancel allowed) whose only link goes to a fresh fake-backed supplier (answer timeout `timeoutMs`). */
async function freshRoute(timeoutMs: number = TIMEOUT_MS) {
  const { db } = world;
  supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake, { timeoutMs });
  sequence += 1;
  serviceId = await insertService(db, world.auto.categoryId, {
    name: `In-flight route ${sequence}`,
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
    allowCancel: true,
  });
  await linkService(db, serviceId, supplierId, { credit: '13.5000' });
}

async function place(imei: string = IMEIS[0]): Promise<number> {
  const res = await (await portalFor(t, world.merchant.id)).post('/client/orders', { serviceId, imei });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

/** Starts the job and returns once the supplier holds the call: the claim is committed and the answer is on its way. */
async function sendHeld(orderId: number) {
  const held = hold();
  fake.place({ hold: held });
  const running = dispatch.run(orderId, { lastAttempt: false });
  await held.arrived;
  return { held, running };
}

/** The answer time at which the sweep treats an unanswered claim as lost. */
const pastTheAnswerDeadline = () => clock.advance(TIMEOUT_MS + DISPATCH_ANSWER_MARGIN_MS + 1_000);

describe('the order is dispatching while the supplier call is in flight', () => {
  it('the claim marks the order dispatching while the console still reads pending (queue pending, sentAt set)', async () => {
    await freshRoute();
    const orderId = await place();
    const { held, running } = await sendHeld(orderId);

    const stored = await orderRow(world.db, orderId);
    expect(stored).toMatchObject({ status: 'pending', dispatchState: 'dispatching' });
    expect(stored.sentAt).not.toBeNull();
    const shown = (await staff.get(`/admin/orders/${orderId}`)).body;
    expect(shown).toMatchObject({ dispatchState: 'pending', queue: 'pending', status: 'pending' });
    expect(shown.sentAt).not.toBeNull();
    const listed = (await staff.get('/admin/orders?queue=pending')).body as Array<{ id: number }>;
    expect(listed.map((order) => order.id)).toContain(orderId);

    held.release();
    expect(await running).toEqual({ status: 'sent', reference: fake.referenceOf(1) });
    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'processing',
      dispatchState: 'sent',
      supplierRef: fake.referenceOf(1),
    });
  });

  it('a merchant cannot cancel while the supplier call is in flight', async () => {
    await freshRoute();
    const orderId = await place();
    const { held, running } = await sendHeld(orderId);
    const portal = await portalFor(t, world.merchant.id);

    const viaPortal = await portal.post(`/client/orders/${orderId}/cancel`);
    expect(viaPortal.statusCode).toBe(409);
    expect(json(viaPortal).code).toBe('ALREADY_SENT');

    held.release();
    await running;
    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'processing',
      dispatchState: 'sent',
      supplierRef: fake.referenceOf(1),
    });
    const types = (await eventsOf(world.db, orderId)).map((event) => event.type);
    expect(types).not.toContain('rejected');
    expect(types).not.toContain('release');
    expect((await ledgerOf(world.db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold']);
  });

  it('canCancel is false on the portal while the call is in flight', async () => {
    await freshRoute();
    const orderId = await place();
    const portal = await portalFor(t, world.merchant.id);
    expect(json(await portal.get(`/client/orders/${orderId}`)).canCancel).toBe(true);

    const { held, running } = await sendHeld(orderId);
    expect(json(await portal.get(`/client/orders/${orderId}`)).canCancel).toBe(false);
    held.release();
    await running;
  });

  it('staff reply and reject wait for the answer: 409 ALREADY_SENT with the wait sentence, no ledger move', async () => {
    await freshRoute();
    const orderId = await place();
    const { held, running } = await sendHeld(orderId);

    const reply = await staff.post(`/admin/orders/${orderId}/reply`, { code: 'Unlocked' });
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: 'ALREADY_SENT', detail: SEND_IN_PROGRESS_DETAIL });
    const reject = await staff.post(`/admin/orders/${orderId}/reject`, { reason: 'Blacklisted' });
    expect(reject.status).toBe(409);
    expect(reject.body).toMatchObject({ code: 'ALREADY_SENT', detail: SEND_IN_PROGRESS_DETAIL });

    held.release();
    await running;
    expect(await orderRow(world.db, orderId)).toMatchObject({ status: 'processing', dispatchState: 'sent' });
    expect((await ledgerOf(world.db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold']);
  });

  it('staff dispatch and every change of supplier wait: one placeimeiorder in all, the order keeps its supplier and reference', async () => {
    await freshRoute();
    const second = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake, {
      name: `Second ${sequence}`,
    });
    await linkService(world.db, serviceId, second, { remoteId: '9001', priority: 2, credit: '14.0000' });
    const orderId = await place();
    const { held, running } = await sendHeld(orderId);

    const attempts = [
      await staff.post(`/admin/orders/${orderId}/dispatch`, {}),
      await staff.post(`/admin/orders/${orderId}/change-supplier`, { supplierId: second, resetReference: true }),
      await staff.post(`/admin/orders/${orderId}/change-supplier`, {
        supplierId: second,
        resetReference: true,
        dispatch: true,
      }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(409);
      expect(attempt.body).toMatchObject({ code: 'ALREADY_SENT', detail: SEND_IN_PROGRESS_DETAIL });
    }

    held.release();
    await running;
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    expect(await orderRow(world.db, orderId)).toMatchObject({
      supplierId,
      supplierRef: fake.referenceOf(1),
      dispatchState: 'sent',
    });
  });

  it('a bulk reply lists an order being sent among the failed items', async () => {
    await freshRoute();
    const orderId = await place();
    const { held, running } = await sendHeld(orderId);
    const res = await staff.post('/admin/orders/bulk-reply/apply', { items: [{ orderId, code: 'Unlocked' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: 0, failed: [{ orderId, title: SEND_IN_PROGRESS_DETAIL }] });
    held.release();
    await running;
    expect((await orderRow(world.db, orderId)).status).toBe('processing');
  });
});

describe('an acceptance that arrives after the order moved on', () => {
  it('is recorded when the sweep moved the order first: the reference is stored, a review line names it, the error is reported', async () => {
    await freshRoute();
    const orderId = await place();
    const reporter = t.app.get(ErrorReporter, { strict: false });
    const capture = spyOn(reporter, 'capture');
    const { held, running } = await sendHeld(orderId);

    pastTheAnswerDeadline();
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'needs_attention', supplierRef: null });

    held.release();
    expect(await running).toEqual({ status: 'skipped', reason: 'moved_on' });
    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({
      status: 'pending',
      dispatchState: 'needs_attention',
      supplierRef: fake.referenceOf(1),
    });
    const newest = (await eventsOf(world.db, orderId)).at(-1)!;
    expect(newest).toMatchObject({ type: 'review', actorType: 'supplier', actorId: supplierId });
    expect(newest.data).toMatchObject({ ref: fake.referenceOf(1), referenceStored: true });
    const shown = (await staff.get(`/admin/orders/${orderId}`)).body;
    expect(shown).toMatchObject({ queue: 'needs_attention', supplierRef: fake.referenceOf(1) });
    expect(shown.reviewReason).toContain('accepted this order');
    expect(capture).toHaveBeenCalledTimes(1);
    capture.mockRestore();
  });

  it('stops a waiting order that was queued for another send: no second send follows', async () => {
    await freshRoute();
    const orderId = await place();
    const { held, running } = await sendHeld(orderId);
    pastTheAnswerDeadline();
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    expect((await staff.post(`/admin/orders/${orderId}/dispatch`, {})).status).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'pending', sentAt: null });

    held.release();
    expect(await running).toEqual({ status: 'skipped', reason: 'moved_on' });
    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'pending',
      dispatchState: 'needs_attention',
      supplierRef: fake.referenceOf(1),
    });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
  });

  it('never lands on a later claim: the second send keeps its reference and the first answer is only a review line', async () => {
    await freshRoute();
    const orderId = await place();
    const { held, running } = await sendHeld(orderId);
    pastTheAnswerDeadline();
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    expect((await staff.post(`/admin/orders/${orderId}/dispatch`, {})).status).toBe(204);
    fake.place('accept');
    expect(await dispatch.run(orderId, { lastAttempt: false })).toEqual({
      status: 'sent',
      reference: fake.referenceOf(2),
    });

    held.release();
    expect(await running).toEqual({ status: 'skipped', reason: 'moved_on' });
    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'processing',
      dispatchState: 'sent',
      supplierRef: fake.referenceOf(2),
    });
    const lines = (await eventsOf(world.db, orderId)).filter(
      (event) => event.type === 'review' && event.actorType === 'supplier',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toMatchObject({ ref: fake.referenceOf(1), referenceStored: false });
    expect(
      await eventsOf(world.db, orderId).then((events) => events.filter((event) => event.type === 'dispatch')),
    ).toHaveLength(2);
  });

  it("an order that staff closed while the old call was out keeps the supplier's reference on its timeline", async () => {
    await freshRoute();
    const orderId = await place();
    const { held, running } = await sendHeld(orderId);
    pastTheAnswerDeadline();
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    // Staff answer the order themselves while the old call is still out.
    expect((await staff.post(`/admin/orders/${orderId}/reply`, { code: 'Unlocked by hand' })).status).toBe(204);
    held.release();
    expect(await running).toEqual({ status: 'skipped', reason: 'moved_on' });
    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({ status: 'completed', dispatchState: 'done', supplierRef: fake.referenceOf(1) });
    const line = (await eventsOf(world.db, orderId)).at(-1)!;
    expect(line).toMatchObject({ type: 'review', actorType: 'supplier' });
    expect(line.data).toMatchObject({ referenceStored: true });
  });
});

describe('an order that was claimed for a supplier call once is never cancelled by its merchant', () => {
  const portalRow = async (portal: Awaited<ReturnType<typeof portalFor>>, orderId: number) =>
    (json(await portal.get('/client/orders')) as Array<{ id: number; canCancel: boolean }>).find(
      (order) => order.id === orderId,
    );

  it('refuses the cancel after a supplier timeout and a staff send again, on the portal: the hold stays, canCancel is false', async () => {
    await freshRoute(300);
    fake.place('accept-then-hang');
    const orderId = await place();
    const portal = await portalFor(t, world.merchant.id);
    expect(await portalRow(portal, orderId)).toMatchObject({ canCancel: true });
    const hold = (await walletOf(world.db, world.merchant.id)).hold;

    // The supplier did not answer in time: the order waits for a person, and the merchant already may not cancel it.
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'needs_attention' });
    const refused = await portal.post(`/client/orders/${orderId}/cancel`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'ALREADY_SENT' });

    // Staff send it again, but the dispatch job has not run: the order reads pending with no claim, as before the first attempt.
    expect((await staff.post(`/admin/orders/${orderId}/dispatch`, {})).status).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'pending',
      dispatchState: 'pending',
      sentAt: null,
    });

    const viaPortal = await portal.post(`/client/orders/${orderId}/cancel`);
    expect(viaPortal.statusCode).toBe(409);
    expect(json(viaPortal).code).toBe('ALREADY_SENT');
    // The plain sentence of a sent order, not the "being sent" one.
    expect(json(viaPortal).detail).not.toBe(SEND_IN_PROGRESS_DETAIL);
    expect(json(viaPortal).detail).toContain('already has this order');

    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'pending',
      dispatchState: 'pending',
      sentAt: null,
    });
    expect((await walletOf(world.db, world.merchant.id)).hold).toBe(hold);
    const types = (await eventsOf(world.db, orderId)).map((event) => event.type);
    expect(types).not.toContain('rejected');
    expect(types).not.toContain('release');
    expect((await ledgerOf(world.db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold']);
    expect(await portalRow(portal, orderId)).toMatchObject({ canCancel: false });
    expect(json(await portal.get(`/client/orders/${orderId}`)).canCancel).toBe(false);
  });

  it('still cancels an order that was never claimed, and shows canCancel true until then', async () => {
    await freshRoute();
    const orderId = await place(IMEIS[0]);
    const portal = await portalFor(t, world.merchant.id);
    expect(await portalRow(portal, orderId)).toMatchObject({ canCancel: true });
    expect(json(await portal.get(`/client/orders/${orderId}`)).canCancel).toBe(true);

    expect((await portal.post(`/client/orders/${orderId}/cancel`)).statusCode).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({ status: 'rejected', dispatchState: 'done' });
    expect((await ledgerOf(world.db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold', 'order_release']);
    expect(fake.callsOf('placeimeiorder')).toHaveLength(0);
  });
});

describe("a supplier's acceptance is never lost when its recording fails", () => {
  it('keeps the reference and one review line when the answer cannot be recorded, fails the job, and never sends again on the retry', async () => {
    await freshRoute();
    const orderId = await place();
    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    const reporter = t.app.get(ErrorReporter, { strict: false });
    const capture = spyOn(reporter, 'capture');
    // The first move after the claim is the answer's own transaction.
    const failing = spyOn(moves, 'move').mockRejectedValueOnce(new Error('connection reset'));

    await expectRejection(dispatch.run(orderId, { lastAttempt: false }), 'connection reset');
    failing.mockRestore();

    // The order keeps its claim, with the supplier's reference stored and one review line that says what happened.
    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({ status: 'pending', dispatchState: 'dispatching', supplierRef: fake.referenceOf(1) });
    expect(order.sentAt).not.toBeNull();
    const reviews = (await eventsOf(world.db, orderId)).filter((event) => event.type === 'review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ actorType: 'supplier', actorId: supplierId });
    expect(reviews[0]!.data).toMatchObject({ ref: fake.referenceOf(1), referenceStored: true });
    expect(reviews[0]!.data.reason).toContain('could not be recorded');
    expect(reviews[0]!.data.reason).toContain(fake.referenceOf(1));
    expect(capture).toHaveBeenCalledTimes(1);

    // The queue's retry finds the claim and sends nothing; the sweep moves the order later, with the reference kept.
    expect(await dispatch.run(orderId, { lastAttempt: false })).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    pastTheAnswerDeadline();
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    expect(await orderRow(world.db, orderId)).toMatchObject({
      dispatchState: 'needs_attention',
      supplierRef: fake.referenceOf(1),
    });
    capture.mockRestore();
  });

  it('sends the order with its reference when the call log cannot be written, and reports it once', async () => {
    await freshRoute();
    const orderId = await place();
    const db = t.app.get(DbService, { strict: false }).db;
    const insert = db.insert.bind(db);
    const reporter = t.app.get(ErrorReporter, { strict: false });
    const capture = spyOn(reporter, 'capture');
    // Only the call log's insert fails; the claim and the answer run on transactions, which are other objects.
    const failing = spyOn(db, 'insert').mockImplementation((table: unknown) => {
      if (table === s.supplierApiLogs) throw new Error('log table unavailable');
      return insert(table as never);
    });

    expect(await dispatch.run(orderId, { lastAttempt: false })).toEqual({
      status: 'sent',
      reference: fake.referenceOf(1),
    });
    failing.mockRestore();

    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'processing',
      dispatchState: 'sent',
      supplierRef: fake.referenceOf(1),
    });
    expect(await logsOf(world.db, supplierId)).toHaveLength(0);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'log table unavailable' }),
      expect.objectContaining({ queue: 'supplier-dispatch' }),
    );
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    capture.mockRestore();
  });

  it('never throws when recording a late acceptance itself fails: it is logged and reported, and the job ends as moved on', async () => {
    await freshRoute();
    const orderId = await place();
    const reporter = t.app.get(ErrorReporter, { strict: false });
    const capture = spyOn(reporter, 'capture');
    const { held, running } = await sendHeld(orderId);
    pastTheAnswerDeadline();
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });

    const failure = new Error('database unavailable');
    const recording = spyOn(
      t.app.get(OrderSupplierMoves, { strict: false }),
      'recordLateAcceptance',
    ).mockRejectedValueOnce(failure);
    const logger = (dispatch as unknown as { logger: Logger }).logger;
    const logged = spyOn(logger, 'error').mockImplementation(() => undefined);
    held.release();

    expect(await running).toEqual({ status: 'skipped', reason: 'moved_on' });
    recording.mockRestore();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain('could not be recorded');
    logged.mockRestore();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toBe(failure);
    // Nothing was recorded for the acceptance: the order stays where the sweep put it.
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'needs_attention', supplierRef: null });
    capture.mockRestore();
  });
});
