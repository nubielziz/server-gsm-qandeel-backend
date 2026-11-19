// A worker killed in the middle of a bulk publish (feature 31, plan 31 section 6.5, "a worker that dies"): the real worker process, killed
// with SIGKILL while it publishes a run, leaves every row whole (a result and its listing, or neither), and a resume finishes the run with
// one listing per service. Real Postgres and Redis, a real `bun src/worker.ts`; the waits are polls for the effect.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { PublishPreparer } from '../../src/modules/storefront/publish/application/publish-preparer';
import { PublishRunner } from '../../src/modules/storefront/publish/application/publish-runner';
import { STALLED_ERROR } from '../../src/modules/storefront/publish/domain/publish-item';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService, insertSupplierLink } from '../support/catalog';
import { MINUTE, TestClock } from '../support/clock';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';
import { testInstanceEnv } from '../support/env';
import { insertUsd } from '../support/fixtures';
import { eventually, freePort } from '../support/infra';
import { insertDemoGroups } from '../support/pricing';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

setDefaultTimeout(120_000);

/** Enough rows that the worker is still publishing when it is killed. */
const SERVICES = 150;
/** The results to wait for before the kill: some rows done, most of them still to do. */
const DONE_BEFORE_THE_KILL = 5;

const ROOT = join(import.meta.dir, '../..');
const prefix = testBullPrefix();
const clock = new TestClock(new Date().toISOString());
let t: TestApp;
let db: Awaited<ReturnType<typeof testDb>>['db'];
let admin: AdminApi;
let worker: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  t = await createTestApp({ clock });
  ({ db } = await testDb());
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'storefront:*', 'catalog:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  worker?.kill('SIGKILL');
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

/** The worker of the production entry point, on the test instances, with its own queues. */
async function startWorker() {
  worker = Bun.spawn([process.execPath, '--no-env-file', 'src/worker.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      ...testInstanceEnv(),
      WORKER_METRICS_PORT: String(await freePort()),
      DATABASE_URL_TEST: TEST_DATABASE_URL,
      BULL_PREFIX: prefix,
      LOG_LEVEL: 'warn',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return worker;
}

const itemsOf = (runId: number) =>
  db.select().from(s.listingPublishItems).where(eq(s.listingPublishItems.runId, runId));
const listingCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(s.serviceListings))[0]!.n;
const runRow = async (runId: number) =>
  (await db.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.id, runId)))[0]!;

describe('a worker killed while it publishes a run', () => {
  it('leaves whole rows behind, and a resume publishes the rest once', async () => {
    // Every clock of this test is the real one until the kill; the staff clock then moves past the five minutes of a stall.
    clock.set(new Date().toISOString());
    await insertUsd(db);
    await insertDemoGroups(db);
    expect(
      (
        await admin.post('/admin/retail-price-rules', {
          scope: 'type',
          serviceType: 'imei',
          percent: '30',
          rounding: 'ends_99',
        })
      ).status,
    ).toBe(201);
    const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
    for (let i = 1; i <= SERVICES; i += 1) {
      const id = await insertService(db, categoryId, {
        name: `Apple iPhone ${i} Activation Lock Remove`,
        basePrice: '10.6000',
        cost: '10.0000',
        effectiveCost: '10.0000',
      });
      await insertSupplierLink(db, id);
    }
    const created = await admin.post('/admin/publish-runs', { scope: { kind: 'all' } });
    expect(created.status).toBe(202);
    const runId = created.body.id as number;
    expect(await t.app.get(PublishPreparer, { strict: false }).run(runId)).toBe('draft');
    expect((await admin.post(`/admin/publish-runs/${runId}/apply`, {})).status).toBe(202);

    const child = await startWorker();
    const done = await eventually(async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.listingPublishItems)
        .where(and(eq(s.listingPublishItems.runId, runId), isNotNull(s.listingPublishItems.result)));
      return row!.n >= DONE_BEFORE_THE_KILL ? row!.n : undefined;
    }, 60_000);
    child.kill('SIGKILL');
    await child.exited;
    expect(done).toBeLessThan(SERVICES);

    // No row half done: each result has its listing and each listing its result; the row in flight rolled back whole.
    const afterKill = await itemsOf(runId);
    const published = afterKill.filter((item) => item.result === 'published');
    expect(afterKill.some((item) => item.result === null)).toBe(true);
    expect(await listingCount()).toBe(published.length);
    expect(published.every((item) => item.listingId !== null)).toBe(true);
    expect(await runRow(runId)).toMatchObject({ status: 'running', attempt: 1 });

    // Five minutes later the run reads failed, and staff resume it.
    clock.set(new Date(Date.now() + 6 * MINUTE).toISOString());
    expect((await admin.get(`/admin/publish-runs/${runId}`)).body).toMatchObject({
      status: 'failed',
      error: STALLED_ERROR,
    });
    expect((await admin.post(`/admin/publish-runs/${runId}/apply`, {})).status).toBe(202);
    expect(await t.app.get(PublishRunner, { strict: false }).run(runId)).toBe('succeeded');

    const final = await itemsOf(runId);
    expect(final).toHaveLength(SERVICES);
    expect(final.every((item) => item.result === 'published')).toBe(true);
    expect(await listingCount()).toBe(SERVICES);
    expect(await runRow(runId)).toMatchObject({ status: 'succeeded', attempt: 2, publishedCount: SERVICES });
    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'published to the storefront'));
    expect(audits).toHaveLength(SERVICES);
  });
});
