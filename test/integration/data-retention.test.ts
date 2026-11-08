// Integration tests of the nightly IMEI retention (feature 18, the `data_retention` job, RESOLUTIONS b2c-4): which checks lose their
// IMEI at which age, the three columns that go together, the setting, the schedule on the maintenance queue and the job_runs row.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheModule } from '../../src/infra/cache';
import { CryptoModule, EncryptionService, TokenService } from '../../src/infra/crypto';
import { DbModule, type Database, schema as s } from '../../src/infra/db';
import { MetricsModule } from '../../src/infra/metrics';
import { JobSchedulerRegistry, QueueWorkers, QueueWorkersModule, QueuesModule } from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import {
  DATA_RETENTION_JOB,
  DATA_RETENTION_SCHEDULER,
  DataRetentionModule,
  IMEI_CHECK_AAD,
  imeiHashInput,
} from '../../src/modules/risk';
import { DataRetentionProcessor } from '../../src/modules/risk/jobs/imei-retention.processor';
import { ImeiRetention, RETENTION_BATCH } from '../../src/modules/risk/jobs/imei-retention';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { createInfra, type InfraHarness } from '../support/infra';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-08T03:00:00.000Z');
let harness: InfraHarness;
let db: Database;
let retention: ImeiRetention;

beforeAll(async () => {
  harness = await createInfra({
    modules: [
      MetricsModule,
      RedisModule,
      CacheModule,
      CryptoModule,
      DbModule,
      QueuesModule,
      QueueWorkersModule,
      DataRetentionModule,
    ],
    env: { BULL_PREFIX: prefix },
    clock,
  });
  await harness.get(QueueWorkers).whenReady();
  retention = harness.get(ImeiRetention);
  db = (await testDb()).db;
});
beforeEach(async () => {
  await resetDb();
  clock.set('2026-11-08T03:00:00.000Z');
  await harness.get(RedisService).cache.flushdb();
});
afterAll(async () => {
  await resetDb();
  await harness.close();
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
  await cleaner.close();
  await closeTestDb();
});

/** Inserts a check made `days` before the clock, with its IMEI stored. */
async function checkMadeDaysAgo(days: number, imei = '353890113898412', cachedUntil: Date | null = null) {
  const at = new Date(clock.nowMs() - days * DAY);
  const [row] = await db
    .insert(s.imeiChecks)
    .values({
      imeiHash: harness.get(TokenService).hash(imeiHashInput(imei)),
      imeiEnc: harness.get(EncryptionService).encrypt(imei, IMEI_CHECK_AAD),
      brand: 'Apple',
      model: 'iPhone 13',
      checkType: 'blacklist',
      status: 'clean',
      source: 'storefront_free',
      ip: '203.0.113.9',
      cachedUntil,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  return row!;
}
const rowOf = async (id: number) => (await db.select().from(s.imeiChecks).where(eq(s.imeiChecks.id, id)))[0]!;
const setRetention = (days: unknown) =>
  db
    .insert(s.settings)
    .values({ key: 'imeiRetentionDays', value: days })
    .onConflictDoUpdate({ target: s.settings.key, set: { value: days } });

describe('ImeiRetention', () => {
  it('erases the IMEI of checks older than the retention setting and keeps the rest, columns together', async () => {
    await setRetention(30);
    const old = await checkMadeDaysAgo(31, '353890113898412', new Date(clock.nowMs() + DAY));
    const edge = await checkMadeDaysAgo(29);
    const fresh = await checkMadeDaysAgo(1);
    expect(await retention.run()).toEqual({ days: 30, erased: 1 });
    expect(await rowOf(old.id)).toMatchObject({
      imeiEnc: null,
      imeiHash: null,
      cachedUntil: null,
      brand: 'Apple',
      status: 'clean',
    });
    expect((await rowOf(old.id)).updatedAt.toISOString()).toBe(clock.now().toISOString());
    expect((await rowOf(edge.id)).imeiEnc).not.toBeNull();
    expect((await rowOf(fresh.id)).imeiHash).not.toBeNull();
    // The age is judged on the clock: a month later the middle one goes too.
    clock.advance(3 * DAY);
    expect((await retention.run()).erased).toBe(1);
    expect((await rowOf(edge.id)).imeiEnc).toBeNull();
  });

  it('uses 180 days when the setting was never saved or holds something unusable', async () => {
    const old = await checkMadeDaysAgo(181);
    const kept = await checkMadeDaysAgo(179);
    expect(await retention.run()).toEqual({ days: 180, erased: 1 });
    await setRetention('forever');
    await harness.get(RedisService).cache.flushdb(); // the settings snapshot is cached for a minute
    expect((await retention.run()).days).toBe(180);
    expect((await rowOf(old.id)).imeiEnc).toBeNull();
    expect((await rowOf(kept.id)).imeiEnc).not.toBeNull();
  });

  it('does not keep the IMEI at all when the setting is 0', async () => {
    await setRetention(0);
    const check = await checkMadeDaysAgo(0);
    clock.advance(1000);
    expect((await retention.run()).erased).toBe(1);
    expect((await rowOf(check.id)).imeiEnc).toBeNull();
  });

  it('is idempotent: a second run finds nothing, and an erased row is not matched again', async () => {
    await setRetention(10);
    await checkMadeDaysAgo(40);
    expect((await retention.run()).erased).toBe(1);
    expect((await retention.run()).erased).toBe(0);
  });

  it('works through a backlog bigger than one batch', async () => {
    await setRetention(1);
    const at = new Date(clock.nowMs() - 5 * DAY);
    const rows = Array.from({ length: RETENTION_BATCH + 25 }, () => ({
      imeiHash: 'h',
      imeiEnc: 'e',
      brand: '',
      model: '',
      checkType: 'basic' as const,
      status: 'unknown' as const,
      source: 'storefront_free' as const,
      createdAt: at,
    }));
    await db.insert(s.imeiChecks).values(rows);
    expect((await retention.run()).erased).toBe(RETENTION_BATCH + 25);
  });
});

describe('the nightly job on a worker', () => {
  it('is scheduled at 03:00 UTC on the maintenance queue and its run is recorded in job_runs', async () => {
    expect(harness.get(JobSchedulerRegistry).list()).toContainEqual(
      expect.objectContaining({
        id: DATA_RETENTION_SCHEDULER,
        queue: 'maintenance',
        jobName: DATA_RETENTION_JOB,
        pattern: '0 3 * * *',
      }),
    );
    await setRetention(30);
    await checkMadeDaysAgo(60);
    const processor = harness.get(DataRetentionProcessor);
    expect(await processor.process({ data: {} } as Parameters<DataRetentionProcessor['process']>[0])).toEqual({
      erased: 1,
    });
    const runs = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, DATA_RETENTION_JOB));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'succeeded',
      processed: 1,
      result: { days: 30, erased: 1 },
    });
    expect(await processor.process({ data: {} } as Parameters<DataRetentionProcessor['process']>[0])).toEqual({
      erased: 0,
    });
  });
});
