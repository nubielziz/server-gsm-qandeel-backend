// Integration tests of the `storefront_popularity` job (feature 22, slice B): 30-day order counts by service from every channel,
// rejected orders left out, the 30-day edge, idempotence (a repeat changes nothing and never moves updated_at), job_runs, the
// schedule, and the popular sort of the public list.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheModule } from '../../src/infra/cache';
import { DbModule, schema as s } from '../../src/infra/db';
import { MetricsModule } from '../../src/infra/metrics';
import { JobSchedulerRegistry, QueueWorkers, QueueWorkersModule, QueuesModule } from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import { JobRunsService } from '../../src/modules/health';
import {
  PopularityRefresh,
  STOREFRONT_POPULARITY_JOB,
  STOREFRONT_POPULARITY_SCHEDULER,
  StorefrontPopularityModule,
} from '../../src/modules/storefront';
import { PopularityProcessor } from '../../src/modules/storefront/jobs/popularity.processor';
import { type TestApp, createTestApp } from '../support/app';
import { DAY, HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertMerchant } from '../support/auth';
import { createInfra, type InfraHarness } from '../support/infra';
import { insertOrderRow } from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { insertCustomerRow, insertStoreOrder, storefrontWorld } from '../support/storefront';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let worker: InfraHarness;
let refresh: PopularityRefresh;

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
      StorefrontPopularityModule,
    ],
    env: { BULL_PREFIX: prefix },
    clock,
  });
  await worker.get(QueueWorkers).whenReady();
  refresh = worker.get(PopularityRefresh);
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
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
});

const salesOf = async () => {
  const { db } = await testDb();
  const rows = await db.select().from(s.serviceListings).orderBy(s.serviceListings.id);
  return Object.fromEntries(rows.map((row) => [row.id, row.sales30d]));
};

describe('PopularityRefresh', () => {
  it('counts the non-rejected orders of the last 30 days per service from every channel and writes them to every language row', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const arListing = (
      await db
        .insert(s.serviceListings)
        .values({ serviceId: world.att.serviceId, locale: 'ar', slug: 'att-ar', publicTitle: 'AT&T', isListed: true })
        .returning({ id: s.serviceListings.id })
    )[0]!.id;
    const customer = await insertCustomerRow(db);
    const merchant = await insertMerchant(db);
    const att = world.att.serviceId;
    await insertStoreOrder(db, att, customer);
    await insertStoreOrder(db, att, customer, { status: 'completed' });
    await insertOrderRow(db, { serviceId: att, clientId: merchant, source: 'portal' });
    await insertStoreOrder(db, att, customer, { status: 'rejected' });
    await insertStoreOrder(db, world.icloud.serviceId, customer);
    // Older than the window: not counted.
    await insertStoreOrder(db, att, customer, { createdAt: new Date(clock.nowMs() - 31 * DAY) });

    expect(await refresh.refresh()).toEqual({ services: 2, changed: 3 });
    expect(await salesOf()).toEqual({
      [world.icloud.listingId]: 1,
      [world.att.listingId]: 3,
      [arListing]: 3,
    });
  });

  it('keeps an order created exactly 30 days ago and drops it a moment later', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const customer = await insertCustomerRow(db);
    await insertStoreOrder(db, world.att.serviceId, customer, { createdAt: new Date(clock.nowMs() - 30 * DAY) });
    await refresh.refresh();
    expect((await salesOf())[world.att.listingId]).toBe(1);
    clock.advance(1_000);
    await refresh.refresh();
    expect((await salesOf())[world.att.listingId]).toBe(0);
  });

  it('is idempotent: a repeat writes nothing, and updated_at never moves', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const customer = await insertCustomerRow(db);
    await insertStoreOrder(db, world.att.serviceId, customer);
    const before = (await db.select().from(s.serviceListings).orderBy(s.serviceListings.id)).map((row) =>
      row.updatedAt.getTime(),
    );

    expect(await refresh.refresh()).toEqual({ services: 1, changed: 1 });
    expect(await refresh.refresh()).toEqual({ services: 1, changed: 0 });
    const rows = await db.select().from(s.serviceListings).orderBy(s.serviceListings.id);
    expect(rows.map((row) => row.updatedAt.getTime())).toEqual(before);
    expect(rows.map((row) => row.sales30d)).toEqual([0, 1]);
    // Parallel runs end at the same state.
    await Promise.all([refresh.refresh(), refresh.refresh(), refresh.refresh()]);
    expect(Object.values(await salesOf())).toEqual([0, 1]);
  });

  it('lowers a count when orders age out or a service sells nothing any more', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const customer = await insertCustomerRow(db);
    // The order's created_at is written by hand: the database stamps its own clock, not the test clock.
    await insertStoreOrder(db, world.att.serviceId, customer, { createdAt: new Date(clock.nowMs()) });
    await refresh.refresh();
    expect((await salesOf())[world.att.listingId]).toBe(1);
    clock.advance(31 * DAY);
    expect(await refresh.refresh()).toEqual({ services: 0, changed: 1 });
    expect((await salesOf())[world.att.listingId]).toBe(0);
  });
});

describe('the job on a worker', () => {
  it('is scheduled every 30 minutes on the maintenance queue and records its runs in job_runs', async () => {
    expect(worker.get(JobSchedulerRegistry).list()).toContainEqual(
      expect.objectContaining({
        id: STOREFRONT_POPULARITY_SCHEDULER,
        queue: 'maintenance',
        jobName: STOREFRONT_POPULARITY_JOB,
        pattern: '*/30 * * * *',
      }),
    );
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await insertStoreOrder(db, world.att.serviceId, await insertCustomerRow(db));
    const processor = worker.get(PopularityProcessor);
    const job = (data: { runId?: number }) => ({ data }) as Parameters<PopularityProcessor['process']>[0];

    expect(await processor.process(job({}))).toEqual({ services: 1, changed: 1 });
    const runs = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, STOREFRONT_POPULARITY_JOB));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'succeeded',
      processed: 1,
      result: { services: 1, changed: 1 },
    });

    // A manual run closes the row the route inserted instead of adding another.
    const manual = await worker
      .get(JobRunsService)
      .start({ job: STOREFRONT_POPULARITY_JOB, trigger: 'manual', overlap: 'refuse' });
    expect(await processor.process(job({ runId: manual.id }))).toEqual({ services: 1, changed: 0 });
    expect((await db.select().from(s.jobRuns).where(eq(s.jobRuns.id, manual.id)))[0]).toMatchObject({
      trigger: 'manual',
      status: 'succeeded',
      processed: 0,
    });
    expect(await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, STOREFRONT_POPULARITY_JOB))).toHaveLength(2);
    clock.advance(HOUR);
  });
});

describe('GET /store/v1/services?_sort=popular', () => {
  it('orders the list by the stored counts after a refresh', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const customer = await insertCustomerRow(db);
    for (let n = 0; n < 3; n += 1) await insertStoreOrder(db, world.att.serviceId, customer);
    await insertStoreOrder(db, world.icloud.serviceId, customer);
    await refresh.refresh();
    const slugs = async (order: string) =>
      (await t.app.inject({ method: 'GET', url: `/store/v1/services?_sort=popular&_order=${order}` }))
        .json()
        .map((row: { slug: string }) => row.slug);
    expect(await slugs('desc')).toEqual([world.att.slug, world.icloud.slug]);
    expect(await slugs('asc')).toEqual([world.icloud.slug, world.att.slug]);
  });
});
