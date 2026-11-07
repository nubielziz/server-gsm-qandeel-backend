// Integration tests of the attention list of `GET /admin/dashboard` (feature 9, RULES dashboard 3 and 8): one case per kind with its
// rule severity, the supplier items of active suppliers only, merchant orders only in the review item, the storefront money converted
// at the checkout's locked rate with one rounding, every dispute that needs a response, and the 24 h stale-rate rule of the currencies page.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheKeys, CacheService } from '../../src/infra/cache';
import { type Database, schema as s } from '../../src/infra/db';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { insertOrderRow, ordersWorld } from '../support/orders';

const clock = new TestClock();
let t: TestApp;

/** Drops the cached payloads, so a test can read the dashboard again after it changed the data. */
async function clearDashboardCache(): Promise<void> {
  await t.app
    .get(CacheService, { strict: false })
    .delByPrefix(t.app.get(CacheKeys, { strict: false }).prefix('dashboard', 'payload'));
}

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearDashboardCache();
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ago = (ms: number) => new Date(clock.now().getTime() - ms);
const ahead = (ms: number) => new Date(clock.now().getTime() + ms);
type Api = Awaited<ReturnType<typeof adminWith>>;
/** One read of the dashboard (never from the cache). */
const dashboard = async (api: Api, query = 'scope=all&days=7') => {
  await clearDashboardCache();
  const answer = await api.get(`/admin/dashboard?${query}`);
  expect(answer.status).toBe(200);
  return answer.body;
};
const item = (body: { attention: Array<Record<string, unknown>> }, kind: string) =>
  body.attention.find((entry) => entry.kind === kind);
const kinds = (body: { attention: Array<Record<string, unknown>> }) => body.attention.map((entry) => entry.kind);

/**
 * A storefront customer whose checkout locked 3 EUR per USD while the current rate is 2: a row converted at the locked rate and a row
 * converted at the current rate give different answers, and neither equals the amount as it is.
 */
async function lockedRateWorld(db: Database) {
  const world = await ordersWorld(db);
  await db.insert(s.currencies).values({ code: 'EUR', name: 'Euro', rateToBase: '2.0000', rateUpdatedAt: ago(HOUR) });
  const [customer] = await db
    .insert(s.customers)
    .values({ email: 'ada@example.com', name: 'Ada', country: 'JO', currency: 'USD' })
    .returning({ id: s.customers.id });
  const order = await insertOrderRow(db, {
    serviceId: world.auto.serviceId,
    clientId: null,
    customerId: customer!.id,
    status: 'completed',
    dispatchState: 'done',
    totalPrice: '20.0000',
    taxAmount: '3.8000',
    createdAt: ago(DAY),
    placedAt: ago(DAY),
    completedAt: ago(DAY),
  });
  const [session] = await db
    .insert(s.checkoutSessions)
    .values({
      token: 'tok-locked',
      email: 'ada@example.com',
      serviceId: world.auto.serviceId,
      customerId: customer!.id,
      currency: 'EUR',
      fxRate: '3.00000000',
      netAmount: '60.0000',
      grossAmount: '71.4000',
      status: 'paid',
      orderId: order.id,
      expiresAt: ahead(HOUR),
      createdAt: ago(DAY),
    })
    .returning({ id: s.checkoutSessions.id });
  await db.update(s.orders).set({ checkoutSessionId: session!.id }).where(eq(s.orders.id, order.id));
  const [gateway] = await db
    .insert(s.paymentGateways)
    .values({ code: 'card', driver: 'manual', name: 'Card', isManual: true })
    .returning({ id: s.paymentGateways.id });
  const [payment] = await db
    .insert(s.payments)
    .values({
      purpose: 'order',
      gatewayId: gateway!.id,
      customerId: customer!.id,
      orderId: order.id,
      amount: '71.4000',
      currency: 'EUR',
      status: 'captured',
      methodType: 'card',
    })
    .returning({ id: s.payments.id });
  return { world, customer: customer!, order, payment: payment! };
}

describe('money at the checkout locked rate (identity-platform-8)', () => {
  it('converts refunds per row at the locked rate and rounds the sum once', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const { world, customer, order, payment } = await lockedRateWorld(db);
    const refund = {
      paymentId: payment.id,
      orderId: order.id,
      customerId: customer.id,
      amount: '1.0000',
      currency: 'EUR',
      method: 'original' as const,
      status: 'requested' as const,
      requestedByType: 'customer' as const,
      requestedById: customer.id,
    };
    await db.insert(s.refunds).values([refund, refund, refund]);
    // Three refunds of 1.0000 at 3 per USD: each is 0.33333333..., the sum rounds once to 1.0000. Rounding each row first gives 0.9999,
    // and the current rate (2) would give 1.5000.
    expect(item(await dashboard(api), 'refunds_requested')).toMatchObject({
      count: 3,
      total: '1.0000',
      severity: 'medium',
    });
    // A refund with no checkout (a merchant's) converts at the current rate: 1.0000 / 2 = 0.5000 more.
    await db.insert(s.refunds).values({
      clientId: world.merchant.id,
      amount: '1.0000',
      currency: 'EUR',
      method: 'manual',
      status: 'requested',
      requestedByType: 'staff',
      requestedById: api.staffId,
    });
    expect(item(await dashboard(api), 'refunds_requested')).toMatchObject({ count: 4, total: '1.5000' });
  });

  it("converts a dispute's amount and fee at the locked rate, and states the first one that needs a response", async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const { order, payment } = await lockedRateWorld(db);
    const dispute = (n: number, over: Partial<typeof s.disputes.$inferInsert>) => ({
      paymentId: payment.id,
      orderId: order.id,
      gatewayDisputeId: `dp_${n}`,
      reasonCode: 'fraudulent',
      amount: '30.0000',
      fee: '15.0000',
      currency: 'EUR',
      status: 'needs_response' as const,
      evidenceDueAt: ahead(2 * DAY),
      ...over,
    });
    const [first, later] = await db
      .insert(s.disputes)
      .values([
        dispute(1, {}),
        dispute(2, { amount: '90.0000', fee: '45.0000', evidenceDueAt: ahead(10 * DAY) }),
        dispute(3, { status: 'under_review', evidenceDueAt: ahead(DAY) }),
      ])
      .returning({ id: s.disputes.id });
    const body = await dashboard(api);
    // 30 EUR at 3 per USD is 10 USD and the 15 EUR fee is 5 USD; the item counts every dispute that needs a response (not the one
    // under review) and is critical because the first is due within 3 days.
    expect(item(body, 'disputes_due')).toMatchObject({
      severity: 'critical',
      count: 2,
      firstDisputeId: first!.id,
      dueAt: ahead(2 * DAY).toISOString(),
      amount: '10.0000',
      fee: '5.0000',
    });
    expect(body.navCounts.refunds).toEqual({ open: 2, disputesDueSoon: 1 });

    // Once the near one is answered, the item stays for the other and drops to high: its deadline is 10 days away.
    await db.update(s.disputes).set({ status: 'won' }).where(eq(s.disputes.id, first!.id));
    const calm = await dashboard(api);
    expect(item(calm, 'disputes_due')).toMatchObject({
      severity: 'high',
      count: 1,
      firstDisputeId: later!.id,
      amount: '30.0000',
      fee: '15.0000',
    });
    expect(calm.navCounts.refunds).toEqual({ open: 1, disputesDueSoon: 0 });
  });
});

describe('the storefront attention items', () => {
  async function customer(db: Database) {
    const [row] = await db
      .insert(s.customers)
      .values({ email: 'bob@example.com', name: 'Bob', country: 'EG', currency: 'USD' })
      .returning({ id: s.customers.id });
    return row!.id;
  }

  it('raises held storefront orders as high and keeps them out of the merchant review item', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const customerId = await customer(db);
    const held = (placedAt: Date) =>
      insertOrderRow(db, {
        serviceId: world.auto.serviceId,
        clientId: null,
        customerId,
        status: 'pending',
        dispatchState: 'held',
        totalPrice: '20.0000',
        taxAmount: '3.8000',
        createdAt: placedAt,
        placedAt,
      });
    await held(ago(2 * HOUR));
    await held(ago(3 * HOUR));
    await insertOrderRow(db, {
      serviceId: world.auto.serviceId,
      clientId: world.merchant.id,
      status: 'pending',
      dispatchState: 'manual',
      createdAt: ago(10 * MINUTE),
      placedAt: ago(10 * MINUTE),
    });
    const all = await dashboard(api);
    // High although the oldest is only 3 hours old; what the customers paid, VAT included.
    expect(item(all, 'orders_held')).toMatchObject({
      severity: 'high',
      count: 2,
      captured: '47.6000',
      oldestAt: ago(3 * HOUR).toISOString(),
    });
    // The review item is the merchant's manual order alone: the two held storefront orders are not counted twice.
    expect(item(all, 'orders_review')).toMatchObject({
      severity: 'high',
      count: 1,
      topReason: 'Manual orders',
      topReasonCount: 1,
    });
    expect(all.navCounts.risk).toEqual({ held: 2 });
    expect(all.storefront.heldForReview).toBe(2);

    const b2c = await dashboard(api, 'scope=b2c&days=7');
    expect(item(b2c, 'orders_held')).toMatchObject({ count: 2 });
    expect(item(b2c, 'orders_review')).toBeUndefined();
    const b2b = await dashboard(api, 'scope=b2b&days=7');
    expect(item(b2b, 'orders_held')).toBeUndefined();
    expect(item(b2b, 'orders_review')).toMatchObject({ count: 1 });
  });

  it('raises late tickets (a past deadline on an unanswered ticket) as medium', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    await insertUsd(db);
    const requesterId = await customer(db);
    const ticket = (n: number, over: Partial<typeof s.supportTickets.$inferInsert>) => ({
      number: `T-${n}`,
      subject: `Ticket ${n}`,
      requesterType: 'customer' as const,
      requesterId,
      status: 'open' as const,
      slaDueAt: ago(HOUR),
      createdAt: ago(HOUR),
      ...over,
    });
    const [oldest] = await db
      .insert(s.supportTickets)
      .values([
        ticket(1, { subject: 'Where is my unlock?', createdAt: ago(5 * HOUR) }),
        ticket(2, { status: 'new', slaDueAt: ago(MINUTE), createdAt: ago(2 * HOUR) }),
        ticket(3, { slaDueAt: ahead(HOUR) }),
        ticket(4, { status: 'resolved' }),
        ticket(5, { slaDueAt: null }),
      ])
      .returning({ id: s.supportTickets.id });
    const body = await dashboard(api, 'scope=b2c&days=7');
    expect(item(body, 'tickets_late')).toEqual({
      id: 'tickets_late',
      severity: 'medium',
      kind: 'tickets_late',
      count: 2,
      oldestTicketId: oldest!.id,
      waitingSince: ago(5 * HOUR).toISOString(),
      subject: 'Where is my unlock?',
    });
    // Four tickets are not resolved; the sidebar shows them and the late two.
    expect(body.navCounts.support).toEqual({ open: 4, late: 2 });
    expect(item(await dashboard(api, 'scope=b2b&days=7'), 'tickets_late')).toBeUndefined();
  });

  it('raises requested refunds as medium and failed refunds as high with the first one and its reason', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const refund = (status: 'requested' | 'failed', over: Partial<typeof s.refunds.$inferInsert> = {}) => ({
      clientId: world.merchant.id,
      amount: '5.0000',
      currency: 'USD',
      method: 'manual' as const,
      status,
      requestedByType: 'staff' as const,
      requestedById: api.staffId,
      ...over,
    });
    const [firstFailed] = await db
      .insert(s.refunds)
      .values([
        refund('failed', { reason: 'Card network declined', createdAt: ago(3 * HOUR) }),
        refund('failed', { reason: 'Card closed', createdAt: ago(HOUR) }),
        refund('requested'),
      ])
      .returning({ id: s.refunds.id });
    const body = await dashboard(api);
    expect(item(body, 'refunds_failed')).toEqual({
      id: 'refunds_failed',
      severity: 'high',
      kind: 'refunds_failed',
      count: 2,
      firstRefundId: firstFailed!.id,
      reason: 'Card network declined',
    });
    expect(item(body, 'refunds_requested')).toEqual({
      id: 'refunds_requested',
      severity: 'medium',
      kind: 'refunds_requested',
      count: 1,
      total: '5.0000',
    });
    expect(body.navCounts.refunds.open).toBe(3);
    // Neither is a merchant item, and neither is shown for the merchants' scope.
    expect(kinds(await dashboard(api, 'scope=b2b&days=7'))).not.toContain('refunds_failed');
  });
});

describe('the merchant attention items', () => {
  it('raises accrued commissions as low, counting only accrued ones and the distinct merchants', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const [plan] = await db
      .insert(s.commissionPlans)
      .values({ name: 'Referral 10%', kind: 'referral', basis: 'revenue', period: 'monthly', percent: '10.0000' })
      .returning({ id: s.commissionPlans.id });
    const order = (clientId: number) =>
      insertOrderRow(db, {
        serviceId: world.auto.serviceId,
        clientId,
        status: 'completed',
        dispatchState: 'done',
        createdAt: ago(DAY),
        completedAt: ago(DAY),
      });
    const accrual = async (
      clientId: number,
      amount: string,
      status: 'accrued' | 'approved' | 'reversed',
      over: Partial<typeof s.commissionAccruals.$inferInsert> = {},
    ) =>
      db.insert(s.commissionAccruals).values({
        planId: plan!.id,
        beneficiaryId: clientId,
        orderId: (await order(clientId)).id,
        period: '2026-11',
        basisAmount: '100.0000',
        percent: '10.0000',
        amount,
        status,
        ...over,
      });
    await accrual(world.merchant.id, '10.0000', 'accrued');
    await accrual(world.merchant.id, '2.5000', 'accrued');
    await accrual(world.other.id, '1.0000', 'accrued');
    await accrual(world.other.id, '99.0000', 'approved', { approvedAt: ago(HOUR) });
    await accrual(world.other.id, '77.0000', 'reversed');
    const body = await dashboard(api);
    expect(item(body, 'commissions_accrued')).toEqual({
      id: 'commissions_accrued',
      severity: 'low',
      kind: 'commissions_accrued',
      count: 3,
      total: '13.5000',
      agents: 2,
    });
    expect(item(await dashboard(api, 'scope=b2c&days=7'), 'commissions_accrued')).toBeUndefined();
  });

  it('gives each kind its rule severity and ranks critical first', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    // The world's supplier starts with an empty balance; fund it so that it raises nothing here.
    await db.update(s.suppliers).set({ balance: '5000.0000' }).where(eq(s.suppliers.id, world.auto.supplierId));
    // A merchant waiting for approval, a deposit waiting, a service priced below its floor, one past-SLA order and one stale rate.
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, world.other.id));
    await db
      .update(s.services)
      .set({ basePrice: '5.0000', effectiveCost: '13.5000' })
      .where(eq(s.services.id, world.auto.serviceId));
    await db
      .insert(s.currencies)
      .values({ code: 'EUR', name: 'Euro', rateToBase: '0.9200', rateUpdatedAt: ago(26 * HOUR) });
    const [gateway] = await db
      .insert(s.paymentGateways)
      .values({ code: 'bank', driver: 'manual', name: 'Bank transfer', isManual: true })
      .returning({ id: s.paymentGateways.id });
    await db.insert(s.payments).values({
      purpose: 'topup',
      gatewayId: gateway!.id,
      amount: '50.0000',
      currency: 'USD',
      status: 'pending',
      methodType: 'bank',
      createdAt: ago(HOUR),
    });
    await insertOrderRow(db, {
      serviceId: world.auto.serviceId,
      clientId: world.merchant.id,
      status: 'processing',
      dispatchState: 'pending',
      createdAt: ago(5 * HOUR),
      placedAt: ago(5 * HOUR),
    });
    const body = await dashboard(api);
    const severities = Object.fromEntries(
      body.attention.map((entry: { kind: string; severity: string }) => [entry.kind, entry.severity]),
    );
    expect(severities).toEqual({
      orders_past_sla: 'critical',
      services_below_floor: 'high',
      deposits_pending: 'medium',
      fx_stale: 'medium',
      merchants_pending: 'low',
    });
    expect(kinds(body)).toEqual([
      'orders_past_sla',
      'services_below_floor',
      'deposits_pending',
      'fx_stale',
      'merchants_pending',
    ]);
  });
});

describe('supplier items', () => {
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
  const check = async (supplierId: number, status: 'ok' | 'degraded' | 'down') => {
    const { db } = await testDb();
    await db
      .insert(s.serviceChecks)
      .values({ component: `supplier:${supplierId}`, supplierId, status, checkedAt: ago(MINUTE) });
  };

  it('raises down, degraded and low balance for active suppliers only, never for a paused or a disabled one', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const down = await supplier('Active Down');
    const degraded = await supplier('Active Degraded');
    const pausedDown = await supplier('Paused Down', {
      status: 'paused',
      balance: '1.0000',
      lowBalanceAlert: '150.0000',
    });
    const disabledDown = await supplier('Disabled Down', {
      status: 'disabled',
      balance: '1.0000',
      lowBalanceAlert: '150.0000',
    });
    const low = await supplier('Active Low', { balance: '10.0000', lowBalanceAlert: '150.0000' });
    for (const [id, status] of [
      [down, 'down'],
      [degraded, 'degraded'],
      [pausedDown, 'down'],
      [disabledDown, 'down'],
    ] as const)
      await check(id, status);
    const body = await dashboard(api);
    const raised = body.attention
      .filter((entry: { kind: string }) => entry.kind.startsWith('supplier_'))
      .map((entry: { kind: string; supplierId: number; severity: string }) => [
        entry.kind,
        entry.supplierId,
        entry.severity,
      ]);
    expect(raised).toEqual([
      ['supplier_down', down, 'critical'],
      ['supplier_degraded', degraded, 'high'],
      ['supplier_balance_low', low, 'medium'],
    ]);
    // The suppliers card still lists every supplier, with the health of its check.
    const health = Object.fromEntries(
      body.suppliers.map((row: { id: number; health: string }) => [row.id, row.health]),
    );
    expect(health[pausedDown]).toBe('down');
    expect(health[disabledDown]).toBe('down');
  });

  it('keeps a low balance medium even with less than a day of runway left', async () => {
    const api = await adminWith(t, ['dashboard:read']);
    const { db } = await testDb();
    const world = await ordersWorld(db);
    await db.update(s.suppliers).set({ balance: '5000.0000' }).where(eq(s.suppliers.id, world.auto.supplierId));
    const burning = await supplier('Burning Supplier', { balance: '100.0000', lowBalanceAlert: '10.0000' });
    // 1400 of cost over the last 7 days is 200 a day, so 100 lasts half a day.
    for (const day of [1, 2]) {
      await insertOrderRow(db, {
        serviceId: world.auto.serviceId,
        clientId: world.merchant.id,
        supplierId: burning,
        status: 'completed',
        dispatchState: 'done',
        totalCost: '700.0000',
        createdAt: ago(day * DAY),
        completedAt: ago(day * DAY - HOUR),
      });
    }
    expect(item(await dashboard(api), 'supplier_balance_low')).toMatchObject({
      supplierId: burning,
      runwayDays: 0.5,
      severity: 'medium',
    });
  });
});

describe('fx_stale (RULES dashboard 3, M166)', () => {
  it('uses the currencies page rule: a non-base active rate older than 24 hours, oldest first', async () => {
    const api = await adminWith(t, ['dashboard:read', 'settings:update']);
    const { db } = await testDb();
    await insertUsd(db);
    const currency = (code: string, rateUpdatedAt: Date, over: Partial<typeof s.currencies.$inferInsert> = {}) => ({
      code,
      name: code,
      rateToBase: '0.9200',
      rateUpdatedAt,
      ...over,
    });
    await db.insert(s.currencies).values([
      currency('EUR', ago(25 * HOUR)),
      currency('GBP', ago(23 * HOUR)),
      currency('JOD', ago(30 * HOUR)),
      // Switched off: nobody refreshes it, so it is not an alert (the currencies page still marks it stale).
      currency('SAR', ago(10 * DAY), { isActive: false }),
    ]);
    // The base currency is never stale, however old its row is.
    await db
      .update(s.currencies)
      .set({ rateUpdatedAt: ago(10 * DAY) })
      .where(eq(s.currencies.code, 'USD'));
    const body = await dashboard(api);
    expect(item(body, 'fx_stale')).toEqual({
      id: 'fx_stale',
      severity: 'medium',
      kind: 'fx_stale',
      currencies: ['JOD', 'EUR'],
      oldestUpdatedAt: ago(30 * HOUR).toISOString(),
    });
    // Same answer as the currencies page for the active ones.
    const page = await api.get('/admin/currencies?_end=100&isActive=true');
    const staleOnPage = page.body
      .filter((row: { isStale: boolean }) => row.isStale)
      .map((row: { code: string }) => row.code)
      .sort();
    expect(staleOnPage).toEqual(['EUR', 'JOD']);
  });
});
