// Integration tests of the webhook delivery retention (decision 053): the daily job deletes finished deliveries created more than 90 days ago,
// keeps younger ones and every delivery that is still waiting for an attempt, works in batches, and records each run in `job_runs`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import {
  PlatformRetentionModule,
  WEBHOOK_DELIVERY_RETENTION_JOB,
  WebhookDeliveryRetentionProcessor,
} from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { insertMerchant } from '../../support/auth';
import { jobLike } from '../../support/campaigns';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { insertDelivery, insertEndpoint } from '../../support/webhooks';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-01T04:40:00.000Z');
let t: TestApp;
let db: Database;
let endpointId: number;

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [PlatformRetentionModule] });
});
beforeEach(async () => {
  clock.set('2026-11-01T04:40:00.000Z');
  await resetDb();
  const clientId = await insertMerchant(db);
  endpointId = await insertEndpoint(t.app.get(EncryptionService), db, clientId);
});
afterAll(async () => {
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

const run = (runId?: number) =>
  t.app.get(WebhookDeliveryRetentionProcessor).process(jobLike(runId === undefined ? {} : { runId }));
const ids = async () =>
  (await db.select({ id: s.webhookDeliveries.id }).from(s.webhookDeliveries))
    .map((row) => row.id)
    .sort((a, b) => a - b);
/** A delivery created at the test clock's time (the job judges age on the same clock). */
const delivery = (status: 'pending' | 'delivered' | 'failed') =>
  insertDelivery(db, endpointId, { status, createdAt: clock.now(), updatedAt: clock.now() });

describe('the webhook delivery retention', () => {
  it('deletes finished deliveries older than 90 days and keeps the rest', async () => {
    const delivered = await delivery('delivered');
    const failed = await delivery('failed');
    const pending = await delivery('pending');
    clock.advance(89 * DAY);
    const young = [await delivery('delivered'), await delivery('failed')];
    clock.advance(2 * DAY);
    // The first three are 91 days old, the other two 2 days: only the two finished old ones go; a pending one of 91 days stays.
    expect(await run()).toEqual({ deleted: 2 });
    expect(await ids()).toEqual([pending, ...young].sort((a, b) => a - b));
    expect(await ids()).not.toContain(delivered);
    expect(await ids()).not.toContain(failed);
  });

  it('keeps a delivery of 89 days and deletes one of 91', async () => {
    const edge = await delivery('delivered');
    clock.advance(89 * DAY);
    expect(await run()).toEqual({ deleted: 0 });
    clock.advance(2 * DAY);
    expect(await run()).toEqual({ deleted: 1 });
    expect(await ids()).not.toContain(edge);
  });

  it('works through a backlog in batches of 1000', async () => {
    await db.insert(s.webhookDeliveries).values(
      Array.from({ length: 2500 }, (_, index) => ({
        endpointId,
        event: 'order.status_changed',
        eventId: `evt_backlog_${index}`,
        payload: {
          id: `evt_backlog_${index}`,
          type: 'order.status_changed',
          createdAt: clock.now().toISOString(),
          data: {},
        },
        status: 'delivered' as const,
        attempt: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })),
    );
    clock.advance(91 * DAY);
    expect(await run()).toEqual({ deleted: 2500 });
    expect(await ids()).toEqual([]);
  });

  it('records the run', async () => {
    await delivery('failed');
    clock.advance(91 * DAY);
    expect(await run()).toEqual({ deleted: 1 });
    const [manual] = await db
      .insert(s.jobRuns)
      .values({ job: WEBHOOK_DELIVERY_RETENTION_JOB, trigger: 'manual', status: 'running', startedAt: clock.now() })
      .returning({ id: s.jobRuns.id });
    expect(await run(manual!.id)).toEqual({ deleted: 0 });
    const runs = await db
      .select()
      .from(s.jobRuns)
      .where(eq(s.jobRuns.job, WEBHOOK_DELIVERY_RETENTION_JOB))
      .orderBy(s.jobRuns.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1 });
    expect(runs[0]!.result).toEqual({ deleted: 1 });
    expect(runs[1]).toMatchObject({ id: manual!.id, trigger: 'manual', status: 'succeeded', processed: 0 });
  });

  it('is scheduled daily at 04:40 on the maintenance queue', () => {
    const entry = t.app
      .get(JobSchedulerRegistry)
      .list()
      .find((scheduler) => scheduler.id === 'webhook-delivery-retention');
    expect(entry).toMatchObject({
      queue: 'maintenance',
      jobName: WEBHOOK_DELIVERY_RETENTION_JOB,
      pattern: '40 4 * * *',
    });
  });
});
