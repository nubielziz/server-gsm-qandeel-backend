// Integration tests of the daily `idempotency_purge` job (P4a, MISMATCHES B166): a REST v1 Idempotency-Key is remembered for 7 days; after
// that the stored answer is gone, `orders.idempotency_key` is cleared and the key places a new order. Also the schedule and the job_runs row.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheModule } from '../../src/infra/cache';
import { DbModule, schema as s } from '../../src/infra/db';
import { MetricsModule } from '../../src/infra/metrics';
import { JobSchedulerRegistry, QueueWorkers, QueueWorkersModule, QueuesModule } from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import {
  IDEMPOTENCY_PURGE_BATCH_SIZE,
  IDEMPOTENCY_PURGE_JOB,
  IDEMPOTENCY_PURGE_SCHEDULER,
  IDEMPOTENCY_WINDOW_DAYS,
  IdempotencyPurge,
  IdempotencyPurgeModule,
  IdempotencyPurgeProcessor,
} from '../../src/modules/orders';
import { MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { createInfra, type InfraHarness } from '../support/infra';
import { type MachineCredentials, body, clearApiKeyCaches, credentialsFor, v1Client } from '../support/machine-orders';
import { IMEIS, type OrdersWorld, ordersWorld } from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock();
let t: TestApp;
let worker: InfraHarness;
let world: OrdersWorld;
let creds: MachineCredentials;
let v1: ReturnType<typeof v1Client>;
let purge: IdempotencyPurge;

beforeAll(async () => {
  t = await createTestApp({ clock });
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
  await t.close();
  await closeTestDb();
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
  await cleaner.close();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await t.app.get(MaintenanceService).invalidate();
  const { db } = await testDb();
  world = await ordersWorld(db);
  creds = await credentialsFor(t, db, world.merchant.id);
  v1 = v1Client(t, creds.key);
});

/** Places one order under a key. */
const place = (key: string, payload: Record<string, unknown> = {}) =>
  v1.post('/v1/orders', { serviceId: world.auto.serviceId, imei: IMEIS[0], ...payload }, { 'idempotency-key': key });

/** Finishes every order, so the duplicate rule (one open order per merchant, service and input) does not refuse a new one. */
async function finishOrders(): Promise<void> {
  const { db } = await testDb();
  await db.update(s.orders).set({ status: 'completed', dispatchState: 'done', resultCode: 'Done' });
}

describe('idempotency_purge', () => {
  it('frees a key older than the window: a new order, not a replay, and the old answer and order key are gone', async () => {
    const { db } = await testDb();
    const first = await place('retry-1');
    expect(first.statusCode).toBe(201);
    await finishOrders();
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY + HOUR);
    expect(await purge.purge()).toEqual({ answers: 1, orderKeys: 1 });
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(s.orders)
          .where(eq(s.orders.id, body(first).id))
      )[0]!.idempotencyKey,
    ).toBeNull();

    const again = await place('retry-1');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBeUndefined();
    expect(body(again).id).not.toBe(body(first).id);
    const orders = await db.select().from(s.orders).orderBy(s.orders.id);
    expect(orders.map((order) => order.idempotencyKey)).toEqual([null, 'retry-1']);
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(1);
  });

  it('keeps a key younger than the window: it still replays, and the purge changes nothing', async () => {
    const { db } = await testDb();
    const first = await place('young');
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY - HOUR);
    expect(await purge.purge()).toEqual({ answers: 0, orderKeys: 0 });
    const replay = await place('young');
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(body(replay)).toEqual(body(first));
    expect(await db.select().from(s.orders)).toHaveLength(1);
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(1);
  });

  it('purges by age: the old key goes, the key placed 5 days later stays and replays', async () => {
    const { db } = await testDb();
    const old = await place('old-key');
    clock.advance(5 * DAY);
    const young = await place('young-key', { imei: IMEIS[1] });
    expect(young.statusCode).toBe(201);
    clock.advance(3 * DAY);
    expect(await purge.purge()).toEqual({ answers: 1, orderKeys: 1 });
    expect((await db.select().from(s.idempotencyKeys)).map((row) => row.key)).toEqual(['young-key']);
    const replay = await place('young-key', { imei: IMEIS[1] });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(body(replay).id).toBe(body(young).id);
    // The old key is free: the open first order is still there, so the same body is the duplicate rule's refusal, not a replay or a 409 REUSED.
    const freed = await place('old-key');
    expect(freed.headers['idempotency-replayed']).toBeUndefined();
    expect(body(freed).code).toBe('DUPLICATE_ORDER');
    expect(body(freed).orderId).toBe(body(old).id);
  });

  it('forgets a bulk call with its answer: no order carries the key, the stored answer is deleted and the key serves another request', async () => {
    const { db } = await testDb();
    const bulk = await v1.post(
      '/v1/orders/bulk',
      {
        orders: [
          { serviceId: world.auto.serviceId, imei: IMEIS[0] },
          { serviceId: world.auto.serviceId, imei: IMEIS[1] },
        ],
      },
      { 'idempotency-key': 'bulk-1' },
    );
    expect(bulk.statusCode).toBe(200);
    // Two items: the answer is stored, no order carries the key.
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(1);
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY + HOUR);
    expect(await purge.purge()).toEqual({ answers: 1, orderKeys: 0 });
    const other = await place('bulk-1', { imei: IMEIS[2] });
    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotency-replayed']).toBeUndefined();
  });

  it('touches nothing else: orders without a key, young orders and their updated_at stay as they are', async () => {
    const { db } = await testDb();
    const keyed = body(await place('keep-me'));
    const plain = await v1.post('/v1/orders', { serviceId: world.auto.serviceId, imei: IMEIS[3] });
    expect(plain.statusCode).toBe(201);
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY + HOUR);
    const before = await db.select().from(s.orders).orderBy(s.orders.id);
    await purge.purge();
    const after = await db.select().from(s.orders).orderBy(s.orders.id);
    expect(after.map((order) => order.idempotencyKey)).toEqual([null, null]);
    expect(after.map((order) => order.updatedAt.getTime())).toEqual(before.map((order) => order.updatedAt.getTime()));
    expect(after.map((order) => ({ ...order, idempotencyKey: null }))).toEqual(
      before.map((order) => ({ ...order, idempotencyKey: null })),
    );
    expect(before[0]!.id).toBe(keyed.id);
  });

  it('deletes in batches until none is left, and a second run finds nothing', async () => {
    const { db } = await testDb();
    const count = IDEMPOTENCY_PURGE_BATCH_SIZE + 25;
    // Decision 031: the rows are written at the clock's time and aged by moving the clock, never by writing a past time into a row.
    await db.insert(s.idempotencyKeys).values(
      Array.from({ length: count }, (_, index) => ({
        clientId: world.merchant.id,
        key: `bulk-key-${index}`,
        scope: 'order' as const,
        requestHash: 'a'.repeat(64),
        status: 201,
        response: {},
        createdAt: clock.now(),
      })),
    );
    clock.advance((IDEMPOTENCY_WINDOW_DAYS + 1) * DAY);
    await db.insert(s.idempotencyKeys).values({
      clientId: world.merchant.id,
      key: 'recent',
      scope: 'order',
      requestHash: 'b'.repeat(64),
      status: 201,
      response: {},
      createdAt: clock.now(),
    });
    expect(await purge.purge()).toEqual({ answers: count, orderKeys: 0 });
    expect((await db.select().from(s.idempotencyKeys)).map((row) => row.key)).toEqual(['recent']);
    expect(await purge.purge()).toEqual({ answers: 0, orderKeys: 0 });
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
    const { db } = await testDb();
    await place('job-run');
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY + HOUR);
    const processor = worker.get(IdempotencyPurgeProcessor);
    const job = { data: {} } as Parameters<IdempotencyPurgeProcessor['process']>[0];
    expect(await processor.process(job)).toEqual({ answers: 1, orderKeys: 1 });
    const runs = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, IDEMPOTENCY_PURGE_JOB));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'succeeded',
      processed: 2,
      result: { answers: 1, orderKeys: 1 },
    });
    expect(await processor.process(job)).toEqual({ answers: 0, orderKeys: 0 });
    expect(await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, IDEMPOTENCY_PURGE_JOB))).toHaveLength(2);
  });
});
