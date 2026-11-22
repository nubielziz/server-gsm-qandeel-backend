// Integration tests of the lost-work pass of storefront refunds (decision 055, scenario b2c-refund step 6) on the real application, Postgres
// and the queue Redis (a private BullMQ prefix): a refund whose `refund.process` job was lost is asked for again after 10 minutes, a live
// request is waited for, three lost re-requests (or a send that started more than 20 hours ago) fail the refund with a note and keep its
// gateway key, refunds that do not wait for a send are never touched, a type without a route or an unreadable queue Redis decides nothing,
// and a request another run wrote after the plan is seen when the plan applies. "Lost" stands for what a queue Redis that lost its data
// leaves: the event is handed over (processed, at the clock's time) and no job of its id exists. The clock moves; nothing is backdated.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { type Database, DbService, schema as s } from '@src/infra/db';
import { QueuesService, queueJobId } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import {
  REFUND_PROCESS_EVENT,
  REFUND_SEND_LOST_NOTE,
  RefundOutbox,
  RefundProcessModule,
  RefundSender,
} from '@src/modules/money';
import { LostWorkModule, LostWorkReconcile, OutboxRequests, OutboxRouteRegistry } from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { GatewayTestModule } from '../../support/billing';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, paidOrder } from '../../support/b2c';
import { HOUR, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { orderRow } from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({
    clock,
    env: { BULL_PREFIX: prefix },
    imports: [GatewayTestModule, RefundProcessModule, LostWorkModule],
  });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  world = await b2cWorld(t, db, fake);
  staff = await adminWith(t, ['refunds:*', 'orders:*']);
});

const reconcile = () => t.app.get(LostWorkReconcile, { strict: false }).run();
const coordinator = () => t.app.get(LostWorkReconcile, { strict: false });
const requests = () => t.app.get(OutboxRequests, { strict: false });
const maintenance = () => t.app.get(QueuesService).queue('maintenance');
const refundRow = async (id: number) => (await db.select().from(s.refunds).where(eq(s.refunds.id, id)))[0]!;
const requestsOf = (refundId: number) =>
  db
    .select()
    .from(s.outboxEvents)
    .where(and(eq(s.outboxEvents.type, 'refund.process'), eq(s.outboxEvents.aggregateId, refundId)))
    .orderBy(desc(s.outboxEvents.id));

/** A customer's refund request on a paid order, approved by staff: `processing`, its `refund.process` event written. */
async function approvedRefund(): Promise<{ refundId: number; paid: PaidOrder }> {
  const order = await paidOrder(t, clock, world);
  const customerId = (await orderRow(db, order.orderId)).customerId!;
  const [row] = await db
    .insert(s.refunds)
    .values({
      paymentId: order.paymentId,
      orderId: order.orderId,
      customerId,
      amount: order.charged,
      currency: 'GBP',
      reason: 'The code did not work',
      method: 'original',
      status: 'requested',
      requestedByType: 'customer',
      requestedById: customerId,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning();
  const res = await staff.post(`/admin/refunds/${row!.id}/approve`, {});
  expect(res.status).toBe(200);
  return { refundId: row!.id, paid: order };
}

/** The relay handed the newest request over and the queue then lost its job. */
async function loseNewestRequest(refundId: number): Promise<number> {
  const [newest] = await requestsOf(refundId);
  await db.update(s.outboxEvents).set({ processedAt: clock.now() }).where(eq(s.outboxEvents.id, newest!.id));
  await maintenance().remove(queueJobId('outbox', newest!.id));
  return newest!.id;
}

describe('the refund pass of the lost-work reconcile (decision 055)', () => {
  it('asks again for a refund whose send job was lost', async () => {
    const { refundId } = await approvedRefund();
    await loseNewestRequest(refundId);
    clock.advance(11 * MINUTE);

    const result = await reconcile();
    expect(result.passes.refunds).toMatchObject({ checked: 1, requested: 1, gaveUp: 0 });
    const [again, first] = await requestsOf(refundId);
    expect(first).toBeDefined();
    expect(again?.payload).toMatchObject({ refundId, reconcile: true });
    expect(again?.processedAt).toBeNull();

    // The job of the new request sends the refund under the key the lost one would have used.
    expect(await t.app.get(RefundSender, { strict: false }).send(refundId, false)).toBe('completed');
    expect(fake.calls('/v1/refunds').map((call) => call.headers['idempotency-key'])).toEqual([`refund-${refundId}`]);
    // A second run finds nothing to do.
    clock.advance(11 * MINUTE);
    expect((await reconcile()).passes.refunds).toMatchObject({ checked: 0, requested: 0 });
  });

  it('leaves a refund alone while its job waits or is delayed, while it is not relayed yet, and before 10 minutes', async () => {
    const { refundId } = await approvedRefund();
    // Not relayed yet.
    clock.advance(11 * MINUTE);
    expect((await reconcile()).passes.refunds).toMatchObject({ checked: 1, requested: 0 });
    // Relayed, and its job waits on the queue (no worker runs in this app).
    const eventId = await loseNewestRequest(refundId);
    await maintenance().add('refund.process', { eventId }, { jobId: queueJobId('outbox', eventId) });
    expect((await reconcile()).passes.refunds).toMatchObject({ checked: 1, requested: 0 });
    // Delayed.
    await maintenance().remove(queueJobId('outbox', eventId));
    await maintenance().add('refund.process', { eventId }, { jobId: queueJobId('outbox', eventId), delay: HOUR });
    expect((await reconcile()).passes.refunds).toMatchObject({ checked: 1, requested: 0 });
    expect(await requestsOf(refundId)).toHaveLength(1);

    // A refund approved 9 minutes ago whose job is already gone is not judged yet.
    const second = await approvedRefund();
    await loseNewestRequest(second.refundId);
    clock.advance(9 * MINUTE);
    expect((await reconcile()).passes.refunds?.requested).toBe(0);
    expect(await requestsOf(second.refundId)).toHaveLength(1);
  });

  it('fails the refund with a note after three lost re-requests, keeping its gateway key', async () => {
    const { refundId } = await approvedRefund();
    const before = await refundRow(refundId);
    await loseNewestRequest(refundId);
    for (let round = 1; round <= 3; round++) {
      clock.advance(11 * MINUTE);
      expect((await reconcile()).passes.refunds, `round ${round}`).toMatchObject({ requested: 1, gaveUp: 0 });
      await loseNewestRequest(refundId);
    }
    clock.advance(11 * MINUTE);
    expect((await reconcile()).passes.refunds).toMatchObject({ requested: 0, gaveUp: 1 });
    const failed = await refundRow(refundId);
    expect(failed).toMatchObject({ status: 'failed', note: REFUND_SEND_LOST_NOTE, sendAttempt: before.sendAttempt });
    expect(await requestsOf(refundId)).toHaveLength(4);

    // The console's retry sends it again, under the same key (staff sign in again: the clock moved past the idle limit).
    staff = await adminWith(t, ['refunds:*', 'orders:*']);
    const retried = await staff.post(`/admin/refunds/${refundId}/retry`, {});
    expect(retried.status).toBe(200);
    expect(await t.app.get(RefundSender, { strict: false }).send(refundId, false)).toBe('completed');
    expect(fake.calls('/v1/refunds').map((call) => call.headers['idempotency-key'])).toEqual([`refund-${refundId}`]);
  });

  it('fails the refund with a note when its send started more than 20 hours ago', async () => {
    const { refundId } = await approvedRefund();
    await loseNewestRequest(refundId);
    clock.advance(21 * HOUR);
    expect((await reconcile()).passes.refunds).toMatchObject({ requested: 0, gaveUp: 1 });
    expect(await refundRow(refundId)).toMatchObject({ status: 'failed', note: REFUND_SEND_LOST_NOTE, sendAttempt: 1 });
    expect(await requestsOf(refundId)).toHaveLength(1);
  });

  it('never touches a refund with a gateway reference, a manual one, or one that is no longer processing', async () => {
    const withReference = await approvedRefund();
    const manual = await approvedRefund();
    const done = await approvedRefund();
    await db.update(s.refunds).set({ gatewayRefundId: 're_pending_1' }).where(eq(s.refunds.id, withReference.refundId));
    await db.update(s.refunds).set({ method: 'manual' }).where(eq(s.refunds.id, manual.refundId));
    await db.update(s.refunds).set({ status: 'completed' }).where(eq(s.refunds.id, done.refundId));
    for (const { refundId } of [withReference, manual, done]) await loseNewestRequest(refundId);
    clock.advance(11 * MINUTE);

    expect((await reconcile()).passes.refunds).toMatchObject({ checked: 0, requested: 0, gaveUp: 0 });
    for (const { refundId } of [withReference, manual, done]) expect(await requestsOf(refundId)).toHaveLength(1);
  });

  it('answers unknown, never none, for a type no route names in this process or a queue Redis that cannot be read, and asks for nothing', async () => {
    const { refundId } = await approvedRefund();
    await loseNewestRequest(refundId);
    clock.advance(11 * MINUTE);
    // The lost request itself reads "none": the cases below differ from it only by what the process can read.
    expect((await requests().inspect(db, REFUND_PROCESS_EVENT, 'refunds', refundId)).state).toBe('none');

    // A handed-over request of a type no route of this process names.
    await db.insert(s.outboxEvents).values({
      type: 'no.such.type',
      aggregateType: 'refunds',
      aggregateId: refundId,
      payload: { refundId },
      processedAt: clock.now(),
      createdAt: clock.now(),
    });
    expect((await requests().inspect(db, 'no.such.type', 'refunds', refundId)).state).toBe('unknown');

    // The refund pass in a process without the route of refund.process: the refund counts as unknown and makes no item.
    const routes = t.app.get(OutboxRouteRegistry, { strict: false });
    const routesOf = routes.routesOf.bind(routes);
    const noRoute = spyOn(routes, 'routesOf').mockImplementation((type: string) =>
      type === REFUND_PROCESS_EVENT ? [] : routesOf(type),
    );
    try {
      const plans = await coordinator().plan();
      expect(plans.plans.get('refunds')).toEqual({ checked: 1, unknown: 1, exhausted: 0, items: [] });
      expect((await coordinator().apply(plans)).passes.refunds).toEqual({
        checked: 1,
        unknown: 1,
        exhausted: 0,
        requested: 0,
        gaveUp: 0,
      });
    } finally {
      noRoute.mockRestore();
    }

    // A queue Redis whose job states cannot be read decides nothing either.
    const queue = maintenance();
    const unreadable = spyOn(queue, 'getJobState').mockRejectedValue(new Error('Connection is closed.'));
    try {
      expect((await requests().inspect(db, REFUND_PROCESS_EVENT, 'refunds', refundId)).state).toBe('unknown');
      expect((await reconcile()).passes.refunds).toEqual({
        checked: 1,
        unknown: 1,
        exhausted: 0,
        requested: 0,
        gaveUp: 0,
      });
    } finally {
      unreadable.mockRestore();
    }
    expect(await requestsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({ status: 'processing' });
  });

  it('a request another run wrote after the plan is seen when the plan applies: no second request, no give-up', async () => {
    const { refundId } = await approvedRefund();
    await loseNewestRequest(refundId);
    clock.advance(11 * MINUTE);
    const asked = await coordinator().plan();
    expect(asked.plans.get('refunds')?.items).toEqual([{ action: 'request', id: refundId, data: { sendAttempt: 1 } }]);
    // Meanwhile another run (a manual one beside the schedule) asked first; its request is not relayed yet, so it is live.
    await t.app
      .get(DbService)
      .runInTransaction(({ tx }) => t.app.get(RefundOutbox, { strict: false }).refundAgain(tx, refundId));
    expect((await coordinator().apply(asked)).passes.refunds).toMatchObject({ requested: 0, gaveUp: 0 });
    expect(await requestsOf(refundId)).toHaveLength(2);

    // The same for a give-up: a refund whose send started more than 20 hours ago is not failed while a request is live.
    const late = await approvedRefund();
    await loseNewestRequest(late.refundId);
    clock.advance(21 * HOUR);
    const givingUp = await coordinator().plan();
    expect(givingUp.plans.get('refunds')?.items).toContainEqual({
      action: 'give_up',
      id: late.refundId,
      data: { sendAttempt: 1 },
    });
    await t.app
      .get(DbService)
      .runInTransaction(({ tx }) => t.app.get(RefundOutbox, { strict: false }).refundAgain(tx, late.refundId));
    await coordinator().apply(givingUp);
    expect(await refundRow(late.refundId)).toMatchObject({ status: 'processing' });
    expect(await requestsOf(late.refundId)).toHaveLength(2);
  });
});
