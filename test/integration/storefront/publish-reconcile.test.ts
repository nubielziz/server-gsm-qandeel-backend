// Integration tests of the lost-work pass of bulk publish runs (decision 055, plan 31 section 6) on the real application, Postgres and the
// queue Redis (a private BullMQ prefix): a queued apply, a queued run switch and an unclaimed preparation whose job was lost are asked for
// again with the same event (`reconcile: true`), a claimed preparation is not, and after three re-requests nothing is written. "Lost"
// stands for what a queue Redis that lost its data leaves: the event is handed over (processed, at the clock's time) and no job of its id
// exists. The clock moves; nothing is backdated.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { DbService, type Database, schema as s } from '@src/infra/db';
import { QueuesService, queueJobId } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import {
  LOST_WORK_RECONCILE_JOB,
  LostWorkModule,
  LostWorkReconcile,
  LostWorkReconcileProcessor,
} from '@src/modules/platform';
import { PublishWorkerModule } from '@src/modules/storefront';
import {
  PUBLISH_APPLY_EVENT,
  PUBLISH_PREPARE_EVENT,
  PUBLISH_SET_LISTED_EVENT,
  PublishOutbox,
} from '@src/modules/storefront/publish/application/publish-outbox';
import { type TestApp, createTestApp } from '../../support/app';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedRun } from '../../support/publish';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-22T09:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [LostWorkModule, PublishWorkerModule] });
});
beforeEach(async () => {
  clock.set('2026-11-22T09:00:00.000Z');
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
});
afterAll(async () => {
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

const outbox = () => t.app.get(PublishOutbox, { strict: false });
const reconcile = () => t.app.get(LostWorkReconcile, { strict: false }).run();
const eventsOf = (type: string, runId: number) =>
  db
    .select()
    .from(s.outboxEvents)
    .where(and(eq(s.outboxEvents.type, type), eq(s.outboxEvents.aggregateId, runId)))
    .orderBy(desc(s.outboxEvents.id));

/** Writes a request of a run in its own transaction, as the routes do. */
const write = (work: (tx: Parameters<Parameters<DbService['runInTransaction']>[0]>[0]['tx']) => Promise<void>) =>
  t.app.get(DbService).runInTransaction(({ tx }) => work(tx));

/** The relay handed the newest request of the type over and the queue then lost its job. */
async function loseNewest(type: string, runId: number): Promise<void> {
  const [newest] = await eventsOf(type, runId);
  await db.update(s.outboxEvents).set({ processedAt: clock.now() }).where(eq(s.outboxEvents.id, newest!.id));
  await t.app.get(QueuesService).queue('imports').remove(queueJobId('outbox', newest!.id));
}

describe('the publish run pass of the lost-work reconcile (decision 055)', () => {
  it('asks again for the apply of a queued run whose job was lost', async () => {
    const run = await seedRun(t, [], { status: 'queued' });
    await write((tx) => outbox().applyRequested(tx, run.id));
    await loseNewest(PUBLISH_APPLY_EVENT, run.id);
    clock.advance(11 * MINUTE);

    expect((await reconcile()).passes.publish_runs).toMatchObject({ checked: 1, requested: 1 });
    const [again] = await eventsOf(PUBLISH_APPLY_EVENT, run.id);
    expect(again?.payload).toMatchObject({ runId: run.id, reconcile: true });
    expect(again?.processedAt).toBeNull();
  });

  it('asks again for a lost switch with its target and the staff member of the last request', async () => {
    const run = await seedRun(t, [], { status: 'succeeded', switchStatus: 'queued', switchListed: false });
    await write((tx) => outbox().switchRequested(tx, run.id, false, 42));
    await loseNewest(PUBLISH_SET_LISTED_EVENT, run.id);
    clock.advance(11 * MINUTE);

    expect((await reconcile()).passes.publish_runs).toMatchObject({ checked: 1, requested: 1 });
    const [again] = await eventsOf(PUBLISH_SET_LISTED_EVENT, run.id);
    expect(again?.payload).toMatchObject({ runId: run.id, listed: false, requestedBy: 42, reconcile: true });
  });

  it('asks again for the preparation of a run nobody claimed, never for one a worker claimed', async () => {
    const unclaimed = await seedRun(t, [], { status: 'preparing', preparedAt: null });
    const claimed = await seedRun(t, [], { status: 'preparing', preparedAt: null, prepareClaimedAt: clock.now() });
    for (const run of [unclaimed, claimed]) {
      await write((tx) => outbox().prepareRequested(tx, run.id));
      await loseNewest(PUBLISH_PREPARE_EVENT, run.id);
    }
    clock.advance(11 * MINUTE);

    expect((await reconcile()).passes.publish_runs).toMatchObject({ checked: 1, requested: 1 });
    expect((await eventsOf(PUBLISH_PREPARE_EVENT, unclaimed.id))[0]?.payload).toMatchObject({ reconcile: true });
    expect(await eventsOf(PUBLISH_PREPARE_EVENT, claimed.id)).toHaveLength(1);
  });

  it('gives up after three re-requests without writing anything', async () => {
    const run = await seedRun(t, [], { status: 'queued' });
    await write((tx) => outbox().applyRequested(tx, run.id));
    await loseNewest(PUBLISH_APPLY_EVENT, run.id);
    for (let round = 1; round <= 3; round++) {
      clock.advance(11 * MINUTE);
      expect((await reconcile()).passes.publish_runs, `round ${round}`).toMatchObject({ requested: 1 });
      await loseNewest(PUBLISH_APPLY_EVENT, run.id);
    }
    clock.advance(11 * MINUTE);
    const runsBefore = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, LOST_WORK_RECONCILE_JOB));
    const plans = await t.app.get(LostWorkReconcile, { strict: false }).plan();
    expect(plans.plans.get('publish_runs')).toMatchObject({ checked: 1, exhausted: 1, items: [] });
    // A scheduled run therefore writes nothing, not even a job_runs row.
    const result = await t.app.get(LostWorkReconcileProcessor, { strict: false }).process({ data: {} });
    expect(result.passes.publish_runs).toMatchObject({ exhausted: 1, requested: 0, gaveUp: 0 });
    expect(await eventsOf(PUBLISH_APPLY_EVENT, run.id)).toHaveLength(4);
    expect(await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, LOST_WORK_RECONCILE_JOB))).toHaveLength(
      runsBefore.length,
    );
  });
});
