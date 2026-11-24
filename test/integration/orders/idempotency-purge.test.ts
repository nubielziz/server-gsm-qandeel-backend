// Integration tests of the daily `idempotency_purge` job (P4a, MISMATCHES B166): a merchant portal Idempotency-Key is remembered for 7 days;
// after that the stored answer is gone and the key is free again. Also the schedule and the job_runs row.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheModule } from '@src/infra/cache';
import { DbModule, type Database, schema as s } from '@src/infra/db';
import { MetricsModule } from '@src/infra/metrics';
import { JobSchedulerRegistry, QueueWorkers, QueueWorkersModule, QueuesModule } from '@src/infra/queues';
import { RedisModule, RedisService } from '@src/infra/redis';
import {
  IDEMPOTENCY_PURGE_BATCH_SIZE,
  IDEMPOTENCY_PURGE_JOB,
  IDEMPOTENCY_PURGE_SCHEDULER,
  IDEMPOTENCY_WINDOW_DAYS,
  IdempotencyPurge,
  IdempotencyPurgeModule,
  IdempotencyPurgeProcessor,
} from '@src/modules/orders';
import { DAY, HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { createInfra, type InfraHarness } from '../../support/infra';
import { type OrdersWorld, insertOrderRow, ordersWorld } from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock();
let worker: InfraHarness;
let world: OrdersWorld;
let db: Database;
let purge: IdempotencyPurge;

beforeAll(async () => {
  ({ db } = await testDb());
  worker = await createInfra({
    modules: [
      MetricsModule,
      RedisModule,
      CacheModule,
      DbModule,
      QueuesModule,
      QueueWorkersModule,
      IdempotencyPurgeModule,
    ],
    env: { BULL_PREFIX: prefix },
    clock,
  });
  await worker.get(QueueWorkers).whenReady();
  purge = worker.get(IdempotencyPurge);
});
afterAll(async () => {
  await resetDb();
  await worker.close();
  await closeTestDb();
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
  await cleaner.close();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  world = await ordersWorld(db);
});

/** Stores the answer of a portal placement under a key, at the clock's time (decision 031: rows are aged by moving the clock). */
async function storeAnswer(key: string, scope: 'portal' | 'order' | 'bulk' = 'portal'): Promise<void> {
  await db.insert(s.idempotencyKeys).values({
    clientId: world.merchant.id,
    key,
    scope,
    requestHash: 'c'.repeat(64),
    status: 201,
    response: { orders: [] },
    createdAt: clock.now(),
  });
}

describe('idempotency_purge', () => {
  it('frees a key older than the window: the stored answer is deleted', async () => {
    await storeAnswer('retry-1');
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY + HOUR);
    expect(await purge.purge()).toEqual({ answers: 1 });
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(0);
  });

  it('keeps a key younger than the window: the purge changes nothing', async () => {
    await storeAnswer('young');
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY - HOUR);
    expect(await purge.purge()).toEqual({ answers: 0 });
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(1);
  });

  it('purges by age: the old key goes, the key stored 5 days later stays', async () => {
    await storeAnswer('old-key');
    clock.advance(5 * DAY);
    await storeAnswer('young-key');
    clock.advance(3 * DAY);
    expect(await purge.purge()).toEqual({ answers: 1 });
    expect((await db.select().from(s.idempotencyKeys)).map((row) => row.key)).toEqual(['young-key']);
  });

  it('forgets the answers of every scope, the ones stored by the retired REST API v1 included', async () => {
    await storeAnswer('portal-old', 'portal');
    await storeAnswer('order-old', 'order');
    await storeAnswer('bulk-old', 'bulk');
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY + HOUR);
    expect(await purge.purge()).toEqual({ answers: 3 });
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(0);
  });

  it('touches nothing else: an old order stays as it is, and so does its updated_at', async () => {
    await insertOrderRow(world.db, { accountId: world.merchant.id, serviceId: world.auto.serviceId });
    await storeAnswer('keep-orders');
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY + HOUR);
    const before = await db.select().from(s.orders).orderBy(s.orders.id);
    expect(await purge.purge()).toEqual({ answers: 1 });
    const after = await db.select().from(s.orders).orderBy(s.orders.id);
    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it('deletes in batches until none is left, and a second run finds nothing', async () => {
    const count = IDEMPOTENCY_PURGE_BATCH_SIZE + 25;
    // Decision 031: the rows are written at the clock's time and aged by moving the clock, never by writing a past time into a row.
    await db.insert(s.idempotencyKeys).values(
      Array.from({ length: count }, (_, index) => ({
        clientId: world.merchant.id,
        key: `bulk-key-${index}`,
        scope: 'portal' as const,
        requestHash: 'a'.repeat(64),
        status: 201,
        response: {},
        createdAt: clock.now(),
      })),
    );
    clock.advance((IDEMPOTENCY_WINDOW_DAYS + 1) * DAY);
    await storeAnswer('recent');
    expect(await purge.purge()).toEqual({ answers: count });
    expect((await db.select().from(s.idempotencyKeys)).map((row) => row.key)).toEqual(['recent']);
    expect(await purge.purge()).toEqual({ answers: 0 });
  });
});

describe('the daily job on a worker', () => {
  it('is scheduled at 04:10 UTC on the maintenance queue and records its run in job_runs', async () => {
    expect(worker.get(JobSchedulerRegistry).list()).toContainEqual(
      expect.objectContaining({
        id: IDEMPOTENCY_PURGE_SCHEDULER,
        queue: 'maintenance',
        jobName: IDEMPOTENCY_PURGE_JOB,
        pattern: '10 4 * * *',
      }),
    );
    await storeAnswer('job-run');
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY + HOUR);
    const processor = worker.get(IdempotencyPurgeProcessor);
    const job = { data: {} } as Parameters<IdempotencyPurgeProcessor['process']>[0];
    expect(await processor.process(job)).toEqual({ answers: 1 });
    const runs = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, IDEMPOTENCY_PURGE_JOB));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'succeeded',
      processed: 1,
      result: { answers: 1 },
    });
    expect(await processor.process(job)).toEqual({ answers: 0 });
    expect(await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, IDEMPOTENCY_PURGE_JOB))).toHaveLength(2);
  });
});
