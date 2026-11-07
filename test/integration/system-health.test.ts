// Integration tests of the System health overview (feature 9): the checker that writes `service_checks`, `GET /admin/system/health`,
// `GET /admin/system/checks` and `PUT /admin/system/maintenance`, through HTTP on the real application (decisions 015, 031;
// resolutions health-commissions-6, -7, -17; MISMATCHES B89).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { CacheKeys } from '../../src/infra/cache';
import { RedisService } from '../../src/infra/redis';
import {
  ComponentChecker,
  DB_SIZE_SAMPLE_JOB,
  DbSizeSampleProcessor,
  HealthJobsModule,
  JOB_RUNS_REAPER_JOB,
  JobRunsReaperProcessor,
  JobRunsService,
  SERVICE_CHECKS_PURGE_JOB,
  ServiceChecksPurgeProcessor,
} from '../../src/modules/health';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [HealthJobsModule] });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(RedisService, { strict: false }).cache.unlink(...(await snapshotKeys()));
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

/** The cache keys a test may have left: the snapshot and the history answers. */
async function snapshotKeys() {
  const keys = t.app.get(CacheKeys, { strict: false });
  const redis = t.app.get(RedisService, { strict: false });
  const found = await redis.cache.keys(`${keys.keyspace}health:*`);
  return [keys.healthSnapshot(), keys.healthSnapshot(true), ...found];
}

const checker = () => t.app.get(ComponentChecker, { strict: false });
const heartbeat = () =>
  t.app
    .get(RedisService, { strict: false })
    .cache.set(t.app.get(CacheKeys, { strict: false }).heartbeat('api'), clock.now().toISOString(), 'EX', 120);

async function insertSupplier(name: string, status: 'active' | 'disabled' | 'paused' = 'active') {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.suppliers)
    .values({ name, driver: 'dhru', baseUrl: 'https://supplier.example', paramFormat: 'dhru_xml', status })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

async function addCalls(supplierId: number, outcomes: Array<'ok' | 'error' | 'timeout'>) {
  const { db } = await testDb();
  await db.insert(s.supplierApiLogs).values(
    outcomes.map((outcome) => ({
      supplierId,
      action: 'placeimeiorder',
      outcome,
      durationMs: 400,
      createdAt: new Date(clock.now().getTime() - MINUTE),
    })),
  );
}

const checks = async () => (await testDb()).db.select().from(s.serviceChecks).orderBy(s.serviceChecks.id);

describe('the component checker', () => {
  it('writes one row per core component and per active supplier, with detail only when not ok', async () => {
    await heartbeat();
    const good = await insertSupplier('Quiet Supplier');
    const bad = await insertSupplier('Failing Supplier');
    await insertSupplier('Retired Supplier', 'disabled');
    await addCalls(bad, ['error', ...Array<'ok'>(19).fill('ok')]);
    const report = await checker().runOnce();
    const rows = await checks();
    const byKey = new Map(rows.map((row) => [row.component, row]));
    expect([...byKey.keys()].sort()).toEqual(
      ['api', 'postgres', 'redis', 'redis_queue', 'storage', 'supplier:' + good, 'supplier:' + bad, 'workers'].sort(),
    );
    expect(report.checked).toBe(rows.length);
    for (const key of ['api', 'postgres', 'redis', 'redis_queue']) {
      expect(byKey.get(key)?.status, key).toBe('ok');
      expect(byKey.get(key)?.detail, key).toBeNull();
    }
    expect(byKey.get(`supplier:${good}`)?.status).toBe('unknown');
    expect(byKey.get(`supplier:${bad}`)?.status).toBe('degraded');
    expect(byKey.get(`supplier:${bad}`)?.detail).toBe('5% of calls failed in the last 15 minutes');
    expect(byKey.get(`supplier:${bad}`)?.supplierId).toBe(bad);
    expect(byKey.get(`supplier:${bad}`)?.latencyMs).toBe(400);
    // Nobody works the queues in a test: the workers check says so.
    expect(byKey.get('workers')?.status).toBe('down');
    expect(byKey.get('workers')?.detail).toBe('No worker is connected to any queue');
  });

  it('says the API is down without a heartbeat and records the check time from the injected clock', async () => {
    await checker().runOnce();
    const api = (await checks()).find((row) => row.component === 'api');
    expect(api?.status).toBe('down');
    expect(api?.detail).toContain('No heartbeat');
    expect(api?.checkedAt.toISOString()).toBe(clock.now().toISOString());
  });
});

describe('GET /admin/system/health', () => {
  it('needs system:read', async () => {
    const reader = await adminWith(t, ['dashboard:read']);
    expect((await reader.get('/admin/system/health')).status).toBe(403);
    expect((await reader.anonymous('GET', '/admin/system/health')).status).toBe(401);
  });

  it('lists every component: core, each supplier (a disabled one says "checks are off") and the build', async () => {
    const api = await adminWith(t, ['system:read']);
    const active = await insertSupplier('Active Supplier');
    const off = await insertSupplier('Disabled Supplier', 'disabled');
    await heartbeat();
    await checker().runOnce();
    const { body, status } = await api.get('/admin/system/health');
    expect(status).toBe(200);
    expect(body.components.map((c: { key: string }) => c.key)).toEqual([
      'api',
      'postgres',
      'redis',
      'redis_queue',
      'storage',
      'workers',
      'mail',
      `supplier:${active}`,
      `supplier:${off}`,
    ]);
    const disabled = body.components.find((c: { key: string }) => c.key === `supplier:${off}`);
    expect(disabled).toMatchObject({
      kind: 'supplier',
      status: 'unknown',
      since: null,
      lastCheckedAt: null,
      detail: 'checks are off',
      supplierId: off,
    });
    const mail = body.components.find((c: { key: string }) => c.key === 'mail');
    expect(mail).toMatchObject({ status: 'unknown', detail: null, lastCheckedAt: null });
    expect(body.build).toMatchObject({
      version: '0.0.0-dev',
      commit: 'unknown',
      environment: 'test',
      deployedAt: null,
    });
    expect(body.maintenance).toEqual({
      enabled: false,
      scope: null,
      message: null,
      expectedEndAt: null,
      startedAt: null,
      startedBy: null,
    });
    expect(body.uptime.daily).toHaveLength(30);
    // Workers are down and the cache works: a core component down is an outage; monitoring is not configured.
    expect(body.status).toBe('outage');
    expect(body.monitoring).toMatchObject({ status: 'unavailable', lastScrapeAt: null });
    // Nothing evaluates alert rules yet and nothing is open: unknown, never a green zero.
    expect(body.alerts.open).toMatchObject({ value: null, state: 'unknown' });
    expect(body.alerts.trend).toHaveLength(96);
  });

  it('is never operational while monitoring is unavailable, and degraded for a degraded supplier', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    const now = clock.now();
    const supplier = await insertSupplier('Slow Supplier');
    const rows = ['api', 'postgres', 'redis', 'redis_queue', 'storage', 'workers'].map((component) => ({
      component,
      status: 'ok' as const,
      latencyMs: 5,
      checkedAt: now,
    }));
    await db.insert(s.serviceChecks).values([
      ...rows,
      {
        component: `supplier:${supplier}`,
        supplierId: supplier,
        status: 'degraded',
        latencyMs: 2500,
        detail: '12% of calls failed in the last 15 minutes',
        checkedAt: now,
      },
    ]);
    let { body } = await api.get('/admin/system/health');
    expect(body.status).toBe('degraded');
    const slow = body.components.find((c: { key: string }) => c.key === `supplier:${supplier}`);
    expect(slow).toMatchObject({ status: 'degraded', detail: '12% of calls failed in the last 15 minutes' });
    expect(slow.latency).toMatchObject({ value: 2500, state: 'warn', warn: 2000, crit: 5000 });
    await db
      .update(s.serviceChecks)
      .set({ status: 'ok', detail: null })
      .where(eq(s.serviceChecks.component, `supplier:${supplier}`));
    await t.app.get(RedisService, { strict: false }).cache.unlink(...(await snapshotKeys()));
    ({ body } = await api.get('/admin/system/health'));
    expect(body.status).toBe('unknown');
  });

  it('treats checks older than five minutes as unknown (a checker that stopped is not health)', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    await db
      .insert(s.serviceChecks)
      .values({ component: 'postgres', status: 'ok', latencyMs: 3, checkedAt: clock.now() });
    clock.advance(6 * MINUTE);
    const { body } = await api.get('/admin/system/health');
    const postgres = body.components.find((c: { key: string }) => c.key === 'postgres');
    expect(postgres.status).toBe('unknown');
  });

  it('computes uptime as checks that were not down over all checks, and since from the unbroken run of the status', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    const now = clock.now();
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE);
    await db.insert(s.serviceChecks).values([
      { component: 'redis', status: 'ok', latencyMs: 2, checkedAt: at(4) },
      { component: 'redis', status: 'down', detail: 'Check failed', checkedAt: at(3) },
      { component: 'redis', status: 'down', detail: 'Check failed', checkedAt: at(2) },
      { component: 'redis', status: 'ok', latencyMs: 2, checkedAt: at(1) },
      { component: 'redis', status: 'ok', latencyMs: 2, checkedAt: at(0) },
    ]);
    const { body } = await api.get('/admin/system/health');
    const redis = body.components.find((c: { key: string }) => c.key === 'redis');
    expect(redis.uptime.h24.value).toBe(60);
    expect(redis.status).toBe('ok');
    expect(redis.since).toBe(at(1).toISOString());
    expect(redis.detail).toBeNull();
    expect(redis.uptime.h24.state).toBe('crit');
  });
});

describe('GET /admin/system/checks', () => {
  it('rejects a bad range and an unknown component', async () => {
    const api = await adminWith(t, ['system:read']);
    const bad = await api.get('/admin/system/checks?range=2h');
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('range');
    const unknown = await api.get('/admin/system/checks?component=supplier:99');
    expect(unknown.status).toBe(404);
    expect((await adminWith(t, ['dashboard:read'])).get('/admin/system/checks').then((r) => r.status)).resolves.toBe(
      403,
    );
  });

  it('cuts each range into its buckets, worst check first, with failures and the p95 of answered checks', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    const now = clock.now();
    const rows = (status: 'ok' | 'down' | 'degraded' | 'unknown', latencyMs: number | null, minutesAgo: number) => ({
      component: 'postgres',
      status,
      latencyMs,
      checkedAt: new Date(now.getTime() - minutesAgo * MINUTE),
    });
    await db
      .insert(s.serviceChecks)
      .values([rows('ok', 10, 0), rows('ok', 30, 0), rows('down', null, 5), rows('degraded', 200, 20)]);
    const hour = await api.get('/admin/system/checks?range=1h&component=postgres');
    expect(hour.status).toBe(200);
    expect(hour.body).toMatchObject({ range: '1h', bucketSeconds: 60 });
    expect(hour.body.components).toHaveLength(1);
    const [postgres] = hour.body.components;
    expect(postgres.buckets).toHaveLength(60);
    const last = postgres.buckets[59];
    expect(last).toMatchObject({ status: 'ok', checks: 2, failures: 0, latencyMs: 29 });
    expect(postgres.buckets.find((b: { status: string }) => b.status === 'down')).toMatchObject({
      checks: 1,
      failures: 1,
      latencyMs: null,
    });
    expect(postgres.buckets.filter((b: { status: string }) => b.status === 'unknown')).toHaveLength(57);
    expect(postgres.uptime.value).toBe(75);
    expect(postgres.latency).toMatchObject({ value: 30, unit: 'ms', state: 'ok' });
    const sizes = { '6h': [72, 300], '24h': [48, 1800], '7d': [56, 10800] } as const;
    for (const [range, [count, seconds]] of Object.entries(sizes)) {
      const answer = await api.get(`/admin/system/checks?range=${range}`);
      expect(answer.body.bucketSeconds, range).toBe(seconds);
      expect(answer.body.components[0].buckets, range).toHaveLength(count);
    }
    const all = await api.get('/admin/system/checks');
    expect(all.body.range).toBe('24h');
    expect(all.body.components.map((c: { key: string }) => c.key)).toEqual([
      'api',
      'postgres',
      'redis',
      'redis_queue',
      'storage',
      'workers',
      'mail',
    ]);
  });
});

describe('PUT /admin/system/maintenance', () => {
  const on = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    scope: 'checkout',
    message: 'Back at 10:00 UTC.',
    expectedEndAt: new Date(clock.now().getTime() + 2 * HOUR).toISOString(),
    ...over,
  });

  it('needs system:manage', async () => {
    const reader = await adminWith(t, ['system:read']);
    expect((await reader.put('/admin/system/maintenance', on())).status).toBe(403);
  });

  it('switches on, keeps who started it when changed, resets when off, and audits each change', async () => {
    const api = await adminWith(t, ['system:manage', 'system:read'], { name: 'Rami K.' });
    const started = await api.put('/admin/system/maintenance', on());
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      enabled: true,
      scope: 'checkout',
      message: 'Back at 10:00 UTC.',
      startedAt: clock.now().toISOString(),
      startedBy: { id: api.staffId, name: 'Rami K.' },
    });
    clock.advance(10 * MINUTE);
    const other = await adminWith(t, ['system:manage'], { name: 'Omar T.' });
    const changed = await other.put(
      '/admin/system/maintenance',
      on({ scope: 'all', message: '  Longer than planned.  ', expectedEndAt: null }),
    );
    expect(changed.body).toMatchObject({
      scope: 'all',
      message: 'Longer than planned.',
      expectedEndAt: null,
      startedBy: { id: api.staffId, name: 'Rami K.' },
    });
    expect(changed.body.startedAt).toBe(started.body.startedAt);
    const health = await api.get('/admin/system/health');
    expect(health.body.maintenance).toMatchObject({ enabled: true, scope: 'all' });
    const off = await api.put('/admin/system/maintenance', { enabled: false });
    expect(off.body).toEqual({
      enabled: false,
      scope: null,
      message: null,
      expectedEndAt: null,
      startedAt: null,
      startedBy: null,
    });
    const { db } = await testDb();
    const audit = await db
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityType, 'setting'))
      .orderBy(s.auditLogs.id);
    expect(audit.map((row) => row.action)).toEqual([
      'turned on maintenance',
      'changed maintenance',
      'turned off maintenance',
    ]);
    expect(audit.every((row) => row.entityLabel === 'maintenance')).toBe(true);
  });

  it('refuses a missing message, an unknown scope and an end in the past, naming the field', async () => {
    const api = await adminWith(t, ['system:manage']);
    const message = await api.put('/admin/system/maintenance', on({ message: '   ' }));
    expect(message.status).toBe(422);
    expect(message.body.errors.map((e: { field: string }) => e.field)).toContain('message');
    const scope = await api.put('/admin/system/maintenance', on({ scope: 'everything' }));
    expect(scope.status).toBe(422);
    const past = await api.put(
      '/admin/system/maintenance',
      on({ expectedEndAt: new Date(clock.now().getTime() - MINUTE).toISOString() }),
    );
    expect(past.status).toBe(422);
    expect(past.body.errors[0].field).toBe('expectedEndAt');
  });
});

describe('the housekeeping jobs', () => {
  it('purges checks and finished runs older than 90 days and keeps the rest', async () => {
    const { db } = await testDb();
    const old = new Date(clock.now().getTime() - 91 * 24 * HOUR);
    await db.insert(s.serviceChecks).values([
      { component: 'redis', status: 'ok', checkedAt: old },
      { component: 'redis', status: 'ok', checkedAt: clock.now() },
    ]);
    await db.insert(s.jobRuns).values([
      { job: 'x', trigger: 'schedule', status: 'succeeded', startedAt: old, finishedAt: old },
      { job: 'x', trigger: 'schedule', status: 'running', startedAt: old },
    ]);
    const processor = t.app.get(ServiceChecksPurgeProcessor, { strict: false });
    await processor.process({ data: {} } as never);
    expect((await checks()).map((row) => row.checkedAt.getTime())).toEqual([clock.now().getTime()]);
    const runs = await db.select().from(s.jobRuns).orderBy(s.jobRuns.id);
    expect(runs.filter((run) => run.job === 'x').map((run) => run.status)).toEqual(['running']);
    expect(runs.some((run) => run.job === SERVICE_CHECKS_PURGE_JOB && run.status === 'succeeded')).toBe(true);
  });

  it('closes a run left running for over two hours and samples the database size', async () => {
    const { db } = await testDb();
    await db.insert(s.jobRuns).values({
      job: 'price_sync',
      trigger: 'schedule',
      status: 'running',
      startedAt: new Date(clock.now().getTime() - 3 * HOUR),
    });
    await t.app.get(JobRunsReaperProcessor, { strict: false }).process({ data: {} } as never);
    const stuck = (await db.select().from(s.jobRuns)).find((run) => run.job === 'price_sync');
    expect(stuck?.status).toBe('failed');
    expect(
      (await db.select().from(s.jobRuns)).some((run) => run.job === JOB_RUNS_REAPER_JOB && run.status === 'succeeded'),
    ).toBe(true);
    await t.app.get(DbSizeSampleProcessor, { strict: false }).process({ data: {} } as never);
    const sample = (await db.select().from(s.jobRuns)).find((run) => run.job === DB_SIZE_SAMPLE_JOB);
    expect((sample?.result as { bytes: number }).bytes).toBeGreaterThan(0);
    expect(t.app.get(JobRunsService, { strict: false })).toBeDefined();
  });
});
