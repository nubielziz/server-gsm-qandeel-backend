// Integration tests of an idle supplier (P4a, MISMATCHES B168): a supplier with no calls in the health window gets an `unknown` check, and
// System health (components, overall status, suppliers, check history) says unknown (no recent calls), never degraded or down. The
// dashboard row says `unknown` too (B180; the console shows "No recent calls", its M260); a supplier whose latest real check failed is
// still `degraded` there, and the attention list raises nothing for the idle one.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { CacheKeys, CacheService } from '../../src/infra/cache';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { ComponentChecker, HealthJobsModule } from '../../src/modules/health';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
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
  const cache = t.app.get(CacheService, { strict: false });
  const keys = t.app.get(CacheKeys, { strict: false });
  await cache.delByPrefix(keys.prefix('dashboard', 'payload'));
  const redis = t.app.get(RedisService, { strict: false });
  await redis.cache.unlink(
    keys.healthSnapshot(),
    keys.healthSnapshot(true),
    ...(await redis.cache.keys(`${keys.keyspace}health:*`)),
  );
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

async function insertSupplier(name: string) {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.suppliers)
    .values({
      name,
      driver: 'dhru',
      baseUrl: 'https://supplier.example',
      paramFormat: 'dhru_xml',
      balance: '1000.0000',
    })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

/** The checker as the worker runs it every minute: an idle supplier gets an `unknown` check, a supplier with failing calls a `degraded` one. */
async function runChecker(failingCalls?: { supplierId: number }) {
  const { db } = await testDb();
  if (failingCalls) {
    await db.insert(s.supplierApiLogs).values(
      Array.from({ length: 20 }, (_, index) => ({
        supplierId: failingCalls.supplierId,
        action: 'placeimeiorder',
        outcome: index === 0 ? ('error' as const) : ('ok' as const),
        durationMs: 400,
        createdAt: clock.now(),
      })),
    );
    // Decision 031: the calls were made a minute ago, so the clock moves on; no past time is written into a row.
    clock.advance(MINUTE);
  }
  await t.app.get(ComponentChecker, { strict: false }).runOnce();
  // Nobody works the queues in a test: the checker rates the workers down. Put a healthy core on top, as a running system would have.
  await db.insert(s.serviceChecks).values(
    ['api', 'postgres', 'redis', 'redis_queue', 'storage', 'workers'].map((component) => ({
      component,
      status: 'ok' as const,
      latencyMs: 5,
      checkedAt: clock.now(),
    })),
  );
}

describe('a supplier with no calls in the health window', () => {
  it('reads unknown on the dashboard row, a failing supplier still degraded, and raises no attention item for the idle one', async () => {
    const idle = await insertSupplier('Idle Supplier');
    const failing = await insertSupplier('Failing Supplier');
    await runChecker({ supplierId: failing });
    const { db } = await testDb();
    const written = await db.select().from(s.serviceChecks);
    expect(written.find((row) => row.component === `supplier:${idle}`)?.status).toBe('unknown');

    const api = await adminWith(t, ['dashboard:read']);
    const { body, status } = await api.get('/admin/dashboard?scope=all&days=7');
    expect(status).toBe(200);
    const health = Object.fromEntries(
      body.suppliers.map((row: { id: number; health: string }) => [row.id, row.health]),
    );
    // An idle supplier is neither healthy nor failing: the console shows `unknown` as "No recent calls" (M260).
    expect(health).toEqual({ [idle]: 'unknown', [failing]: 'degraded' });
    // The idle supplier raises nothing; the failing one still does.
    const supplierItems = body.attention.filter((item: { kind: string }) => item.kind.startsWith('supplier_'));
    expect(supplierItems.map((item: { kind: string; supplierId: number }) => [item.kind, item.supplierId])).toEqual([
      ['supplier_degraded', failing],
    ]);
  });

  it('reads unknown in System health, is not counted as a problem and does not move the overall status', async () => {
    const idle = await insertSupplier('Idle Supplier');
    await runChecker();
    const api = await adminWith(t, ['system:read']);
    const overview = await api.get('/admin/system/health');
    expect(overview.status).toBe(200);
    const component = overview.body.components.find((c: { key: string }) => c.key === `supplier:${idle}`);
    expect(component).toMatchObject({ kind: 'supplier', status: 'unknown', detail: null, supplierId: idle });
    // The core is healthy and Prometheus is not configured in tests: the overall word is "unknown", the same as with a healthy supplier;
    // a degraded or down supplier would make it "degraded".
    expect(overview.body.status).toBe('unknown');
    const suppliers = await api.get('/admin/system/suppliers');
    expect(suppliers.body.suppliers).toHaveLength(1);
    expect(suppliers.body.suppliers[0]).toMatchObject({ id: idle, status: 'active', health: 'unknown' });
    expect(suppliers.body.suppliers[0].errorRate).toMatchObject({ value: null, state: 'unknown' });
  });

  it('shows unknown buckets in the check history, with no failures', async () => {
    const idle = await insertSupplier('Idle Supplier');
    await runChecker();
    const api = await adminWith(t, ['system:read']);
    const history = await api.get(`/admin/system/checks?range=1h&component=supplier:${idle}`);
    expect(history.status).toBe(200);
    const [component] = history.body.components;
    const used = component.buckets.filter((bucket: { checks: number }) => bucket.checks > 0);
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ status: 'unknown', checks: 1, failures: 0 });
    expect(component.buckets.every((bucket: { status: string }) => bucket.status === 'unknown')).toBe(true);
  });
});
