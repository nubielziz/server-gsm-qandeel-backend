// Integration tests of the store balance of an account (feature 21, plan § 7.1 routes 1, 2 and 11 to 16; decision 064): the retail account's
// zeros, figures and limits, the date window of the statement, the masked staff reason, another account's lines never visible, the switch off,
// no-store, no session; a merchant rank refused with 403 RANK_NOT_ALLOWED on both store routes; the staff list of live store wallets over
// accounts (a merchant rank's leftover wallet is not listed, `customer.id` is the account id, the address is masked, decision 047); and the
// five retired `/admin/customers/:id/wallet*` addresses answering 410 ROUTE_RETIRED with nothing written.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { type Database, schema as s } from '@src/infra/db';
import { customerAdjust, postTransaction } from '@src/modules/money';
import { openAccountSession } from '../../support/account-sessions';
import { makeAccount } from '../../support/accounts';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { insertInvoiceRow } from '../../support/billing';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import {
  customerWalletRow,
  fundCustomer,
  insertWalletTemplates,
  pushNegative,
  walletSettings,
} from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CONSOLE_ORIGINS: CONSOLE_ORIGIN, SHOP_ORIGINS: STORE_ORIGIN } });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  await insertUsd(db);
  await walletSettings(t, db);
  await insertWalletTemplates(db);
  staff = await adminWith(t, ['wallet:read', 'wallet:adjust']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function signedIn(name = 'Daniel Rivera') {
  const customer = await makeCustomer(t, { name });
  const store = new StoreClient(t);
  expect((await store.login(customer.email)).statusCode).toBe(200);
  return { customer, store };
}

/** Puts the store wallet of an account on hold the way a staff freeze or a top-up dispute leaves it (directly in the database, so this file does not depend on the unified wallet routes). */
async function holdWallet(db: Database, accountId: number, reason: string): Promise<void> {
  await db
    .update(s.ledgerAccounts)
    .set({ frozenAt: clock.now(), frozenReason: reason })
    .where(
      and(
        eq(s.ledgerAccounts.kind, 'customer_wallet'),
        eq(s.ledgerAccounts.ownerType, 'account'),
        eq(s.ledgerAccounts.ownerId, accountId),
      ),
    );
}

/** A manual debit with a staff reason in its memo, as the adjustment of the unified wallet routes posts it. */
async function manualDebit(
  db: Database,
  accountId: number,
  amount: string,
  reason: string,
  key: string,
): Promise<void> {
  await db.transaction((tx) =>
    postTransaction(
      tx,
      {
        ...customerAdjust({ customerId: accountId, amount: Money.of(amount), direction: 'debit' }),
        refId: accountId,
        idempotencyKey: key,
        currency: 'USD',
        memo: `Manual debit: ${reason}`,
        createdBy: { type: 'system', id: null },
      },
      clock.now(),
    ),
  );
}

describe('GET /store/v1/me/wallet', () => {
  it('answers zeros and the default limits before any money, never cached', async () => {
    const { store } = await signedIn();
    const res = await store.call('GET', '/store/v1/me/wallet');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      enabled: true,
      cardTopUps: false,
      currency: 'USD',
      balance: '0.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '0.0000',
      frozen: null,
      pendingTopUps: { count: 0, amount: '0.0000' },
      limits: {
        minTopUp: '5.0000',
        maxTopUp: '500.0000',
        maxBalance: '1000.0000',
        room: '1000.0000',
        topUpsLeftToday: 5,
        amountLeftToday: '1000.0000',
      },
    });
  });

  it('shows the balance, the room, and the hold without its reason', async () => {
    const { customer, store } = await signedIn();
    const { db } = await testDb();
    await fundCustomer(db, customer.id, '250');
    expect((await store.call('GET', '/store/v1/me/wallet')).json()).toMatchObject({
      balance: '250.0000',
      available: '250.0000',
      limits: { room: '750.0000' },
    });
    await holdWallet(db, customer.id, 'Internal check');
    const held = (await store.call('GET', '/store/v1/me/wallet')).json();
    expect(held).toMatchObject({
      balance: '250.0000',
      available: '0.0000',
      frozen: { at: '2026-11-10T09:00:00.000Z' },
    });
    expect(JSON.stringify(held)).not.toContain('Internal check');
  });

  it("reads the wallet owned by this account only: another account's money is never shown", async () => {
    const mine = await signedIn('Daniel Rivera');
    const other = await signedIn('Someone Else');
    const { db } = await testDb();
    await fundCustomer(db, other.customer.id, '99');
    expect((await mine.store.call('GET', '/store/v1/me/wallet')).json()).toMatchObject({ balance: '0.0000' });
    expect((await other.store.call('GET', '/store/v1/me/wallet')).json()).toMatchObject({ balance: '99.0000' });
    expect((await customerWalletRow(db, other.customer.id))!.ownerType).toBe('account');
  });

  it('shows a negative balance with nothing available', async () => {
    const { customer, store } = await signedIn();
    const { db } = await testDb();
    await pushNegative(db, customer.id, '12');
    expect((await store.call('GET', '/store/v1/me/wallet')).json()).toMatchObject({
      balance: '-12.0000',
      available: '0.0000',
    });
  });

  it('still shows the balance while the wallet is switched off', async () => {
    const { customer, store } = await signedIn();
    const { db } = await testDb();
    await fundCustomer(db, customer.id, '20');
    await walletSettings(t, db, { 'wallet.customer.enabled': false });
    expect((await store.call('GET', '/store/v1/me/wallet')).json()).toMatchObject({
      enabled: false,
      balance: '20.0000',
      available: '0.0000',
    });
  });

  it('counts only the store top-ups of the account in its figures', async () => {
    const { customer, store } = await signedIn();
    const { db } = await testDb();
    const own = { legacyClientId: null, amount: '40.0000', createdAt: clock.now(), updatedAt: clock.now() };
    await insertInvoiceRow(db, customer.id, { ...own, number: 'T-STORE-1', walletKind: 'customer_wallet' });
    // A top-up of the merchant wallet the account had before a rank change is not the store balance's business.
    await insertInvoiceRow(db, customer.id, { ...own, number: 'T-MERCHANT-1', walletKind: 'client_wallet' });
    expect((await store.call('GET', '/store/v1/me/wallet')).json()).toMatchObject({
      pendingTopUps: { count: 1, amount: '40.0000' },
      limits: { topUpsLeftToday: 4 },
    });
  });

  it('answers 401 without a session', async () => {
    const store = new StoreClient(t);
    expect((await store.call('GET', '/store/v1/me/wallet')).statusCode).toBe(401);
    expect((await store.call('GET', '/store/v1/me/wallet/statement')).statusCode).toBe(401);
  });

  it('refuses a merchant rank with 403 RANK_NOT_ALLOWED on both routes and leaves the session alone', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const session = await openAccountSession(t, merchant.id);
    for (const url of ['/store/v1/me/wallet', '/store/v1/me/wallet/statement']) {
      const res = await t.app.inject({ method: 'GET', url, headers: session.headers });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code, url).toBe('RANK_NOT_ALLOWED');
    }
    // A refusal of the rank gate never signs the account out: its session stays live.
    const { db } = await testDb();
    const sessions = await db.select().from(s.sessions).where(eq(s.sessions.subjectId, merchant.id));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((row) => row.revokedAt === null)).toBe(true);
  });
});

describe('GET /store/v1/me/wallet/statement', () => {
  it('lists the account’s own lines newest first, hides the staff reason and filters by date', async () => {
    const { customer, store } = await signedIn();
    const other = await signedIn('Someone Else');
    const { db } = await testDb();
    await fundCustomer(db, customer.id, '30', clock.now());
    await fundCustomer(db, other.customer.id, '99', clock.now());
    clock.advance(10 * 60_000);
    await manualDebit(db, customer.id, '5', 'Staff-only reason', 'a1');
    const res = await store.call('GET', '/store/v1/me/wallet/statement');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-total-count']).toBe('2');
    const rows = res.json();
    expect(rows[0]).toMatchObject({
      kind: 'adjustment',
      memo: 'Balance adjustment',
      amount: '-5.0000',
      balanceAfter: '25.0000',
      orderId: null,
    });
    expect(rows[1]).toMatchObject({ kind: 'deposit', amount: '30.0000', balanceAfter: '30.0000' });
    expect(res.body).not.toContain('Staff-only reason');
    expect(res.body).not.toContain('99.0000');
    const window = await store.call('GET', '/store/v1/me/wallet/statement?createdAt_lte=2026-11-10T09:05:00.000Z');
    expect(window.json()).toHaveLength(1);
    expect((await store.call('GET', '/store/v1/me/wallet/statement?_sort=createdAt&_order=asc')).json()[0].kind).toBe(
      'deposit',
    );
    expect((await store.call('GET', '/store/v1/me/wallet/statement?amount=1')).statusCode).toBe(422);
  });

  it('answers an empty page for an account that never had a wallet', async () => {
    const { store } = await signedIn();
    const res = await store.call('GET', '/store/v1/me/wallet/statement');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(res.headers['x-total-count']).toBe('0');
  });
});

describe('GET /admin/customer-wallets over accounts', () => {
  /** A retail account with a name and an address of its own. */
  const retail = (name: string, email: string) => makeCustomer(t, { name, email });

  it('lists the live store wallets with state filters, sorts, search and the account id as customer.id', async () => {
    const { db } = await testDb();
    const rich = await retail('Alice Rich', 'alice@mail.example');
    const zero = await retail('Zed Zero', 'zed@mail.example');
    const owing = await retail('Olive Owing', 'olive@mail.example');
    await fundCustomer(db, rich.id, '80');
    await fundCustomer(db, zero.id, '5');
    await manualDebit(db, zero.id, '5', 'Back to zero', 'zero-1');
    await pushNegative(db, owing.id, '12');

    const all = await staff.get('/admin/customer-wallets?_sort=balance&_order=desc');
    expect(all.status).toBe(200);
    expect(all.total).toBe(3);
    expect(all.body.map((row: { customer: { id: number } }) => row.customer.id)).toEqual([rich.id, zero.id, owing.id]);
    expect(all.body[0]).toMatchObject({
      // Decision 047: this caller does not hold clients:read, so the address comes masked.
      customer: { name: 'Alice Rich', email: 'al•••@mail.example', status: 'active' },
      balance: '80.0000',
      frozen: null,
    });
    const negative = await staff.get('/admin/customer-wallets?state=negative');
    expect(negative.body).toHaveLength(1);
    expect(negative.body[0].frozen).toMatchObject({ reason: 'Chargeback' });
    expect((await staff.get('/admin/customer-wallets?state=frozen')).total).toBe(1);
    expect((await staff.get('/admin/customer-wallets?state=zero&state=positive')).total).toBe(2);
    expect((await staff.get('/admin/customer-wallets?state=rich')).status).toBe(422);
  });

  it('leaves out the wallet of an account whose rank is a merchant rank, listing it again with the retail rank', async () => {
    const { db } = await testDb();
    const shopper = await retail('Alice Rich', 'alice@mail.example');
    const merchant = await makeAccount(t, { rank: 'merchant', name: 'Zed Trading', email: 'zed@mail.example' });
    await fundCustomer(db, shopper.id, '40');
    // The zero wallet a merchant keeps from the days of its retail rank (it holds zero and is not frozen).
    await db
      .insert(s.ledgerAccounts)
      .values({ kind: 'customer_wallet', ownerType: 'account', ownerId: merchant.id, currency: 'USD', balance: '0' });

    const listed = await staff.get('/admin/customer-wallets');
    expect(listed.body.map((row: { customer: { id: number } }) => row.customer.id)).toEqual([shopper.id]);
    expect(listed.total).toBe(1);
    expect((await staff.get('/admin/customer-wallets?q=Zed')).total).toBe(0);

    // The merchant moves to the retail rank: its wallet is the live one now.
    const retailGroup = (await retail('Anyone', 'anyone@mail.example')).row.groupId;
    await db.update(s.clients).set({ groupId: retailGroup }).where(eq(s.clients.id, merchant.id));
    const again = await staff.get('/admin/customer-wallets?q=Zed');
    expect(again.body.map((row: { customer: { id: number } }) => row.customer.id)).toEqual([merchant.id]);
  });

  it('masks the address and searches names only without clients:read (decision 047)', async () => {
    const { db } = await testDb();
    const zero = await retail('Zed Zero', 'zed@mail.example');
    await fundCustomer(db, zero.id, '5');
    const withRead = await adminWith(t, ['wallet:read', 'clients:read']);
    const emailsOf = async (api: AdminApi, query = '') =>
      (await api.get(`/admin/customer-wallets${query}`)).body.map(
        (row: { customer: { email: string } }) => row.customer.email,
      );
    expect(await emailsOf(staff)).toEqual(['ze•••@mail.example']);
    expect(await emailsOf(withRead)).toEqual(['zed@mail.example']);
    expect(await emailsOf(staff, '?q=zed%40mail')).toEqual([]);
    expect(await emailsOf(staff, '?q=Zed+Z')).toEqual(['ze•••@mail.example']);
    expect(await emailsOf(withRead, '?q=zed%40mail')).toEqual(['zed@mail.example']);
    expect(await emailsOf(withRead, '?q=nobody')).toEqual([]);
  });

  it('needs wallet:read', async () => {
    const reader = await adminWith(t, ['dashboard:read']);
    expect((await reader.get('/admin/customer-wallets')).status).toBe(403);
    expect((await staff.anonymous('GET', '/admin/customer-wallets')).status).toBe(401);
  });
});

describe('the five retired staff wallet routes of /admin/customers/:id', () => {
  const key = { 'idempotency-key': 'retired-1' };
  const routes = (id: number) =>
    [
      {
        name: 'GET wallet',
        replacement: 'GET /admin/clients/:id/wallet',
        call: () => staff.get(`/admin/customers/${id}/wallet`),
      },
      {
        name: 'GET statement',
        replacement: 'GET /admin/clients/:id/statement',
        call: () => staff.get(`/admin/customers/${id}/wallet/statement`),
      },
      {
        name: 'POST adjust',
        replacement: 'POST /admin/clients/:id/wallet/adjust',
        call: () =>
          staff.post(
            `/admin/customers/${id}/wallet/adjust`,
            { amount: '5.0000', direction: 'credit', reason: 'Goodwill credit' },
            key,
          ),
      },
      {
        name: 'POST freeze',
        replacement: 'POST /admin/clients/:id/wallet/freeze',
        call: () => staff.post(`/admin/customers/${id}/wallet/freeze`, { reason: 'Checking a dispute' }, key),
      },
      {
        name: 'POST unfreeze',
        replacement: 'POST /admin/clients/:id/wallet/unfreeze',
        call: () => staff.post(`/admin/customers/${id}/wallet/unfreeze`, { reason: 'The dispute was won' }, key),
      },
    ] as const;

  it('answer 410 ROUTE_RETIRED naming the account route, and write nothing', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const { db } = await testDb();
    await fundCustomer(db, customer.id, '50');
    const counts = async () => ({
      journals: (await db.select({ n: count() }).from(s.ledgerTransactions))[0]!.n,
      audits: (await db.select({ n: count() }).from(s.auditLogs))[0]!.n,
      notifications: (await db.select({ n: count() }).from(s.notifications))[0]!.n,
    });
    const before = await counts();
    const wallet = await customerWalletRow(db, customer.id);
    for (const route of routes(customer.id)) {
      const res = await route.call();
      expect(res.status, route.name).toBe(410);
      expect(res.body.code, route.name).toBe('ROUTE_RETIRED');
      expect(res.body.detail, route.name).toContain(route.replacement);
    }
    expect(await counts()).toEqual(before);
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: wallet!.balance, frozenAt: null });
  });

  it('still check the permission first: 403 without wallet:read or wallet:adjust, 401 without a session', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const reader = await adminWith(t, ['wallet:read']);
    const nobody = await adminWith(t, ['dashboard:read']);
    expect((await nobody.get(`/admin/customers/${customer.id}/wallet`)).status).toBe(403);
    expect((await reader.get(`/admin/customers/${customer.id}/wallet`)).status).toBe(410);
    expect(
      (await reader.post(`/admin/customers/${customer.id}/wallet/freeze`, { reason: 'Checking a dispute' }, key))
        .status,
    ).toBe(403);
    expect((await staff.anonymous('GET', `/admin/customers/${customer.id}/wallet`)).status).toBe(401);
  });

  it('still validate the old contract first: a freeze without its key or a short reason is 422, not 410', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    expect(
      (await staff.post(`/admin/customers/${customer.id}/wallet/freeze`, { reason: 'Checking a dispute' })).status,
    ).toBe(422);
    expect((await staff.post(`/admin/customers/${customer.id}/wallet/freeze`, { reason: 'no' }, key)).status).toBe(422);
  });
});
