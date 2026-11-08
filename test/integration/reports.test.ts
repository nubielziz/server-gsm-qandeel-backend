// The money reports of feature 11 (docs/contract/endpoints/money.md, suppliers.md, orders.md; MISMATCHES B88): profit by day, service, supplier or
// merchant from the completed orders of a range of days, the wallet exposure from the ledger accounts, the supplier report from orders and the
// supplier call log, and the top merchants. Dates are UTC days; every window ends at the injected clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { DbService, schema as s } from '../../src/infra/db';
import { adjust, postTransaction } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant } from '../support/money';
import { placeOrderHold } from '../support/commissions';
import { type OrdersWorld, insertOrderRow, ordersWorld } from '../support/orders';

setDefaultTimeout(60_000);

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
/** A second supplier that served orders, and a third that served none. */
let gulf: number;
let idle: number;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  world = await ordersWorld(db);
  await db.update(s.suppliers).set({ name: 'Nordic GSM' }).where(eq(s.suppliers.id, world.auto.supplierId));
  const suppliers = await db
    .insert(s.suppliers)
    .values([
      { name: 'Gulf Server Hub', driver: 'dhru', baseUrl: 'https://gulf.example.com', paramFormat: 'dhru_xml' },
      { name: 'Idle Supplier', driver: 'dhru', baseUrl: 'https://idle.example.com', paramFormat: 'dhru_xml' },
    ])
    .returning({ id: s.suppliers.id });
  gulf = suppliers[0]!.id;
  idle = suppliers[1]!.id;
  staff = await adminWith(t, ['reports:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const at = (iso: string) => new Date(iso);

/**
 * The orders the reports read, with exact times:
 * 1 Nordic, merchant, auto: 17.28 / 13.50, completed 11-06 10:00, sent 09:00 (3600 s)
 * 2 Nordic, merchant, auto: 20.00 / 15.00, completed 11-06 22:30, sent 22:00 (1800 s)
 * 3 Gulf, other, manual: 5.00 / 3.00, completed 11-07 00:00:00.000 (the first millisecond of the day), created 11-06 23:59, never sent (60 s)
 * 4 no supplier, other, auto: 10.00 / 0 (a stock delivery), completed 11-05 12:00
 * 5 Nordic, merchant: rejected
 * 6 Nordic, merchant: completed in October, outside every window
 * 7 Gulf, a storefront customer: 12.49 / 7.20, completed 11-06 12:00, sent 11:10 (3000 s)
 * 8 merchant: still pending, 17.28
 */
async function seedOrders() {
  const { db, merchant, other, auto, manual } = world;
  const base = { type: 'imei' as const, currency: 'USD' };
  const [customer] = await db
    .insert(s.customers)
    .values({ email: `c-${crypto.randomUUID()}@example.com`, name: 'Jack Turner' })
    .returning({ id: s.customers.id });
  const row = (values: Parameters<typeof insertOrderRow>[1]) => insertOrderRow(db, { ...base, ...values });
  const o1 = await row({
    clientId: merchant.id,
    serviceId: auto.serviceId,
    supplierId: auto.supplierId,
    status: 'completed',
    dispatchState: 'done',
    unitPrice: '17.2800',
    totalPrice: '17.2800',
    unitCost: '13.5000',
    totalCost: '13.5000',
    createdAt: at('2026-11-06T08:00:00.000Z'),
    sentAt: at('2026-11-06T09:00:00.000Z'),
    completedAt: at('2026-11-06T10:00:00.000Z'),
  });
  const o2 = await row({
    clientId: merchant.id,
    serviceId: auto.serviceId,
    supplierId: auto.supplierId,
    status: 'completed',
    dispatchState: 'done',
    unitPrice: '20.0000',
    totalPrice: '20.0000',
    unitCost: '15.0000',
    totalCost: '15.0000',
    createdAt: at('2026-11-06T21:00:00.000Z'),
    sentAt: at('2026-11-06T22:00:00.000Z'),
    completedAt: at('2026-11-06T22:30:00.000Z'),
  });
  const o3 = await row({
    clientId: other.id,
    serviceId: manual.serviceId,
    supplierId: gulf,
    status: 'completed',
    dispatchState: 'done',
    unitPrice: '5.0000',
    totalPrice: '5.0000',
    unitCost: '3.0000',
    totalCost: '3.0000',
    createdAt: at('2026-11-06T23:59:00.000Z'),
    completedAt: at('2026-11-07T00:00:00.000Z'),
  });
  const o4 = await row({
    clientId: other.id,
    serviceId: auto.serviceId,
    status: 'completed',
    dispatchState: 'done',
    unitPrice: '10.0000',
    totalPrice: '10.0000',
    unitCost: '0.0000',
    totalCost: '0.0000',
    createdAt: at('2026-11-05T11:00:00.000Z'),
    completedAt: at('2026-11-05T12:00:00.000Z'),
  });
  const o5 = await row({
    clientId: merchant.id,
    serviceId: auto.serviceId,
    supplierId: auto.supplierId,
    status: 'rejected',
    dispatchState: 'done',
    unitPrice: '17.2800',
    totalPrice: '17.2800',
    createdAt: at('2026-11-06T12:30:00.000Z'),
    completedAt: at('2026-11-06T13:00:00.000Z'),
  });
  const o6 = await row({
    clientId: merchant.id,
    serviceId: auto.serviceId,
    supplierId: auto.supplierId,
    status: 'completed',
    dispatchState: 'done',
    unitPrice: '17.2800',
    totalPrice: '17.2800',
    unitCost: '13.5000',
    totalCost: '13.5000',
    createdAt: at('2026-10-01T08:00:00.000Z'),
    completedAt: at('2026-10-01T09:00:00.000Z'),
  });
  const o7 = await row({
    customerId: customer!.id,
    serviceId: auto.serviceId,
    supplierId: gulf,
    source: 'store',
    status: 'completed',
    dispatchState: 'done',
    unitPrice: '12.4900',
    totalPrice: '12.4900',
    unitCost: '7.2000',
    totalCost: '7.2000',
    createdAt: at('2026-11-06T11:00:00.000Z'),
    sentAt: at('2026-11-06T11:10:00.000Z'),
    completedAt: at('2026-11-06T12:00:00.000Z'),
  });
  const o8 = await row({
    clientId: merchant.id,
    serviceId: auto.serviceId,
    status: 'pending',
    unitPrice: '17.2800',
    totalPrice: '17.2800',
    createdAt: at('2026-11-07T08:00:00.000Z'),
  });
  return { o1, o2, o3, o4, o5, o6, o7, o8 };
}

describe('GET /admin/reports/profit', () => {
  it('splits by day, oldest first, counting only completed orders by the UTC day they completed', async () => {
    await seedOrders();
    const res = await staff.get('/admin/reports/profit?groupBy=day&from=2026-11-05&to=2026-11-07');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groupBy: 'day',
      from: '2026-11-05',
      to: '2026-11-07',
      currency: 'USD',
      rows: [
        { key: '2026-11-05', label: '2026-11-05', orders: 1, revenue: '10.0000', cost: '0.0000', profit: '10.0000' },
        { key: '2026-11-06', label: '2026-11-06', orders: 3, revenue: '49.7700', cost: '35.7000', profit: '14.0700' },
        { key: '2026-11-07', label: '2026-11-07', orders: 1, revenue: '5.0000', cost: '3.0000', profit: '2.0000' },
      ],
      totals: { orders: 5, revenue: '64.7700', cost: '38.7000', profit: '26.0700' },
    });
  });

  it('includes both ends of the range, leaves days without orders out, and cuts days at UTC midnight', async () => {
    await seedOrders();
    const one = await staff.get('/admin/reports/profit?groupBy=day&from=2026-11-06&to=2026-11-06');
    expect(one.body.rows.map((row: { key: string; orders: number }) => [row.key, row.orders])).toEqual([
      ['2026-11-06', 3],
    ]);
    const gap = await staff.get('/admin/reports/profit?groupBy=day&from=2026-11-01&to=2026-11-04');
    expect(gap.body).toMatchObject({
      rows: [],
      totals: { orders: 0, revenue: '0.0000', cost: '0.0000', profit: '0.0000' },
    });
  });

  it('splits by supplier ranked by profit, with "No supplier" as key 0', async () => {
    await seedOrders();
    const res = await staff.get('/admin/reports/profit?groupBy=supplier&from=2026-11-05&to=2026-11-07');
    expect(res.body.rows).toEqual([
      { key: '0', label: 'No supplier', orders: 1, revenue: '10.0000', cost: '0.0000', profit: '10.0000' },
      {
        key: String(world.auto.supplierId),
        label: 'Nordic GSM',
        orders: 2,
        revenue: '37.2800',
        cost: '28.5000',
        profit: '8.7800',
      },
      { key: String(gulf), label: 'Gulf Server Hub', orders: 2, revenue: '17.4900', cost: '10.2000', profit: '7.2900' },
    ]);
  });

  it('splits by merchant with the storefront customers as key 0, and by service', async () => {
    await seedOrders();
    const clients = await staff.get('/admin/reports/profit?groupBy=client&from=2026-11-05&to=2026-11-07');
    expect(
      clients.body.rows.map((row: { key: string; label: string; profit: string }) => [row.key, row.label, row.profit]),
    ).toEqual([
      [String(world.other.id), 'Erbil Mobile Parts', '12.0000'],
      [String(world.merchant.id), 'Cairo GSM Lab', '8.7800'],
      ['0', 'Storefront customers', '5.2900'],
    ]);
    const services = await staff.get('/admin/reports/profit?groupBy=service&from=2026-11-05&to=2026-11-07');
    expect(
      services.body.rows.map((row: { label: string; orders: number; profit: string }) => [
        row.label,
        row.orders,
        row.profit,
      ]),
    ).toEqual([
      ['AT&T USA Premier Unlock', 4, '24.0700'],
      ['Manual unlock', 1, '2.0000'],
    ]);
  });

  it('shows a loss as a negative profit', async () => {
    const { db, merchant, auto } = world;
    await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: auto.serviceId,
      status: 'completed',
      unitPrice: '5.0000',
      totalPrice: '5.0000',
      unitCost: '8.0000',
      totalCost: '8.0000',
      completedAt: at('2026-11-06T10:00:00.000Z'),
    });
    const res = await staff.get('/admin/reports/profit?groupBy=day&from=2026-11-06&to=2026-11-06');
    expect(res.body.totals).toEqual({ orders: 1, revenue: '5.0000', cost: '8.0000', profit: '-3.0000' });
  });

  it('does not count a refunded or reopened order: only orders completed now are revenue', async () => {
    const { o1 } = await seedOrders();
    await world.db.update(s.orders).set({ status: 'processing', completedAt: null }).where(eq(s.orders.id, o1.id));
    const res = await staff.get('/admin/reports/profit?groupBy=day&from=2026-11-06&to=2026-11-06');
    expect(res.body.totals.orders).toBe(2);
  });

  it('defaults to a daily split of the 30 days ending today and echoes the dates it used', async () => {
    await seedOrders();
    const res = await staff.get('/admin/reports/profit');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ groupBy: 'day', from: '2026-10-09', to: '2026-11-07' });
    // The October order is out of the 30 days.
    expect(res.body.totals.orders).toBe(5);
    const upTo = await staff.get('/admin/reports/profit?to=2026-10-02');
    expect(upTo.body).toMatchObject({ from: '2026-09-03', to: '2026-10-02' });
    expect(upTo.body.totals.orders).toBe(1);
  });

  it('answers 422 for an unknown split, a bad date and a range that runs backwards', async () => {
    const field = async (query: string) => {
      const res = await staff.get(`/admin/reports/profit?${query}`);
      expect(res.status).toBe(422);
      return res.body.errors.map((error: { field: string }) => error.field);
    };
    expect(await field('groupBy=week')).toContain('groupBy');
    expect(await field('from=2026-13-40')).toContain('from');
    expect(await field('to=yesterday')).toContain('to');
    expect(await field('from=2026-11-07&to=2026-11-01')).toEqual(['from']);
  });

  it('is refused without reports:read', async () => {
    const other = await adminWith(t, ['orders:read']);
    expect((await other.get('/admin/reports/profit')).status).toBe(403);
  });
});

describe('GET /admin/reports/wallet-exposure', () => {
  const debit = async (clientId: number, amount: string) => {
    const { db } = await testDb();
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...adjust({ clientId, amount: Money.of(amount), direction: 'debit' }),
          refId: clientId,
          idempotencyKey: `test:debit:${clientId}:${amount}`,
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        clock.now(),
      ),
    );
  };

  it('adds up the balances, the reserved amounts, the credit limits and the credit in use, largest balance first', async () => {
    const { db, merchant } = world;
    await placeOrderHold(db, merchant.id, '17.28');
    const credit = await insertWalletMerchant(db, { name: 'Credit Co', creditLimit: '200' });
    await debit(credit.id, '150');
    const lowered = await insertWalletMerchant(db, { name: 'Lowered Co', creditLimit: '200' });
    await debit(lowered.id, '50');
    // The limit was lowered below the credit in use (user rule 2): the report still shows what is really out.
    await db
      .update(s.ledgerAccounts)
      .set({ overdraftLimit: '20.0000' })
      .where(eq(s.ledgerAccounts.ownerId, lowered.id));

    const res = await staff.get('/admin/reports/wallet-exposure');
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('USD');
    expect(res.body.totals).toEqual({
      clients: 4,
      balance: '-17.2800',
      reserved: '17.2800',
      overdraftLimit: '220.0000',
      overdraftUsed: '200.0000',
      inOverdraft: 2,
    });
    expect(res.body.rows).toEqual([
      {
        clientId: world.other.id,
        name: 'Erbil Mobile Parts',
        balance: '100.0000',
        reserved: '0.0000',
        overdraftLimit: '0.0000',
        overdraftUsed: '0.0000',
      },
      {
        clientId: merchant.id,
        name: 'Cairo GSM Lab',
        balance: '82.7200',
        reserved: '17.2800',
        overdraftLimit: '0.0000',
        overdraftUsed: '0.0000',
      },
      {
        clientId: lowered.id,
        name: 'Lowered Co',
        balance: '-50.0000',
        reserved: '0.0000',
        overdraftLimit: '20.0000',
        overdraftUsed: '50.0000',
      },
      {
        clientId: credit.id,
        name: 'Credit Co',
        balance: '-150.0000',
        reserved: '0.0000',
        overdraftLimit: '200.0000',
        overdraftUsed: '150.0000',
      },
    ]);
  });

  it('lists the 50 largest wallets and keeps the totals over every merchant', async () => {
    const { db } = world;
    for (let index = 0; index < 52; index += 1) await insertWalletMerchant(db, { name: `Wallet ${index}` });
    const res = await staff.get('/admin/reports/wallet-exposure');
    expect(res.body.totals.clients).toBe(54);
    expect(res.body.totals.balance).toBe('200.0000');
    expect(res.body.rows).toHaveLength(50);
    expect(res.body.rows[0].balance).toBe('100.0000');
  });

  it('answers zeros when no merchant has a wallet, and is refused without reports:read', async () => {
    await resetDb();
    await clearIdentityCaches(t);
    staff = await adminWith(t, ['reports:read']);
    const res = await staff.get('/admin/reports/wallet-exposure');
    expect(res.body).toEqual({
      currency: 'USD',
      totals: {
        clients: 0,
        balance: '0.0000',
        reserved: '0.0000',
        overdraftLimit: '0.0000',
        overdraftUsed: '0.0000',
        inOverdraft: 0,
      },
      rows: [],
    });
    const other = await adminWith(t, ['orders:read']);
    expect((await other.get('/admin/reports/wallet-exposure')).status).toBe(403);
  });
});

describe('GET /admin/reports/suppliers', () => {
  async function seedCalls() {
    const { db, auto } = world;
    const call = (supplierId: number, outcome: 'ok' | 'error' | 'timeout', createdAt: string) => ({
      supplierId,
      action: 'placeimeiorder',
      outcome,
      createdAt: at(createdAt),
    });
    await db
      .insert(s.supplierApiLogs)
      .values([
        call(auto.supplierId, 'ok', '2026-11-06T09:00:00.000Z'),
        call(auto.supplierId, 'ok', '2026-11-06T10:00:00.000Z'),
        call(auto.supplierId, 'ok', '2026-11-07T08:00:00.000Z'),
        call(auto.supplierId, 'error', '2026-11-06T22:00:00.000Z'),
        call(auto.supplierId, 'timeout', '2026-11-06T22:10:00.000Z'),
        call(auto.supplierId, 'error', '2026-09-01T10:00:00.000Z'),
      ]);
  }

  it('answers one row per supplier, idle ones included: orders, completed, rejected, spend, rejection rate, speed and call figures', async () => {
    await seedOrders();
    await seedCalls();
    const res = await staff.get('/admin/reports/suppliers?days=7');
    expect(res.status).toBe(200);
    expect(res.total).toBeNaN();
    expect(res.body).toHaveLength(3);
    const byName = Object.fromEntries(res.body.map((row: { supplierName: string }) => [row.supplierName, row]));
    expect(byName['Nordic GSM']).toEqual({
      supplierId: world.auto.supplierId,
      supplierName: 'Nordic GSM',
      orders: 3,
      completed: 2,
      rejected: 1,
      spend: '28.5000',
      rejectionRate: expect.closeTo(33.3333, 3),
      averageSeconds: 2700,
      calls: 5,
      errorCalls: 1,
      timeoutCalls: 1,
    });
    expect(byName['Gulf Server Hub']).toMatchObject({
      orders: 2,
      completed: 2,
      rejected: 0,
      spend: '10.2000',
      rejectionRate: 0,
      averageSeconds: 1530,
      calls: 0,
    });
    expect(byName['Idle Supplier']).toEqual({
      supplierId: idle,
      supplierName: 'Idle Supplier',
      orders: 0,
      completed: 0,
      rejected: 0,
      spend: '0.0000',
      rejectionRate: null,
      averageSeconds: null,
      calls: 0,
      errorCalls: 0,
      timeoutCalls: 0,
    });
  });

  it('defaults to 7 days and counts further back with a larger window (the October order and call)', async () => {
    await seedOrders();
    await seedCalls();
    const weekly = (await staff.get('/admin/reports/suppliers')).body.find(
      (row: { supplierName: string }) => row.supplierName === 'Nordic GSM',
    );
    expect(weekly.orders).toBe(3);
    const wide = (await staff.get('/admin/reports/suppliers?days=60')).body.find(
      (row: { supplierName: string }) => row.supplierName === 'Nordic GSM',
    );
    expect(wide).toMatchObject({ orders: 4, completed: 3, spend: '42.0000', calls: 5 });
    const widest = (await staff.get('/admin/reports/suppliers?days=100')).body.find(
      (row: { supplierName: string }) => row.supplierName === 'Nordic GSM',
    );
    expect(widest.calls).toBe(6);
  });

  it('takes the window from the clock: a day later the first day is out', async () => {
    await seedOrders();
    clock.set('2026-11-14T12:00:00.000Z');
    staff = await adminWith(t, ['reports:read']);
    const row = (await staff.get('/admin/reports/suppliers?days=7')).body.find(
      (item: { supplierName: string }) => item.supplierName === 'Nordic GSM',
    );
    expect(row.orders).toBe(0);
  });

  it('answers 422 for days that are not a positive whole number up to 365, and is refused without reports:read', async () => {
    for (const days of ['0', '-1', 'x', '1.5', '366']) {
      const res = await staff.get(`/admin/reports/suppliers?days=${days}`);
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('days');
    }
    const other = await adminWith(t, ['orders:read']);
    expect((await other.get('/admin/reports/suppliers')).status).toBe(403);
  });
});

describe('GET /admin/reports/top-clients', () => {
  it('ranks merchants by what they spent in the window, with orders, profit and the wallet balance', async () => {
    const { merchant, other } = world;
    await seedOrders();
    const res = await staff.get('/admin/reports/top-clients?days=7&limit=6');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      // orders 1, 2, 5 and 8 in the window; spend leaves the rejected one out; profit is the completed orders'.
      {
        id: merchant.id,
        name: 'Cairo GSM Lab',
        country: '',
        orders: 4,
        spend: '54.5600',
        profit: '8.7800',
        walletBalance: '100.0000',
      },
      {
        id: other.id,
        name: 'Erbil Mobile Parts',
        country: '',
        orders: 2,
        spend: '15.0000',
        profit: '12.0000',
        walletBalance: '100.0000',
      },
    ]);
  });

  it('uses the last days x 24 hours from the clock and honours the limit', async () => {
    const { merchant } = world;
    await seedOrders();
    const day = await staff.get('/admin/reports/top-clients?days=1&limit=6');
    // The window opens at 2026-11-06 12:00 UTC: orders 2, 5 and 8 of the merchant and order 3 of the other merchant.
    expect(day.body).toMatchObject([
      { id: merchant.id, orders: 3, spend: '37.2800', profit: '5.0000' },
      { id: world.other.id, orders: 1, spend: '5.0000', profit: '2.0000' },
    ]);
    const one = await staff.get('/admin/reports/top-clients?days=14&limit=1');
    expect(one.body).toHaveLength(1);
    const fortnight = await staff.get('/admin/reports/top-clients?days=14');
    expect(fortnight.body[0]).toMatchObject({ id: merchant.id, orders: 4 });
  });

  it('leaves out merchants waiting for approval, merchants without an order in the window and storefront orders', async () => {
    const { db, auto } = world;
    await seedOrders();
    const waiting = await insertWalletMerchant(db, { name: 'Waiting Co' });
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, waiting.id));
    await insertOrderRow(db, {
      clientId: waiting.id,
      serviceId: auto.serviceId,
      unitPrice: '99.0000',
      totalPrice: '99.0000',
      createdAt: at('2026-11-07T09:00:00.000Z'),
    });
    await insertWalletMerchant(db, { name: 'Quiet Co' });
    const res = await staff.get('/admin/reports/top-clients');
    expect(res.body.map((row: { name: string }) => row.name)).toEqual(['Cairo GSM Lab', 'Erbil Mobile Parts']);
  });

  it('shows a negative wallet balance as it is', async () => {
    const { db, merchant } = world;
    await seedOrders();
    await db.update(s.ledgerAccounts).set({ balance: '-12.5000' }).where(eq(s.ledgerAccounts.ownerId, merchant.id));
    const res = await staff.get('/admin/reports/top-clients?limit=1');
    expect(res.body[0].walletBalance).toBe('-12.5000');
  });

  it('answers 422 for days outside 1, 7 and 14 and for a limit that is not 1 to 50, and is refused without reports:read', async () => {
    for (const query of ['days=3', 'days=30', 'days=abc', 'limit=0', 'limit=51', 'limit=x']) {
      const res = await staff.get(`/admin/reports/top-clients?${query}`);
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe(query.split('=')[0]);
    }
    const other = await adminWith(t, ['orders:read']);
    expect((await other.get('/admin/reports/top-clients')).status).toBe(403);
  });
});

describe('the reports that read more than once', () => {
  it('run their queries in one read-only repeatable-read transaction, so the figures describe one moment', async () => {
    await seedOrders();
    const dbService = t.app.get(DbService, { strict: false });
    const spy = spyOn(dbService, 'runInTransaction');
    try {
      for (const url of ['/admin/reports/wallet-exposure', '/admin/reports/suppliers', '/admin/reports/top-clients']) {
        spy.mockClear();
        expect((await staff.get(url)).status).toBe(200);
        // One transaction for the whole report, asked for as a read-only snapshot (sessions and audit use their own calls).
        const reads = spy.mock.calls.filter(([, options]) => options?.isolation === 'repeatable read');
        expect(reads).toHaveLength(1);
        expect(reads[0]![1]).toEqual({ isolation: 'repeatable read', readOnly: true });
      }
    } finally {
      spy.mockRestore();
    }
  });
});
