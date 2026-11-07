// The health seed (feature 9): a week of service checks and the run history of the scheduled jobs appear through the real API (System
// health checks, Database growth, Dashboard supplier health) in the shape of the frontend mock's calm story. Runs the whole seed once.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { demoRows, demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
/** The seed's "now" and the application's: the seeded history ends at the clock's time. */
const clock = new TestClock('2026-11-05T12:00:00.000Z');
let t: TestApp;
let staff: AdminApi;
let activeSupplierIds: number[] = [];

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp({ clock });
  await resetDb();
  await clearIdentityCaches(t);
  const demo = await loadDemoState({ now: clock.nowMs() });
  activeSupplierIds = demoRows<{ id: string; enabled: boolean }>(demo, 'suppliers')
    .filter((supplier) => supplier.enabled)
    .map((supplier) => Number(/\d+$/.exec(supplier.id)![0]));
  await runSeed((await testDb()).db, demo, t.config);
  staff = await adminWith(t, ['system:read', 'dashboard:read']);
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the health seed', () => {
  it('writes a week of half-hourly checks for the core components and every active supplier', async () => {
    const { db } = await testDb();
    const rows = await db.select().from(s.serviceChecks).orderBy(s.serviceChecks.id);
    const samples = 7 * 48 + 1;
    const components = new Set(rows.map((row) => row.component));
    expect([...components].sort()).toEqual(
      [
        'api',
        'postgres',
        'redis',
        'redis_queue',
        'storage',
        'workers',
        ...activeSupplierIds.map((id) => `supplier:${id}`),
      ].sort(),
    );
    expect(rows).toHaveLength(samples * components.size);
    // Every sample is in the past or exactly now, and the newest sample of each component is ok: the console opens on Operational.
    expect(rows.every((row) => row.checkedAt.getTime() <= clock.nowMs())).toBe(true);
    const newest = rows.filter((row) => row.checkedAt.getTime() === clock.nowMs());
    expect(newest).toHaveLength(components.size);
    expect(newest.every((row) => row.status === 'ok' && row.detail === null)).toBe(true);
    // A supplier check carries its supplier id (the table's check constraint ties the key to it).
    for (const row of rows.filter((candidate) => candidate.component.startsWith('supplier:'))) {
      expect(row.component).toBe(`supplier:${row.supplierId}`);
    }
  });

  it('tells two blips: a slow supplier for an hour and the queue Redis down for one sample', async () => {
    const { db } = await testDb();
    const rows = await db.select().from(s.serviceChecks);
    const down = rows.filter((row) => row.status === 'down');
    expect(down.map((row) => [row.component, row.detail])).toEqual([['redis_queue', 'Check failed']]);
    const degraded = rows.filter((row) => row.status === 'degraded');
    expect(degraded).toHaveLength(2);
    expect(new Set(degraded.map((row) => row.component)).size).toBe(1);
    expect(degraded.every((row) => row.detail !== null && row.latencyMs !== null && row.latencyMs > 1000)).toBe(true);
    // Details exist only when a component is not ok (health-commissions-6).
    expect(rows.filter((row) => row.status === 'ok').every((row) => row.detail === null)).toBe(true);
  });

  it('feeds the history and the uptime of the console', async () => {
    const week = await staff.get('/admin/system/checks?range=7d');
    expect(week.status).toBe(200);
    const byKey = new Map<string, { uptime: { value: number | null }; buckets: Array<{ status: string }> }>(
      week.body.components.map((component: { key: string }) => [component.key, component]),
    );
    expect(byKey.get('api')!.uptime.value).toBe(100);
    const queueRedis = byKey.get('redis_queue')!;
    expect(queueRedis.uptime.value).toBeLessThan(100);
    expect(queueRedis.uptime.value).toBeGreaterThan(99);
    expect(queueRedis.buckets.some((bucket) => bucket.status === 'down')).toBe(true);
    for (const id of activeSupplierIds) expect(byKey.has(`supplier:${id}`)).toBe(true);
  });

  it('shows the dashboard supplier health from the newest check: up for an active supplier', async () => {
    const dashboard = await staff.get('/admin/dashboard');
    expect(dashboard.status).toBe(200);
    const byId = new Map<number, { health: string; enabled: boolean }>(
      dashboard.body.suppliers.map((supplier: { id: number }) => [supplier.id, supplier]),
    );
    for (const id of activeSupplierIds) expect(byId.get(id)?.health, `supplier ${id}`).toBe('up');
    expect(dashboard.body.attention.some((item: { kind: string }) => item.kind === 'supplier_down')).toBe(false);
  });

  it('writes the run history of the scheduled jobs: succeeded runs and one old failed price sync, none running', async () => {
    const { db } = await testDb();
    const rows = await db.select().from(s.jobRuns).orderBy(s.jobRuns.id);
    const byJob = Map.groupBy(rows, (row) => row.job);
    expect([...byJob.keys()].sort()).toEqual(
      [
        'balance_check',
        'client_group_promotion',
        'db_size_sample',
        'price_sync',
        'service_checks_purge',
        'session_purge',
      ].sort(),
    );
    // The newest slot (12:00 sharp) would still be running at the clock's time, so it is left out: 19 of 20.
    expect(byJob.get('price_sync')).toHaveLength(19);
    expect(byJob.get('db_size_sample')).toHaveLength(14);
    expect(rows.filter((row) => row.status === 'failed').map((row) => [row.job, row.error])).toEqual([
      ['price_sync', 'Rapid IMEI: HTTP 502 Bad Gateway'],
    ]);
    expect(rows.every((row) => row.status !== 'running' && row.trigger === 'schedule')).toBe(true);
    expect(rows.every((row) => row.finishedAt !== null && row.finishedAt > row.startedAt)).toBe(true);
    // The ids grow with time inside a job, as the real rows' do.
    for (const runs of byJob.values()) {
      const times = runs.map((run) => run.startedAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('gives the Database tab its growth per day from the daily size samples', async () => {
    const { body, status } = await staff.get('/admin/system/database');
    expect(status).toBe(200);
    // 4.3 MB a day: the two samples used are seven days apart, give or take the seconds of their start delay.
    expect(body.size.growthPerDayBytes).toBeGreaterThan(4_290_000);
    expect(body.size.growthPerDayBytes).toBeLessThan(4_310_000);
  });

  it('is idempotent: a second run leaves the tables as they are, even with a later clock', async () => {
    const { db } = await testDb();
    const count = async (table: typeof s.serviceChecks | typeof s.jobRuns) =>
      (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0]!.n;
    const before = [await count(s.serviceChecks), await count(s.jobRuns)];
    const reports = await runSeed(db, await loadDemoState({ now: clock.nowMs() + 3_600_000 }), t.config);
    const mine = reports.filter((report) => ['service_checks', 'job_runs'].includes(report.table));
    expect(mine.map((report) => [report.table, report.inserted])).toEqual([
      ['service_checks', 0],
      ['job_runs', 0],
    ]);
    expect([await count(s.serviceChecks), await count(s.jobRuns)]).toEqual(before);
  });

  it('moves the id sequences past the seeded ids', async () => {
    const { db } = await testDb();
    const [check] = await db
      .insert(s.serviceChecks)
      .values({ component: 'api', status: 'ok' })
      .returning({ id: s.serviceChecks.id });
    const [run] = await db
      .insert(s.jobRuns)
      .values({ job: 'session_purge', trigger: 'manual', status: 'running' })
      .returning({ id: s.jobRuns.id });
    const count = async (table: typeof s.serviceChecks | typeof s.jobRuns) =>
      (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0]!.n;
    expect(check!.id).toBe(await count(s.serviceChecks));
    expect(run!.id).toBe(await count(s.jobRuns));
  });
});
