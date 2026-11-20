// The dispatch sweep (decision 044): an order whose send was claimed and never answered goes to needs_attention after the supplier's timeout plus
// a margin, never sent again; an order whose dispatch request was lost is asked for again through the outbox, at most three times and never
// after a day; an order that never had a request is left alone; one order that cannot be moved does not stop the others. Real Postgres and
// Redis (a private BullMQ prefix, no workers), a TestClock, the processor called with a plain job object.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { QueuesService, queueJobId } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import { JobRunsService } from '@src/modules/health';
import { OrderSupplierMoves } from '@src/modules/orders';
import {
  ANSWER_NOT_RECORDED_REASON,
  DISPATCH_ANSWER_MARGIN_MS,
  DISPATCH_REQUEUE_AFTER_MS,
  DISPATCH_REQUEUE_MAX_AGE_MS,
  DISPATCH_SWEEP_JOB,
  DispatchSweep,
  DispatchSweepProcessor,
  MAX_AUTOMATIC_REQUEUES,
  REQUEUED_MESSAGE,
  REQUEUE_LIMIT_REASON,
  REQUEUE_TOO_OLD_REASON,
  SupplierJobsModule,
  type DispatchSweepData,
} from '@src/modules/suppliers';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  IMEIS,
  eventsOf,
  insertOrderRow,
  json,
  orderRow,
  ordersWorld,
  outboxOf,
  portalFor,
  walletOf,
  type OrdersWorld,
} from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { expectRejection, rejectionOf } from '../../support/rejection';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService } from '../../support/suppliers';

const TIMEOUT_MS = 10_000;
const clock = new TestClock();
const fake = new FakeDhruSupplier();
const prefix = testBullPrefix();
const EVENT = 'order.dispatch_requested';
let t: TestApp;
let world: OrdersWorld;
let sweep: DispatchSweep;
let processor: DispatchSweepProcessor;
let queues: QueuesService;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [SupplierTestModule, SupplierJobsModule], env: { BULL_PREFIX: prefix } });
  sweep = t.app.get(DispatchSweep, { strict: false });
  processor = t.app.get(DispatchSweepProcessor, { strict: false });
  queues = t.app.get(QueuesService, { strict: false });
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
  world = await ordersWorld((await testDb()).db);
});

/** The merchant places an order for the world's automatic service; nothing dispatches it (no workers, no relay). */
async function place(imei: string = IMEIS[0]): Promise<number> {
  const res = await (
    await portalFor(t, world.merchant.id)
  ).post('/client/orders', {
    serviceId: world.auto.serviceId,
    imei,
  });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

/** The order's dispatch requests, oldest first. */
const requestsOf = (orderId: number) => outboxOf(world.db, EVENT, orderId);

/** Marks every request of the order as handed to the queue, as the relay does (no job exists in the private prefix). */
async function relayed(orderId: number): Promise<void> {
  await world.db
    .update(s.outboxEvents)
    .set({ processedAt: clock.now() })
    .where(eq(s.outboxEvents.aggregateId, orderId));
}

const attention = (orderId: number) => orderRow(world.db, orderId);
const reasonOf = async (orderId: number) => (await eventsOf(world.db, orderId)).at(-1)!.data['reason'];

describe('a send whose answer never came', () => {
  /** A supplier with a link, and an order claimed the way the dispatch job claims it (the claim is the only thing that ran). */
  async function claimed(imei: string = IMEIS[0]): Promise<{ orderId: number; supplierId: number }> {
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake, {
      timeoutMs: TIMEOUT_MS,
    });
    const { supplierServiceId } = await linkService(world.db, world.auto.serviceId, supplierId);
    const orderId = await place(imei);
    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    const order = await world.db.transaction((tx) =>
      moves.claim(tx, { orderId, supplierId, supplierServiceId, unitCost: '13.5000', at: clock.now() }, 'Fake'),
    );
    expect(order).toMatchObject({ dispatchState: 'dispatching' });
    return { orderId, supplierId };
  }

  it('moves a claim to needs_attention after the supplier timeout plus the margin, never sooner, never sending', async () => {
    const { orderId } = await claimed();
    const hold = (await walletOf(world.db, world.merchant.id)).hold;

    clock.advance(TIMEOUT_MS + DISPATCH_ANSWER_MARGIN_MS);
    expect(await sweep.run()).toEqual({ unanswered: 0, requeued: 0, stopped: 0, movedOn: 0, unknown: 0 });
    expect((await attention(orderId)).dispatchState).toBe('dispatching');

    clock.advance(1);
    expect(await sweep.run()).toMatchObject({ unanswered: 1, requeued: 0, stopped: 0 });
    expect(await attention(orderId)).toMatchObject({ status: 'pending', dispatchState: 'needs_attention' });
    expect(await reasonOf(orderId)).toBe(ANSWER_NOT_RECORDED_REASON);
    expect((await eventsOf(world.db, orderId)).at(-1)).toMatchObject({ type: 'review', actorType: 'system' });
    expect((await walletOf(world.db, world.merchant.id)).hold).toBe(hold);
    expect(fake.calls).toHaveLength(0);

    // Nothing is left to move: a second run does nothing, and no new request was written.
    expect(await sweep.run()).toMatchObject({ unanswered: 0, requeued: 0, stopped: 0 });
    expect(await requestsOf(orderId)).toHaveLength(1);
  });

  it('treats a pending order with sent_at (a claim of an earlier release) the same way', async () => {
    const orderId = await place();
    await world.db.update(s.orders).set({ sentAt: clock.now() }).where(eq(s.orders.id, orderId));
    // No supplier is named, so the longest timeout the HTTP layer allows is the deadline.
    clock.advance(120_000 + DISPATCH_ANSWER_MARGIN_MS + 1);
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    expect(await attention(orderId)).toMatchObject({ dispatchState: 'needs_attention' });
    expect(await reasonOf(orderId)).toBe(ANSWER_NOT_RECORDED_REASON);
  });

  /** The time at which the sweep treats every claim made so far as lost. */
  const pastTheAnswerDeadline = () => clock.advance(TIMEOUT_MS + DISPATCH_ANSWER_MARGIN_MS + 5_000);

  it('counts an order that changed between the plan and the move as moved on, and moves nothing twice', async () => {
    const { orderId } = await claimed();
    pastTheAnswerDeadline();
    const plan = await sweep.plan();
    expect(plan.items).toEqual([{ kind: 'unanswered', orderId, sentAt: expect.any(Date) }]);

    // Another run moved it first.
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    expect(await sweep.apply(plan)).toEqual({ unanswered: 0, requeued: 0, stopped: 0, movedOn: 1, unknown: 0 });
    expect(await attention(orderId)).toMatchObject({ dispatchState: 'needs_attention' });
    const reviews = (await eventsOf(world.db, orderId)).filter((event) => event.type === 'review');
    expect(reviews).toHaveLength(1);
  });

  it('counts a lost request whose order was closed between the plan and the move as moved on', async () => {
    const orderId = await place();
    await relayed(orderId);
    clock.advance(DISPATCH_REQUEUE_AFTER_MS + 10_000);
    const plan = await sweep.plan();
    expect(plan.items).toEqual([{ kind: 'requeue', orderId }]);

    await world.db.update(s.orders).set({ status: 'rejected', dispatchState: 'done' }).where(eq(s.orders.id, orderId));
    expect(await sweep.apply(plan)).toEqual({ unanswered: 0, requeued: 0, stopped: 0, movedOn: 1, unknown: 0 });
    expect(await requestsOf(orderId)).toHaveLength(1);
  });

  it('keeps going when one order cannot be moved: the others are moved, then one error gives the counts and the first failure', async () => {
    const first = await claimed(IMEIS[0]);
    clock.advance(1_000);
    const second = await claimed(IMEIS[1]);
    pastTheAnswerDeadline();
    const plan = await sweep.plan();
    expect(plan.items.map((item) => item.orderId)).toEqual([first.orderId, second.orderId]);

    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    const failing = spyOn(moves, 'move').mockRejectedValueOnce(new Error('deadlock detected\nparams: secret'));
    let error: unknown;
    try {
      error = await rejectionOf(sweep.apply(plan));
    } finally {
      failing.mockRestore();
    }
    // One error with the counts and the first line of the first failure's message: nothing of the statement's parameters.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Dispatch sweep: moved 1, failed 1; first failure: deadlock detected');

    expect(await attention(first.orderId)).toMatchObject({ dispatchState: 'dispatching' });
    expect(await attention(second.orderId)).toMatchObject({ dispatchState: 'needs_attention' });
    // The next tick tries again and moves the one that failed.
    expect(await sweep.run()).toMatchObject({ unanswered: 1 });
    expect(await attention(first.orderId)).toMatchObject({ dispatchState: 'needs_attention' });
  });

  it('records the run as failed, through the processor, when one order cannot be moved', async () => {
    const first = await claimed(IMEIS[0]);
    clock.advance(1_000);
    const second = await claimed(IMEIS[1]);
    pastTheAnswerDeadline();

    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    const failing = spyOn(moves, 'move').mockRejectedValueOnce(new Error('deadlock detected'));
    try {
      await expectRejection(processor.process({ data: {} }), 'moved 1, failed 1');
    } finally {
      failing.mockRestore();
    }
    const runs = await world.db.select().from(s.jobRuns).where(eq(s.jobRuns.job, DISPATCH_SWEEP_JOB));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'failed' });
    expect(runs[0]!.error).toContain('moved 1, failed 1');
    expect(runs[0]!.error).toContain('deadlock detected');
    expect(await attention(first.orderId)).toMatchObject({ dispatchState: 'dispatching' });
    expect(await attention(second.orderId)).toMatchObject({ dispatchState: 'needs_attention' });
  });
});

describe('a dispatch request that was lost', () => {
  it('asks again for a pending order whose request was relayed and whose job is gone, once', async () => {
    const orderId = await place();
    await relayed(orderId);
    clock.advance(DISPATCH_REQUEUE_AFTER_MS + 10_000);

    expect(await sweep.run()).toMatchObject({ requeued: 1, stopped: 0, unanswered: 0 });
    expect(await requestsOf(orderId)).toHaveLength(2);
    expect((await eventsOf(world.db, orderId)).at(-1)).toMatchObject({
      type: 'retry',
      actorType: 'system',
      data: { message: REQUEUED_MESSAGE },
    });
    expect(await attention(orderId)).toMatchObject({ status: 'pending', dispatchState: 'pending', sentAt: null });
    // The new request is not relayed yet: a second run right after changes nothing.
    expect(await sweep.run()).toMatchObject({ requeued: 0, stopped: 0 });
    expect(await requestsOf(orderId)).toHaveLength(2);
  });

  it('leaves alone an order whose request is not relayed, whose job waits, or whose request is younger than 5 minutes', async () => {
    const young = await place(IMEIS[0]);
    await relayed(young);
    const unrelayed = await place(IMEIS[1]);
    const waiting = await place(IMEIS[2]);
    await relayed(waiting);
    const [row] = await requestsOf(waiting);
    await queues.add('supplier-dispatch', EVENT, {}, { jobId: queueJobId('outbox', row!.id) });

    clock.advance(DISPATCH_REQUEUE_AFTER_MS - 1_000);
    expect(await sweep.run()).toEqual({ unanswered: 0, requeued: 0, stopped: 0, movedOn: 0, unknown: 0 });

    // Once the young one is old enough it alone is asked for again.
    clock.advance(10_000);
    expect(await sweep.run()).toMatchObject({ requeued: 1 });
    expect(await requestsOf(young)).toHaveLength(2);
    expect(await requestsOf(unrelayed)).toHaveLength(1);
    expect(await requestsOf(waiting)).toHaveLength(1);
    for (const id of [young, unrelayed, waiting]) {
      expect(await attention(id)).toMatchObject({ dispatchState: 'pending', sentAt: null });
    }
    await queues.queue('supplier-dispatch').remove(queueJobId('outbox', row!.id));
  });

  it('stops an order after 3 automatic requests, and one whose newest request is older than 24 hours', async () => {
    const repeated = await place(IMEIS[0]);
    for (let round = 1; round <= MAX_AUTOMATIC_REQUEUES; round += 1) {
      await relayed(repeated);
      clock.advance(DISPATCH_REQUEUE_AFTER_MS + 10_000);
      expect(await sweep.run()).toMatchObject({ requeued: 1, stopped: 0 });
    }
    await relayed(repeated);
    clock.advance(DISPATCH_REQUEUE_AFTER_MS + 10_000);
    expect(await sweep.run()).toMatchObject({ requeued: 0, stopped: 1 });
    expect(await attention(repeated)).toMatchObject({ status: 'pending', dispatchState: 'needs_attention' });
    expect(await reasonOf(repeated)).toBe(REQUEUE_LIMIT_REASON);
    expect(await requestsOf(repeated)).toHaveLength(1 + MAX_AUTOMATIC_REQUEUES);

    const forgotten = await place(IMEIS[1]);
    await relayed(forgotten);
    clock.advance(DISPATCH_REQUEUE_MAX_AGE_MS + 1_000);
    expect(await sweep.run()).toMatchObject({ requeued: 0, stopped: 1 });
    expect(await attention(forgotten)).toMatchObject({ dispatchState: 'needs_attention' });
    expect(await reasonOf(forgotten)).toBe(REQUEUE_TOO_OLD_REASON);
    expect(await requestsOf(forgotten)).toHaveLength(1);
  });

  it('leaves an order whose jobs cannot be read for the next run', async () => {
    const orderId = await place();
    await relayed(orderId);
    clock.advance(DISPATCH_REQUEUE_AFTER_MS + 10_000);
    const reading = spyOn(queues.queue('supplier-dispatch'), 'getJobState').mockRejectedValue(
      new Error('Connection is closed.'),
    );
    try {
      expect(await sweep.run()).toEqual({ unanswered: 0, requeued: 0, stopped: 0, movedOn: 0, unknown: 1 });
      expect(await attention(orderId)).toMatchObject({ dispatchState: 'pending', sentAt: null });
      expect(await requestsOf(orderId)).toHaveLength(1);
    } finally {
      reading.mockRestore();
    }
    expect(await sweep.run()).toMatchObject({ requeued: 1, unknown: 0 });
  });
});

describe('the processor', () => {
  const job = (data: DispatchSweepData = {}) => ({ data });
  const runsOfSweep = () => world.db.select().from(s.jobRuns).where(eq(s.jobRuns.job, DISPATCH_SWEEP_JOB));

  it('writes a job_runs row only when the sweep acts, and for a manual run', async () => {
    // Nothing to do: no row.
    expect(await processor.process(job())).toEqual({ unanswered: 0, requeued: 0, stopped: 0, movedOn: 0, unknown: 0 });
    expect(await runsOfSweep()).toHaveLength(0);

    // Something to do: one scheduled row with the counts.
    const orderId = await place();
    await relayed(orderId);
    clock.advance(DISPATCH_REQUEUE_AFTER_MS + 10_000);
    expect(await processor.process(job())).toMatchObject({ requeued: 1 });
    const [row] = await runsOfSweep();
    expect(row).toMatchObject({
      job: DISPATCH_SWEEP_JOB,
      trigger: 'schedule',
      status: 'succeeded',
      processed: 1,
      result: { unanswered: 0, requeued: 1, stopped: 0, movedOn: 0, unknown: 0 },
    });

    // A manual run is recorded on the row the route inserted, even with nothing to do.
    const manual = await t.app
      .get(JobRunsService, { strict: false })
      .start({ job: DISPATCH_SWEEP_JOB, trigger: 'manual' });
    expect(await processor.process(job({ runId: manual.id }))).toMatchObject({ requeued: 0 });
    const finished = (await runsOfSweep()).find((run) => run.id === manual.id)!;
    expect(finished).toMatchObject({ trigger: 'manual', status: 'succeeded', processed: 0 });
    expect(await runsOfSweep()).toHaveLength(2);
  });
});

describe('an order that never had a dispatch request', () => {
  it('is left alone however old it is, while an order with a lost request is still asked for again', async () => {
    const old = new Date(clock.nowMs() - 3 * DISPATCH_REQUEUE_MAX_AGE_MS);
    // Inserted straight into the table, as a seeded demo order is: no outbox row, no timeline.
    const seeded = await insertOrderRow(world.db, {
      serviceId: world.auto.serviceId,
      clientId: world.merchant.id,
      status: 'pending',
      dispatchState: 'pending',
      placedAt: old,
    });
    const placed = await place();
    await relayed(placed);
    clock.advance(DISPATCH_REQUEUE_AFTER_MS + 10_000);

    expect(await sweep.run()).toEqual({ unanswered: 0, requeued: 1, stopped: 0, movedOn: 0, unknown: 0 });
    expect(await requestsOf(seeded.id)).toHaveLength(0);
    expect(await attention(seeded.id)).toMatchObject({ status: 'pending', dispatchState: 'pending', sentAt: null });
    expect(await requestsOf(placed)).toHaveLength(2);

    // Days later it is still left alone (it is not stopped as too old either); the new request of the other is still not relayed.
    clock.advance(3 * DISPATCH_REQUEUE_MAX_AGE_MS);
    expect(await sweep.run()).toEqual({ unanswered: 0, requeued: 0, stopped: 0, movedOn: 0, unknown: 0 });
    expect(await attention(seeded.id)).toMatchObject({ status: 'pending', dispatchState: 'pending', sentAt: null });
    expect(await requestsOf(seeded.id)).toHaveLength(0);
    expect((await eventsOf(world.db, seeded.id)).length).toBe(0);
  });
});

describe('orders the sweep never touches', () => {
  it('leaves needs_attention, manual, held, operator, sent and closed orders alone', async () => {
    const old = new Date(clock.nowMs() - 3 * DISPATCH_REQUEUE_MAX_AGE_MS);
    const common = { serviceId: world.auto.serviceId, clientId: world.merchant.id, placedAt: old, sentAt: old };
    const rows = [
      { status: 'pending', dispatchState: 'needs_attention' },
      { status: 'pending', dispatchState: 'manual', sentAt: null },
      { status: 'pending', dispatchState: 'held', sentAt: null },
      { status: 'processing', dispatchState: 'operator' },
      { status: 'processing', dispatchState: 'sent', supplierRef: 'R-1' },
      { status: 'completed', dispatchState: 'done' },
      { status: 'rejected', dispatchState: 'done' },
      { status: 'rejected', dispatchState: 'dispatching' },
    ] as const;
    const ids: number[] = [];
    for (const row of rows) ids.push((await insertOrderRow(world.db, { ...common, ...row })).id);
    clock.advance(DISPATCH_REQUEUE_MAX_AGE_MS);

    expect(await sweep.run()).toEqual({ unanswered: 0, requeued: 0, stopped: 0, movedOn: 0, unknown: 0 });
    for (const [index, id] of ids.entries()) {
      expect(await attention(id)).toMatchObject({
        status: rows[index]!.status,
        dispatchState: rows[index]!.dispatchState,
      });
      expect(await requestsOf(id)).toHaveLength(0);
    }
  });
});
