// Integration tests of the pipeline and data store pages of System health (feature 9): orders past SLA with the money held, supplier
// health with call outcome rates, webhook delivery health, Postgres and the cache Redis (resolutions orders-suppliers-1, -5,
// health-commissions-8, -10; MISMATCHES B92, B93, B97, B98).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { CacheKeys } from '../../src/infra/cache';
import { WebhookIntakeCounter } from '../../src/modules/health';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrderRow, ordersWorld } from '../support/orders';
import { insertDelivery, insertEndpoint } from '../support/webhooks';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ago = (ms: number) => new Date(clock.now().getTime() - ms);

describe('GET /admin/system/orders-health', () => {
  it('needs system:read and answers a calm pipeline with zeros and unknowns, not errors', async () => {
    expect((await (await adminWith(t, ['dashboard:read'])).get('/admin/system/orders-health')).status).toBe(403);
    const api = await adminWith(t, ['system:read']);
    const { body, status } = await api.get('/admin/system/orders-health');
    expect(status).toBe(200);
    expect(body.stuck).toMatchObject({
      total: { value: 0, state: 'ok', warn: 5, crit: 20 },
      heldAmount: '0.0000',
      byStatus: [],
    });
    expect(body.stuck.trend).toHaveLength(96);
    expect(body.needsAttention).toBe(0);
    expect(body.dispatchP95).toMatchObject({ value: null, state: 'unknown' });
    expect(body.byServiceType.map((row: { type: string }) => row.type)).toEqual(['imei', 'server', 'remote', 'file']);
    expect(body.byServiceType[0]).toMatchObject({ total: 0, success: { value: null, state: 'unknown' } });
    expect(body.heldByRisk).toEqual({ count: 0, amount: '0.0000', oldestAt: null });
  });

  it('counts open orders older than their SLA (age only), splits needs-attention out, and sums the money held', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const late = (over: Partial<typeof s.orders.$inferInsert>) =>
      insertOrderRow(db, {
        serviceId: world.auto.serviceId,
        clientId: world.merchant.id,
        totalPrice: '17.2800',
        placedAt: ago(2 * HOUR),
        createdAt: ago(2 * HOUR),
        ...over,
      });
    await late({ status: 'pending', dispatchState: 'pending' });
    await late({ status: 'processing', dispatchState: 'sent', placedAt: ago(5 * HOUR) });
    await late({ status: 'processing', dispatchState: 'needs_attention' });
    // Not late: placed a minute ago; done; and a manual order is still counted by age.
    await late({ placedAt: ago(MINUTE), createdAt: ago(MINUTE) });
    await late({ status: 'completed', dispatchState: 'done', completedAt: ago(HOUR) });
    await late({ status: 'pending', dispatchState: 'manual' });
    const { body } = await api.get('/admin/system/orders-health');
    expect(body.stuck.total.value).toBe(4);
    const rows = Object.fromEntries(body.stuck.byStatus.map((row: { status: string }) => [row.status, row]));
    expect(rows.pending).toMatchObject({ label: 'Pending', count: 2, heldAmount: '34.5600' });
    expect(rows.processing).toMatchObject({ count: 1, oldestAgeSeconds: 5 * 3600, heldAmount: '17.2800' });
    expect(rows.needs_attention).toMatchObject({ count: 1 });
    expect(body.stuck.heldAmount).toBe('69.1200');
    expect(body.needsAttention).toBe(1);
    // The trend's last point is the count at the current quarter hour.
    expect(body.stuck.trend.at(-1).value).toBe(4);
    expect(body.stuck.trend[0].value).toBe(0);
  });

  it('reports dispatch p95, finished orders by type with percentages, and the storefront orders the risk rules hold', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const done = (status: 'completed' | 'rejected', over: Partial<typeof s.orders.$inferInsert> = {}) =>
      insertOrderRow(db, {
        serviceId: world.auto.serviceId,
        clientId: world.merchant.id,
        status,
        dispatchState: 'done',
        placedAt: ago(3 * HOUR),
        sentAt: ago(3 * HOUR - 60_000),
        completedAt: ago(HOUR),
        ...over,
      });
    for (let i = 0; i < 9; i += 1) await done('completed');
    await done('rejected');
    await done('completed', { type: 'server', serviceId: world.server.serviceId });
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'buyer@example.com', name: 'Buyer', currency: 'USD' })
      .returning({ id: s.customers.id });
    await insertOrderRow(db, {
      serviceId: world.auto.serviceId,
      clientId: null,
      customerId: customer!.id,
      status: 'pending',
      dispatchState: 'held',
      totalPrice: '20.0000',
      taxAmount: '3.8000',
      placedAt: ago(26 * HOUR),
      createdAt: ago(26 * HOUR),
    });
    const { body } = await api.get('/admin/system/orders-health');
    expect(body.dispatchP95).toMatchObject({ value: 60, state: 'ok', unit: 's' });
    const imei = body.byServiceType.find((row: { type: string }) => row.type === 'imei');
    expect(imei).toMatchObject({ total: 10 });
    expect(imei.success).toMatchObject({ value: 90, state: 'warn' });
    expect(imei.failure).toMatchObject({ value: 10, state: 'warn' });
    expect(body.byServiceType.find((row: { type: string }) => row.type === 'server').success.value).toBe(100);
    expect(body.heldByRisk).toEqual({ count: 1, amount: '23.8000', oldestAt: ago(26 * HOUR).toISOString() });
  });
});

describe('GET /admin/system/suppliers', () => {
  async function supplier(name: string, over: Partial<typeof s.suppliers.$inferInsert> = {}) {
    const { db } = await testDb();
    const [row] = await db
      .insert(s.suppliers)
      .values({ name, driver: 'dhru', baseUrl: 'https://s.example', paramFormat: 'dhru_xml', ...over })
      .returning({ id: s.suppliers.id });
    return row!.id;
  }

  it('has one row per supplier whatever its status, with outcome rates that keep errors and timeouts apart', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    const busy = await supplier('Busy Supplier', {
      balance: '500.0000',
      currency: 'USD',
      balanceCheckedAt: ago(10 * MINUTE),
      pricesSyncedAt: ago(5 * MINUTE),
    });
    const off = await supplier('Disabled Supplier', { status: 'disabled' });
    const paused = await supplier('Paused Supplier', {
      status: 'paused',
      balance: '10.0000',
      lowBalanceAlert: '150.0000',
    });
    const call = (outcome: 'ok' | 'error' | 'timeout', minutesAgo: number) => ({
      supplierId: busy,
      action: 'a',
      outcome,
      durationMs: 300,
      createdAt: ago(minutesAgo * MINUTE),
    });
    await db.insert(s.supplierApiLogs).values([
      ...Array.from({ length: 16 }, () => call('ok', 3)),
      call('error', 2),
      call('error', 2),
      call('timeout', 1),
      call('timeout', 1),
      call('error', 40), // outside the 15-minute window
    ]);
    await db.insert(s.serviceChecks).values({
      component: `supplier:${busy}`,
      supplierId: busy,
      status: 'degraded',
      latencyMs: 2600,
      detail: 'x',
      checkedAt: ago(MINUTE),
    });
    const { body, status } = await api.get('/admin/system/suppliers');
    expect(status).toBe(200);
    expect(body.suppliers.map((row: { id: number }) => row.id)).toEqual([busy, off, paused]);
    const [first, second, third] = body.suppliers;
    expect(first).toMatchObject({
      name: 'Busy Supplier',
      status: 'active',
      health: 'degraded',
      circuit: 'closed',
      lastSyncAt: ago(5 * MINUTE).toISOString(),
    });
    expect(first.errorRate).toMatchObject({ value: 10, state: 'warn', unit: 'percent' });
    expect(first.timeoutRate).toMatchObject({ value: 10, state: 'warn' });
    expect(first.latency).toMatchObject({ value: 2600, state: 'warn' });
    expect(first.lastSuccessAt).toBe(ago(3 * MINUTE).toISOString());
    expect(first.balance).toMatchObject({ amount: '500.0000', currency: 'USD', state: 'ok' });
    expect(second).toMatchObject({ status: 'disabled', health: 'unknown', since: null, lastSuccessAt: null });
    expect(second.errorRate).toMatchObject({ value: null, state: 'unknown' });
    expect(third).toMatchObject({ status: 'paused' });
    expect(third.balance.state).toBe('crit');
  });

  it('judges the balance like the suppliers page: under two days of runway at the 7-day completed cost is a warning (M65)', async () => {
    const api = await adminWith(t, ['system:read', 'suppliers:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    // Balance 500 is far above the alert amount of 10, so only the runway can make it low.
    const burning = await supplier('Burning Supplier', { balance: '500.0000', lowBalanceAlert: '10.0000' });
    const steady = await supplier('Steady Supplier', { balance: '5000.0000', lowBalanceAlert: '10.0000' });
    const spent = (supplierId: number, totalCost: string, completedAt: Date) =>
      insertOrderRow(db, {
        serviceId: world.auto.serviceId,
        clientId: world.merchant.id,
        supplierId,
        status: 'completed',
        dispatchState: 'done',
        totalCost,
        createdAt: completedAt,
        completedAt,
      });
    // 2100 in the last 7 days is 300 a day: 500 lasts 1.7 days. The 5000 of cost 8 days ago is outside the window.
    for (const day of [1, 2, 3]) await spent(burning, '700.0000', ago(day * DAY - HOUR));
    await spent(burning, '5000.0000', ago(8 * DAY));
    await spent(steady, '700.0000', ago(HOUR));
    const health = await api.get('/admin/system/suppliers');
    expect(health.status).toBe(200);
    const stateOf = (id: number) => health.body.suppliers.find((row: { id: number }) => row.id === id).balance.state;
    expect(stateOf(burning)).toBe('warn');
    expect(stateOf(steady)).toBe('ok');
    const page = await api.get('/admin/suppliers?_end=200');
    const pageRow = (id: number) => page.body.find((row: { id: number }) => row.id === id);
    expect(pageRow(burning)).toMatchObject({ lowBalance: true, runwayDays: 1.7 });
    expect(pageRow(steady)).toMatchObject({ lowBalance: false, runwayDays: 50 });
    // The two pages never disagree: a low balance on the suppliers page is a warning or worse here.
    for (const id of [burning, steady]) expect(stateOf(id) !== 'ok').toBe(pageRow(id).lowBalance);
  });

  it('does not call a zero balance critical when no alert amount is set and nothing is spent', async () => {
    const api = await adminWith(t, ['system:read', 'suppliers:read']);
    const idle = await supplier('Idle Supplier', { balance: '0.0000', lowBalanceAlert: '0.0000' });
    const health = await api.get('/admin/system/suppliers');
    const row = health.body.suppliers.find((entry: { id: number }) => entry.id === idle);
    expect(row.balance.state).toBe('ok');
    const page = await api.get('/admin/suppliers?_end=200');
    expect(page.body.find((entry: { id: number }) => entry.id === idle)).toMatchObject({ lowBalance: false });
  });
});

describe('GET /admin/system/webhooks', () => {
  it('summarises the last 24 hours of deliveries and the oldest still pending', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const endpoint = await insertEndpoint(t.app.get(EncryptionService), db, world.merchant.id);
    await insertDelivery(db, endpoint, { status: 'delivered', nextRetryAt: null, createdAt: ago(HOUR) });
    await insertDelivery(db, endpoint, { status: 'delivered', nextRetryAt: null, createdAt: ago(2 * HOUR) });
    await insertDelivery(db, endpoint, { status: 'failed', nextRetryAt: null, createdAt: ago(3 * HOUR) });
    await insertDelivery(db, endpoint, { status: 'pending', createdAt: ago(10 * MINUTE) });
    await insertDelivery(db, endpoint, { status: 'delivered', nextRetryAt: null, createdAt: ago(30 * HOUR) });
    const { body, status } = await api.get('/admin/system/webhooks');
    expect(status).toBe(200);
    expect(body.outgoing).toMatchObject({
      delivered: 2,
      failed: 1,
      retrying: 1,
      oldestUndeliveredAt: ago(10 * MINUTE).toISOString(),
    });
    expect(body.outgoing.successRate.value).toBe(66.67);
    expect(body.outgoing.oldestAge).toMatchObject({ value: 600, state: 'warn' });
    expect(body.incoming).toMatchObject({ delivered: 0, failed: 0, retrying: 0, oldestUndeliveredAt: null });
    expect(body.incoming.successRate).toMatchObject({ value: null, state: 'unknown' });
  });

  it('reads the incoming callbacks from the hourly counters and the oldest unrelayed callback event', async () => {
    const api = await adminWith(t, ['system:read']);
    const counter = t.app.get(WebhookIntakeCounter, { strict: false });
    const cache = t.app.get(RedisService, { strict: false }).cache;
    const keys = t.app.get(CacheKeys, { strict: false });
    const hour = clock.now().toISOString().slice(0, 13).replace(/\D/g, '');
    await cache.del(keys.webhookIntake(hour));
    for (const outcome of ['delivered', 'delivered', 'delivered', 'failed', 'retrying'] as const)
      await counter.record(outcome);
    const { db } = await testDb();
    await db
      .insert(s.outboxEvents)
      .values({ type: 'payment.callback', aggregateType: 'payment', aggregateId: 5, createdAt: ago(2 * MINUTE) });
    const { body } = await api.get('/admin/system/webhooks');
    expect(body.incoming).toMatchObject({
      delivered: 3,
      failed: 1,
      retrying: 1,
      oldestUndeliveredAt: ago(2 * MINUTE).toISOString(),
    });
    expect(body.incoming.successRate.value).toBe(75);
    await cache.del(keys.webhookIntake(hour));
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.aggregateType, 'payment'))).toHaveLength(1);
  });
});

describe('GET /admin/system/database and /cache', () => {
  it('describes Postgres without anything secret', async () => {
    const api = await adminWith(t, ['system:read']);
    const { body, status } = await api.get('/admin/system/database');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.connections.used).toBeGreaterThan(0);
    expect(body.connections.max).toBeGreaterThan(body.connections.used);
    expect(body.connections.usage).toMatchObject({ unit: 'percent', warn: 70, crit: 90 });
    expect(body.connections.poolWait).toMatchObject({ value: null, state: 'unknown' });
    expect(body.locks.waiting).toBeGreaterThanOrEqual(0);
    expect(body.replicaLag).toBeNull();
    expect(body.size.bytes).toBeGreaterThan(0);
    expect(body.size.growthPerDayBytes).toBeNull();
    expect(body.pendingMigrations).toEqual([]);
    expect(Array.isArray(body.slowQueries)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\/|localhost|5432/);
    expect((await (await adminWith(t, ['dashboard:read'])).get('/admin/system/database')).status).toBe(403);
  });

  it('measures growth per day from two daily size samples', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    await db.insert(s.jobRuns).values([
      {
        job: 'db_size_sample',
        trigger: 'schedule',
        status: 'succeeded',
        startedAt: ago(48 * HOUR),
        finishedAt: ago(48 * HOUR),
        result: { bytes: 1_000_000 },
      },
      {
        job: 'db_size_sample',
        trigger: 'schedule',
        status: 'succeeded',
        startedAt: ago(HOUR),
        finishedAt: ago(HOUR),
        result: { bytes: 1_230_000 },
      },
    ]);
    const { body } = await api.get('/admin/system/database');
    expect(body.size.growthPerDayBytes).toBe(Math.round(230_000 / (47 / 24)));
  });

  it("describes the cache Redis, with deltas from the checker's samples", async () => {
    const api = await adminWith(t, ['system:read']);
    const first = await api.get('/admin/system/cache');
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ok');
    expect(first.body.memory.usedBytes).toBeGreaterThan(0);
    expect(first.body.memory.usage.unit).toBe('percent');
    expect(first.body.clients.value).toBeGreaterThan(0);
    expect(first.body.latency).toMatchObject({ unit: 'ms' });
    expect(first.body.evictionsPerMin).toMatchObject({ value: null, state: 'unknown' });
    const { db } = await testDb();
    await db.insert(s.jobRuns).values({
      job: 'service_checks',
      trigger: 'schedule',
      status: 'succeeded',
      startedAt: ago(2 * MINUTE),
      finishedAt: ago(2 * MINUTE),
      result: { cacheHits: 0, cacheMisses: 0, cacheEvictedKeys: 0 },
    });
    const second = await api.get('/admin/system/cache');
    expect(second.body.evictionsPerMin.value).toBe(0);
    expect(second.body.evictionsPerMin.state).toBe('ok');
    expect(second.body.hitRate.unit).toBe('percent');
  });
});
