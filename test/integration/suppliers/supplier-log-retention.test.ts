// Integration tests of the supplier call log retention (decision 053): the daily job deletes call logs older than 90 days, keeps the younger
// ones, works in batches and records each run in `job_runs`. Real Postgres and Redis (a private BullMQ prefix, no workers), a TestClock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import {
  SUPPLIER_LOG_RETENTION_JOB,
  SUPPLIER_SCHEDULERS,
  SupplierJobsModule,
  SupplierLogRetentionProcessor,
} from '@src/modules/suppliers';
import { type TestApp, createTestApp } from '../../support/app';
import { jobLike } from '../../support/campaigns';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { SupplierTestModule, insertBareSupplier } from '../../support/suppliers';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-01T04:50:00.000Z');
let t: TestApp;
let db: Database;
let supplierId: number;

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock, imports: [SupplierTestModule, SupplierJobsModule], env: { BULL_PREFIX: prefix } });
});
beforeEach(async () => {
  clock.set('2026-11-01T04:50:00.000Z');
  await resetDb();
  supplierId = await insertBareSupplier(db);
});
afterAll(async () => {
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

const run = (runId?: number) =>
  t.app.get(SupplierLogRetentionProcessor).process(jobLike(runId === undefined ? {} : { runId }));
const ids = async () =>
  (await db.select({ id: s.supplierApiLogs.id }).from(s.supplierApiLogs)).map((row) => row.id).sort((a, b) => a - b);
/** A call log row created at the test clock's time (the job judges age on the same clock). */
async function call(action = 'getimeiorder'): Promise<number> {
  const [row] = await db
    .insert(s.supplierApiLogs)
    .values({ supplierId, action, outcome: 'ok', durationMs: 120, createdAt: clock.now() })
    .returning({ id: s.supplierApiLogs.id });
  return row!.id;
}

describe('the supplier log retention', () => {
  it('deletes supplier call logs older than 90 days', async () => {
    const old = [await call(), await call('placeimeiorder')];
    clock.advance(89 * DAY);
    const young = await call();
    expect(await run()).toEqual({ deleted: 0 });
    clock.advance(2 * DAY);
    expect(await run()).toEqual({ deleted: 2 });
    expect(await ids()).toEqual([young]);
    for (const id of old) expect(await ids()).not.toContain(id);
    // A second run finds nothing.
    expect(await run()).toEqual({ deleted: 0 });
  });

  it('works through a backlog in batches of 1000', async () => {
    await db.insert(s.supplierApiLogs).values(
      Array.from({ length: 2300 }, () => ({
        supplierId,
        action: 'getimeiorder',
        outcome: 'ok' as const,
        durationMs: 10,
        createdAt: clock.now(),
      })),
    );
    clock.advance(91 * DAY);
    expect(await run()).toEqual({ deleted: 2300 });
    expect(await ids()).toEqual([]);
  });

  it('records the run', async () => {
    await call();
    clock.advance(91 * DAY);
    expect(await run()).toEqual({ deleted: 1 });
    const [manual] = await db
      .insert(s.jobRuns)
      .values({ job: SUPPLIER_LOG_RETENTION_JOB, trigger: 'manual', status: 'running', startedAt: clock.now() })
      .returning({ id: s.jobRuns.id });
    expect(await run(manual!.id)).toEqual({ deleted: 0 });
    const runs = await db
      .select()
      .from(s.jobRuns)
      .where(eq(s.jobRuns.job, SUPPLIER_LOG_RETENTION_JOB))
      .orderBy(s.jobRuns.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1 });
    expect(runs[0]!.result).toEqual({ deleted: 1 });
    expect(runs[1]).toMatchObject({ id: manual!.id, trigger: 'manual', status: 'succeeded', processed: 0 });
  });

  it('is scheduled daily at 04:50 on the maintenance queue', () => {
    const entry = t.app
      .get(JobSchedulerRegistry)
      .list()
      .find((scheduler) => scheduler.id === SUPPLIER_SCHEDULERS.logRetention);
    expect(SUPPLIER_SCHEDULERS.logRetention).toBe('supplier-log-retention');
    expect(entry).toMatchObject({ queue: 'maintenance', jobName: SUPPLIER_LOG_RETENTION_JOB, pattern: '50 4 * * *' });
  });
});
