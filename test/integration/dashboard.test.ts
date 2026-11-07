// Integration tests of `GET /admin/dashboard` (feature 9): the read model for every scope, the ranked attention list with its rules,
// the supplier health mappings, USD conversion of money in other currencies, the storefront block and the sidebar counts
// (resolutions identity-platform-8, -9, -10, catalog-1, b2c-10; MISMATCHES B87).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { CacheKeys, CacheService } from '../../src/infra/cache';
import { schema as s } from '../../src/infra/db';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { insertOrderRow, ordersWorld } from '../support/orders';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await t.app
    .get(CacheService, { strict: false })
    .delByPrefix(t.app.get(CacheKeys, { strict: false }).prefix('dashboard', 'payload'));
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ago = (ms: number) => new Date(clock.now().getTime() - ms);
const dashboard = async (api: Awaited<ReturnType<typeof adminWith>>, query = 'scope=all&days=7') => {
  const answer = await api.get(`/admin/dashboard?${query}`);
  expect(answer.status).toBe(200);
  return answer.body;
};
const attention = (body: { attention: Array<Record<string, unknown>> }, kind: string) =>
  body.attention.find((item) => item.kind === kind);

describe('the dashboard on an empty system', () => {
  it('needs dashboard:read and validates scope and days', async () => {
    expect((await (await adminWith(t, ['system:read'])).get('/admin/dashboard')).status).toBe(403);
    const api = await adminWith(t, ['dashboard:read']);
    expect((await api.anonymous('GET', '/admin/dashboard')).status).toBe(401);
    const days = await api.get('/admin/dashboard?scope=all&days=3');
    expect(days.status).toBe(422);
    expect(days.body.errors[0].field).toBe('days');
    expect((await api.get('/admin/dashboard?scope=x&days=7')).body.errors[0].field).toBe('scope');
  });

  it('answers zeros, nulls and four queue rows for every scope, defaulting to all and 7 days', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const body = await dashboard(api, '');
    expect(body.generatedAt).toBe(clock.now().toISOString());
    expect(body.stats).toEqual({
      current: { revenue: '0.0000', profit: '0.0000', orders: 0, successRate: null, medianTurnaroundSeconds: null },
      previous: null,
    });
    expect(body.attention).toEqual([]);
    expect(body.queues.map((q: { type: string }) => q.type)).toEqual(['imei', 'server', 'remote', 'file']);
    expect(body.queues[0]).toEqual({ type: 'imei', open: 0, review: 0, pastSla: 0, oldestCreatedAt: null });
    expect(body.suppliers).toEqual([]);
    expect(body.ordersByType.daily).toHaveLength(30);
    expect(body.ordersByType.daily[29]).toEqual({
      date: clock.now().toISOString().slice(0, 10),
      imei: 0,
      server: 0,
      remote: 0,
      file: 0,
    });
    expect(body.ordersByType.monthly).toBeNull();
    expect(body.revenueByChannel.daily).toHaveLength(30);
    expect(body.revenueByChannel.totals).toEqual({
      last7Days: { b2b: '0.0000', b2c: '0.0000' },
      last30Days: { b2b: '0.0000', b2c: '0.0000' },
    });
    expect(body.storefront).toEqual({
      funnel: { visitorsEstimated: 0, imeiChecks: 0, checkoutsStarted: 0, paid: 0, delivered: 0 },
      averageOrder: null,
      refundRate: null,
      disputeRate: null,
      firstReplySeconds: null,
      satisfaction: null,
      heldForReview: 0,
    });
    expect(body.topCustomers).toEqual([]);
    expect(body.navCounts).toEqual({
      orders: { open: 0, pastSla: 0 },
      finance: { pendingDeposits: 0 },
      merchants: { pendingApproval: 0 },
      support: { open: 0, late: 0 },
      refunds: { open: 0, disputesDueSoon: 0 },
      risk: { held: 0 },
    });
  });

  it('leaves out the sections a scope does not use', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const b2b = await dashboard(api, 'scope=b2b&days=1');
    expect(b2b.storefront).toBeNull();
    expect(b2b.topCustomers).toBeNull();
    expect(b2b.revenueByChannel).toBeNull();
    const b2c = await dashboard(api, 'scope=b2c&days=14');
    expect(b2c.storefront).not.toBeNull();
    expect(b2c.revenueByChannel).toBeNull();
  });
});

describe('stats, queues and the age-only past-SLA rule', () => {
  it('compares the period with the one before and counts review queues and past-SLA orders', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const base = {
      serviceId: world.auto.serviceId,
      clientId: world.merchant.id,
      totalPrice: '20.0000',
      unitPrice: '20.0000',
      totalCost: '12.0000',
    };
    const done = (over: Partial<typeof s.orders.$inferInsert>) =>
      insertOrderRow(db, {
        ...base,
        status: 'completed',
        dispatchState: 'done',
        createdAt: ago(2 * DAY),
        completedAt: ago(2 * DAY - HOUR),
        ...over,
      });
    await done({});
    await done({ createdAt: ago(3 * DAY), completedAt: ago(3 * DAY - 3 * HOUR) });
    await insertOrderRow(db, { ...base, status: 'rejected', dispatchState: 'done', createdAt: ago(DAY) });
    await done({ createdAt: ago(10 * DAY), completedAt: ago(10 * DAY - HOUR) });
    await insertOrderRow(db, {
      ...base,
      status: 'pending',
      dispatchState: 'manual',
      createdAt: ago(5 * HOUR),
      placedAt: ago(5 * HOUR),
    });
    await insertOrderRow(db, {
      ...base,
      status: 'processing',
      dispatchState: 'needs_attention',
      createdAt: ago(2 * HOUR),
      placedAt: ago(2 * HOUR),
    });
    await insertOrderRow(db, {
      ...base,
      status: 'pending',
      dispatchState: 'pending',
      createdAt: ago(MINUTE),
      placedAt: ago(MINUTE),
    });
    const body = await dashboard(api);
    expect(body.stats.current).toMatchObject({
      revenue: '40.0000',
      profit: '16.0000',
      orders: 6,
      successRate: 66.67,
      medianTurnaroundSeconds: 7_200,
    });
    expect(body.stats.previous).toMatchObject({ orders: 1, revenue: '20.0000' });
    const imei = body.queues[0];
    expect(imei).toMatchObject({ type: 'imei', open: 3, review: 2, pastSla: 2 });
    expect(imei.oldestCreatedAt).toBe(ago(5 * HOUR).toISOString());
    const past = attention(body, 'orders_past_sla');
    // RULES dashboard 3: past SLA is critical whatever the count; review is high (merchant orders only).
    expect(past).toMatchObject({ severity: 'critical', count: 2, overdueSeconds: 4 * 3600, targetSeconds: 3600 });
    expect(attention(body, 'orders_review')).toMatchObject({ severity: 'high', count: 2, topReasonCount: 1 });
    expect(body.navCounts.orders).toEqual({ open: 3, pastSla: 2 });
    expect(body.ordersByType.daily.at(-1)).toMatchObject({ imei: 3 });
    expect(body.ordersByType.monthly).not.toBeNull();
    const day = (n: number) =>
      ago(n * DAY)
        .toISOString()
        .slice(0, 10);
    expect(body.revenueByChannel.daily.find((d: { date: string }) => d.date === day(2))).toMatchObject({
      b2b: '20.0000',
      b2c: '0.0000',
    });
    expect(body.revenueByChannel.totals.last30Days.b2b).toBe('60.0000');
    expect(body.revenueByChannel.totals.last7Days.b2b).toBe('40.0000');
  });
});

describe('suppliers', () => {
  async function supplier(name: string, over: Partial<typeof s.suppliers.$inferInsert> = {}) {
    const { db } = await testDb();
    const [row] = await db
      .insert(s.suppliers)
      .values({
        name,
        driver: 'dhru',
        baseUrl: 'https://s.example',
        paramFormat: 'dhru_xml',
        balance: '1000.0000',
        ...over,
      })
      .returning({ id: s.suppliers.id });
    return row!.id;
  }
  const check = async (supplierId: number, status: 'ok' | 'degraded' | 'down' | 'unknown') => {
    const { db } = await testDb();
    await db
      .insert(s.serviceChecks)
      .values({ component: `supplier:${supplierId}`, supplierId, status, checkedAt: ago(MINUTE) });
  };

  it('maps the latest check to up, degraded and down, and an unknown or missing check to degraded without an alert', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const ok = await supplier('Ok Supplier');
    const degraded = await supplier('Degraded Supplier');
    const down = await supplier('Down Supplier');
    const unknown = await supplier('Unknown Supplier');
    const fresh = await supplier('Fresh Supplier');
    await check(ok, 'ok');
    await check(degraded, 'degraded');
    await check(down, 'down');
    await check(unknown, 'unknown');
    const { db } = await testDb();
    await db.insert(s.supplierApiLogs).values([
      { supplierId: ok, action: 'a', outcome: 'ok', durationMs: 200, createdAt: ago(5 * MINUTE) },
      { supplierId: ok, action: 'a', outcome: 'ok', durationMs: 400, createdAt: ago(4 * MINUTE) },
      { supplierId: ok, action: 'a', outcome: 'error', durationMs: 900, createdAt: ago(3 * MINUTE) },
    ]);
    const body = await dashboard(api);
    const health = Object.fromEntries(
      body.suppliers.map((row: { id: number; health: string }) => [row.id, row.health]),
    );
    expect(health).toEqual({
      [ok]: 'up',
      [degraded]: 'degraded',
      [down]: 'down',
      [unknown]: 'degraded',
      [fresh]: 'degraded',
    });
    expect(body.suppliers[0]).toMatchObject({
      name: 'Ok Supplier',
      enabled: true,
      successRate1h: 66.7,
      p50Ms: 400,
      balance: '1000.0000',
      lowBalance: false,
    });
    const items = body.attention.filter((item: { kind: string }) => item.kind.startsWith('supplier_'));
    expect(items.map((item: { kind: string; supplierId: number }) => [item.kind, item.supplierId]).sort()).toEqual([
      ['supplier_degraded', degraded],
      ['supplier_down', down],
    ]);
    expect(items.find((item: { kind: string }) => item.kind === 'supplier_down').severity).toBe('critical');
    expect(body.attention[0].kind).toBe('supplier_down');
  });

  it("converts the balance to USD at the credit rate and judges a low balance in the supplier's own units", async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const low = await supplier('Credit Supplier', {
      balance: '100.0000',
      creditRate: '0.5000',
      lowBalanceAlert: '150.0000',
      status: 'disabled',
    });
    const rich = await supplier('Rich Supplier', {
      balance: '400.0000',
      creditRate: '0.5000',
      lowBalanceAlert: '150.0000',
    });
    const poor = await supplier('Poor Supplier', {
      balance: '100.0000',
      creditRate: '0.5000',
      lowBalanceAlert: '150.0000',
    });
    const body = await dashboard(api);
    const rows = Object.fromEntries(body.suppliers.map((row: { id: number }) => [row.id, row]));
    expect(rows[low]).toMatchObject({ enabled: false, balance: '50.0000', lowBalance: true });
    expect(rows[rich]).toMatchObject({ enabled: true, balance: '200.0000', lowBalance: false });
    const item = attention(body, 'supplier_balance_low') as unknown as Record<string, unknown>;
    expect(item).toMatchObject({
      supplierId: poor,
      supplierName: 'Poor Supplier',
      balance: '50.0000',
      minimum: '75.0000',
      runwayDays: null,
      severity: 'medium',
    });
    expect(body.attention.filter((i: { kind: string }) => i.kind === 'supplier_balance_low')).toHaveLength(1);
  });
});

describe("attention from the other modules' tables", () => {
  it('raises merchants pending, a negative wallet, a service below its floor and a stale exchange rate', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, world.other.id));
    await db
      .update(s.ledgerAccounts)
      .set({ balance: '-12.5000' })
      .where(
        and(
          eq(s.ledgerAccounts.kind, 'client_wallet'),
          eq(s.ledgerAccounts.ownerType, 'client'),
          eq(s.ledgerAccounts.ownerId, world.merchant.id),
        ),
      );
    await db
      .update(s.services)
      .set({ basePrice: '5.0000', effectiveCost: '13.5000' })
      .where(eq(s.services.id, world.auto.serviceId));
    await db
      .insert(s.currencies)
      .values({ code: 'EUR', name: 'Euro', rateToBase: '0.9200', rateUpdatedAt: ago(3 * DAY) });
    const body = await dashboard(api);
    expect(attention(body, 'merchants_pending')).toMatchObject({
      count: 1,
      names: ['Erbil Mobile Parts'],
      severity: 'low',
    });
    expect(attention(body, 'services_below_floor')).toMatchObject({
      count: 1,
      serviceNames: ['AT&T USA Premier Unlock'],
      severity: 'high',
    });
    expect(attention(body, 'fx_stale')).toMatchObject({
      currencies: ['EUR'],
      oldestUpdatedAt: ago(3 * DAY).toISOString(),
      severity: 'medium',
    });
    expect(body.navCounts.merchants.pendingApproval).toBe(1);
    // The only wallet below zero, with its balance in the ledger's sign; the other merchant's funded wallet is not listed.
    expect(attention(body, 'wallets_negative')).toEqual({
      id: 'wallets_negative',
      severity: 'medium',
      kind: 'wallets_negative',
      count: 1,
      clients: [{ id: world.merchant.id, name: 'Cairo GSM Lab', balance: '-12.5000' }],
    });
  });

  it('converts a pending deposit in another currency to USD per row and counts it for the sidebar', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    await insertUsd(db);
    await db.insert(s.currencies).values({ code: 'EUR', name: 'Euro', rateToBase: '0.9200' });
    const [gateway] = await db
      .insert(s.paymentGateways)
      .values({ code: 'bank', driver: 'manual', name: 'Bank transfer', isManual: true })
      .returning({ id: s.paymentGateways.id });
    await db.insert(s.payments).values([
      {
        purpose: 'topup',
        gatewayId: gateway!.id,
        amount: '92.0000',
        currency: 'EUR',
        status: 'pending',
        methodType: 'bank',
        createdAt: ago(2 * HOUR),
      },
      {
        purpose: 'topup',
        gatewayId: gateway!.id,
        amount: '50.0000',
        currency: 'USD',
        status: 'pending',
        methodType: 'bank',
        createdAt: ago(HOUR),
      },
      {
        purpose: 'topup',
        gatewayId: gateway!.id,
        amount: '30.0000',
        currency: 'USD',
        status: 'approved',
        methodType: 'bank',
      },
    ]);
    const body = await dashboard(api, 'scope=b2b&days=7');
    expect(attention(body, 'deposits_pending')).toMatchObject({
      count: 2,
      total: '150.0000',
      oldestAt: ago(2 * HOUR).toISOString(),
    });
    expect(body.navCounts.finance.pendingDeposits).toBe(2);
    const storefront = await dashboard(api, 'scope=b2c&days=7');
    expect(attention(storefront, 'deposits_pending')).toBeUndefined();
  });
});

describe('the storefront block', () => {
  it('counts the funnel from checkout sessions (b2c-10) and ranks the top customers by spend including VAT', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const [ada, bob] = await db
      .insert(s.customers)
      .values([
        { email: 'ada@example.com', name: 'Ada', country: 'JO', currency: 'USD' },
        { email: 'bob@example.com', name: 'Bob', country: 'EG', currency: 'USD' },
      ])
      .returning({ id: s.customers.id });
    const session = (n: number, over: Partial<typeof s.checkoutSessions.$inferInsert> = {}) => ({
      token: `tok-${n}`,
      email: 'ada@example.com',
      serviceId: world.auto.serviceId,
      currency: 'USD',
      netAmount: '20.0000',
      grossAmount: '23.8000',
      expiresAt: ago(-HOUR),
      ip: `203.0.113.${n}`,
      createdAt: ago(DAY),
      ...over,
    });
    const paidOrder = (customerId: number, status: 'completed' | 'pending', total: string) =>
      insertOrderRow(db, {
        serviceId: world.auto.serviceId,
        clientId: null,
        customerId,
        status,
        dispatchState: status === 'completed' ? 'done' : 'pending',
        totalPrice: total,
        taxAmount: '3.8000',
        createdAt: ago(DAY),
      });
    const delivered = await paidOrder(ada!.id, 'completed', '20.0000');
    const inFlight = await paidOrder(bob!.id, 'pending', '10.0000');
    await db
      .insert(s.checkoutSessions)
      .values([
        session(1, { orderId: delivered.id, status: 'paid' }),
        session(2, { orderId: inFlight.id, status: 'paid' }),
        session(3, { status: 'expired' }),
        session(4, { createdAt: ago(40 * DAY) }),
      ]);
    const body = await dashboard(api, 'scope=b2c&days=7');
    expect(body.storefront.funnel).toEqual({
      visitorsEstimated: 3,
      imeiChecks: 0,
      checkoutsStarted: 3,
      paid: 2,
      delivered: 1,
    });
    expect(body.storefront.averageOrder).toBe('23.8000');
    expect(body.topCustomers).toEqual([
      { id: ada!.id, name: 'Ada', country: 'JO', orders: 1, spend: '23.8000' },
      { id: bob!.id, name: 'Bob', country: 'EG', orders: 1, spend: '13.8000' },
    ]);
  });
});

describe('caching', () => {
  it('serves the same payload for 15 seconds per scope and days', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const first = await dashboard(api);
    clock.advance(5_000);
    const second = await dashboard(api);
    expect(second.generatedAt).toBe(first.generatedAt);
    const other = await dashboard(api, 'scope=b2b&days=7');
    expect(other.generatedAt).toBe(clock.now().toISOString());
  });
});
