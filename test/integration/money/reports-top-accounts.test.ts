// The reports that name accounts (decision 064): the one Top accounts list of every rank (`GET /admin/reports/top-clients`,
// guests in, anonymized out, `rank`, `hasAccount`, `scope` by the door of the order, the balance of the live wallet), the wallet exposure with the store
// balances beside the merchant totals, and the profit split by merchant, which follows the door too. Dates are UTC days; every window ends at the clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { accountRow, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { fundCustomer, pushNegative } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertWalletMerchant } from '../../support/money';
import { type OrderRowValues, type OrdersWorld, insertOrderRow, ordersWorld } from '../../support/orders';

setDefaultTimeout(60_000);

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['reports:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const at = (iso: string) => new Date(iso);

/** The accounts the top list ranks: a merchant, a retail account with a login, a guest, a blocked account and an anonymized one. */
async function seedAccounts() {
  const { db } = world;
  const ada = await makeAccount({ rank: 'retail', name: 'Ada Shopper', country: 'JO' });
  await fundCustomer(db, ada.id, '25.0000');
  const guest = await makeAccount({ rank: 'retail', guest: true, name: 'Guest Gary', country: '' });
  const blocked = await makeAccount({ rank: 'retail', name: 'Blocked Bob', country: 'EG', status: 'blocked' });
  const erased = await makeAccount({
    rank: 'retail',
    guest: true,
    name: 'Deleted account',
    status: 'anonymized',
    anonymizedAt: at('2026-11-05T10:00:00.000Z'),
  });
  return { ada, guest, blocked, erased };
}

/**
 * The orders of the window (it opens at 2026-10-31 12:00 UTC for `days=7`):
 * m1, m2 merchant, portal door, completed 17.28 / 13.50 and 20.00 / 15.00; m3 the same merchant, rejected 17.28
 * a1 Ada, shop door, completed 12.49 / 7.20; a2 Ada, shop door, pending 4.00; a3 Ada, portal door, completed 3.00 / 1.00 (she was a merchant then)
 * g1 the guest, shop door, completed 8.00 / 5.00; b1 the blocked account, shop door, completed 1.00 / 0
 * x1 the anonymized account, shop door, completed 50.00 / 10.00 (left out); old1 the merchant, completed in October (outside)
 */
async function seedOrders() {
  const { db, merchant, auto } = world;
  const accounts = await seedAccounts();
  const row = (values: Omit<OrderRowValues, 'serviceId'>) =>
    insertOrderRow(db, { type: 'imei', currency: 'USD', serviceId: auto.serviceId, ...values });
  const done = (price: string, cost: string, hours: number) => ({
    status: 'completed' as const,
    dispatchState: 'done' as const,
    unitPrice: price,
    totalPrice: price,
    unitCost: cost,
    totalCost: cost,
    createdAt: at(`2026-11-06T${String(hours).padStart(2, '0')}:00:00.000Z`),
    completedAt: at(`2026-11-06T${String(hours + 1).padStart(2, '0')}:00:00.000Z`),
  });
  await row({ accountId: merchant.id, ...done('17.2800', '13.5000', 8) });
  await row({ accountId: merchant.id, ...done('20.0000', '15.0000', 9) });
  await row({
    accountId: merchant.id,
    status: 'rejected',
    dispatchState: 'done',
    unitPrice: '17.2800',
    totalPrice: '17.2800',
    createdAt: at('2026-11-06T12:30:00.000Z'),
  });
  await row({ accountId: accounts.ada.id, source: 'store', ...done('12.4900', '7.2000', 10) });
  await row({
    accountId: accounts.ada.id,
    source: 'store',
    status: 'pending',
    dispatchState: 'pending',
    unitPrice: '4.0000',
    totalPrice: '4.0000',
    createdAt: at('2026-11-07T08:00:00.000Z'),
  });
  await row({ accountId: accounts.ada.id, source: 'portal', ...done('3.0000', '1.0000', 11) });
  await row({ accountId: accounts.guest.id, source: 'store', ...done('8.0000', '5.0000', 12) });
  await row({ accountId: accounts.blocked.id, source: 'store', ...done('1.0000', '0.0000', 13) });
  await row({ accountId: accounts.erased.id, source: 'store', ...done('50.0000', '10.0000', 14) });
  await row({
    accountId: merchant.id,
    ...done('17.2800', '13.5000', 8),
    createdAt: at('2026-10-01T08:00:00.000Z'),
    completedAt: at('2026-10-01T09:00:00.000Z'),
  });
  return accounts;
}

describe('GET /admin/reports/top-clients: the Top accounts list', () => {
  it('ranks every rank in one list, guests included, with the rank, hasAccount and the balance of the live wallet', async () => {
    const { merchant } = world;
    const { ada, guest, blocked } = await seedOrders();
    const merchantRank = (await accountRow(merchant.id)).groupId;
    const retailRank = await ensureRetailGroup(world.db);
    const res = await staff.get('/admin/reports/top-clients?days=7&limit=6');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: merchant.id,
        name: 'Cairo GSM Lab',
        country: '',
        rank: { id: merchantRank, name: expect.any(String), kind: 'merchant' },
        hasAccount: true,
        // m1, m2 and m3; the rejected one is not spend; profit is the completed orders'.
        orders: 3,
        spend: '37.2800',
        profit: '8.7800',
        walletBalance: '100.0000',
      },
      {
        id: ada.id,
        name: 'Ada Shopper',
        country: 'JO',
        rank: { id: retailRank, name: 'Storefront retail', kind: 'retail' },
        hasAccount: true,
        // a1, a2 and a3: the shop's orders and the old portal order of the same account are one account's.
        orders: 3,
        spend: '19.4900',
        profit: '7.2900',
        walletBalance: '25.0000',
      },
      {
        id: guest.id,
        name: 'Guest Gary',
        country: '',
        rank: { id: retailRank, name: 'Storefront retail', kind: 'retail' },
        hasAccount: false,
        orders: 1,
        spend: '8.0000',
        profit: '3.0000',
        // A guest has no wallet.
        walletBalance: '0.0000',
      },
      {
        id: blocked.id,
        name: 'Blocked Bob',
        country: 'EG',
        rank: { id: retailRank, name: 'Storefront retail', kind: 'retail' },
        hasAccount: true,
        orders: 1,
        spend: '1.0000',
        profit: '1.0000',
        walletBalance: '0.0000',
      },
    ]);
    // The anonymized account and the merchant that did not order in the window are not in it.
    expect(res.body.map((row: { name: string }) => row.name)).not.toContain('Deleted account');
    expect(res.body.map((row: { id: number }) => row.id)).not.toContain(world.other.id);
  });

  it('counts the door of each order, whatever rank the account holds now (scope b2b, b2c and all)', async () => {
    const { merchant } = world;
    const { ada, guest, blocked } = await seedOrders();
    const rows = async (scope: string) =>
      (await staff.get(`/admin/reports/top-clients?days=7&scope=${scope}`)).body.map(
        (row: { id: number; orders: number; spend: string; profit: string }) => [
          row.id,
          row.orders,
          row.spend,
          row.profit,
        ],
      );
    // The merchant doors: the merchant, and Ada only for her old hold-and-settle order.
    expect(await rows('b2b')).toEqual([
      [merchant.id, 3, '37.2800', '8.7800'],
      [ada.id, 1, '3.0000', '2.0000'],
    ]);
    // The shop's door: Ada's two shop orders, the guest and the blocked account; the merchant has none.
    expect(await rows('b2c')).toEqual([
      [ada.id, 2, '16.4900', '5.2900'],
      [guest.id, 1, '8.0000', '3.0000'],
      [blocked.id, 1, '1.0000', '1.0000'],
    ]);
    expect((await rows('all')).map((row: number[]) => row[0])).toEqual([merchant.id, ada.id, guest.id, blocked.id]);
    // No scope is every door.
    expect((await staff.get('/admin/reports/top-clients?days=7')).body).toHaveLength(4);
  });

  it('shows the balance of the live wallet: a retail rank its store balance, a merchant rank its wallet, negative as it is', async () => {
    const { db, merchant } = world;
    const { ada } = await seedOrders();
    await pushNegative(db, ada.id, '40.0000');
    await db
      .update(s.ledgerAccounts)
      .set({ balance: '-12.5000' })
      .where(
        and(
          eq(s.ledgerAccounts.kind, 'client_wallet'),
          eq(s.ledgerAccounts.ownerType, 'account'),
          eq(s.ledgerAccounts.ownerId, merchant.id),
        ),
      );
    const res = await staff.get('/admin/reports/top-clients?days=7');
    const balance = Object.fromEntries(
      res.body.map((row: { id: number; walletBalance: string }) => [row.id, row.walletBalance]),
    );
    expect(balance[merchant.id]).toBe('-12.5000');
    expect(balance[ada.id]).toBe('-15.0000');
  });

  it('uses the last days x 24 hours from the clock, honours the limit and answers 422 for a scope that is not all, b2b or b2c', async () => {
    const { merchant } = world;
    await seedOrders();
    // days=1 opens at 2026-11-06 12:00 UTC: the merchant is in through its rejected order of 12:30 (an order counts, it is not spend).
    const day = await staff.get('/admin/reports/top-clients?days=1&limit=6');
    expect(day.body.map((row: { id: number }) => row.id)).toContain(merchant.id);
    expect((await staff.get('/admin/reports/top-clients?days=14&limit=1')).body).toHaveLength(1);
    const bad = await staff.get('/admin/reports/top-clients?scope=x');
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('scope');
    const other = await adminWith(t, ['orders:read']);
    expect((await other.get('/admin/reports/top-clients')).status).toBe(403);
  });
});

describe('GET /admin/reports/wallet-exposure: the store balances beside the merchant totals', () => {
  it('keeps the merchant totals and rows to merchant-rank wallets and adds the store balances as a sibling of totals', async () => {
    const { db } = world;
    const ada = await makeAccount({ rank: 'retail', name: 'Ada Shopper' });
    await fundCustomer(db, ada.id, '25.0000');
    const dan = await makeAccount({ rank: 'retail', name: 'Dan Shopper' });
    await fundCustomer(db, dan.id, '10.0000');
    // A chargeback took Dan below zero and froze the balance.
    await pushNegative(db, dan.id, '25.0000');
    // A merchant moved to the retail rank with an empty wallet: its (inactive) merchant wallet is in neither figure.
    const moved = await insertWalletMerchant(db, { name: 'Moved Co' });
    await db
      .update(s.clients)
      .set({ groupId: await ensureRetailGroup(db) })
      .where(eq(s.clients.id, moved.id));
    // A store balance on an account of a merchant rank is the inactive kind and is not counted either.
    await fundCustomer(db, world.other.id, '7.0000');

    const res = await staff.get('/admin/reports/wallet-exposure');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      clients: 2,
      balance: '200.0000',
      reserved: '0.0000',
      overdraftLimit: '0.0000',
      overdraftUsed: '0.0000',
      inOverdraft: 0,
    });
    expect(res.body.storeBalances).toEqual({ accounts: 2, balance: '10.0000', negative: 1, frozen: 1 });
    expect(res.body.rows.map((row: { clientId: number }) => row.clientId).sort()).toEqual(
      [world.merchant.id, world.other.id].sort(),
    );
    // The store balances are not inside `totals`.
    expect(res.body.totals).not.toHaveProperty('storeBalances');
  });

  it('answers zero store balances when there are none', async () => {
    const res = await staff.get('/admin/reports/wallet-exposure');
    expect(res.body.storeBalances).toEqual({ accounts: 0, balance: '0.0000', negative: 0, frozen: 0 });
  });
});

describe('GET /admin/reports/profit by merchant follows the door of the order', () => {
  it('names the account of every merchant-door order, even one that holds a retail rank now, and groups the shop door as key 0', async () => {
    const { merchant } = world;
    const { ada } = await seedAccounts();
    const { db, auto } = world;
    const done = (accountId: number, price: string, cost: string, source: 'portal' | 'store') =>
      insertOrderRow(db, {
        serviceId: auto.serviceId,
        accountId,
        source,
        status: 'completed',
        dispatchState: 'done',
        unitPrice: price,
        totalPrice: price,
        unitCost: cost,
        totalCost: cost,
        createdAt: at('2026-11-06T08:00:00.000Z'),
        completedAt: at('2026-11-06T09:00:00.000Z'),
      });
    await done(merchant.id, '17.2800', '13.5000', 'portal');
    await done(ada.id, '12.4900', '7.2000', 'store');
    await done(ada.id, '3.0000', '1.0000', 'portal');
    const res = await staff.get('/admin/reports/profit?groupBy=client&from=2026-11-06&to=2026-11-06');
    expect(
      res.body.rows.map((row: { key: string; label: string; profit: string }) => [row.key, row.label, row.profit]),
    ).toEqual([
      ['0', 'Storefront customers', '5.2900'],
      [String(merchant.id), 'Cairo GSM Lab', '3.7800'],
      [String(ada.id), 'Ada Shopper', '2.0000'],
    ]);
  });
});
