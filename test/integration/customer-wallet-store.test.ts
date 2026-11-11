// Integration tests of the customer's own store balance (feature 21, plan § 7.1 routes 1 and 2): zeros, figures and limits, the date window
// of the statement, the masked staff reason, another customer's lines never visible, the switch off, no-store, and no session.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { fundCustomer, insertWalletTemplates, pushNegative, walletSettings } from '../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { CONSOLE_ORIGIN } from '../support/staff-console';
import { StoreClient, clearStoreRateLimits, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CORS_ORIGINS: CONSOLE_ORIGIN } });
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
    await staff.post(
      `/admin/customers/${customer.id}/wallet/freeze`,
      { reason: 'Internal check' },
      { 'idempotency-key': 'f1' },
    );
    const held = (await store.call('GET', '/store/v1/me/wallet')).json();
    expect(held).toMatchObject({
      balance: '250.0000',
      available: '0.0000',
      frozen: { at: '2026-11-10T09:00:00.000Z' },
    });
    expect(JSON.stringify(held)).not.toContain('Internal check');
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

  it('answers 401 without a session', async () => {
    const store = new StoreClient(t);
    expect((await store.call('GET', '/store/v1/me/wallet')).statusCode).toBe(401);
    expect((await store.call('GET', '/store/v1/me/wallet/statement')).statusCode).toBe(401);
  });
});

describe('GET /store/v1/me/wallet/statement', () => {
  it('lists the customer’s own lines newest first, hides the staff reason and filters by date', async () => {
    const { customer, store } = await signedIn();
    const other = await signedIn('Someone Else');
    const { db } = await testDb();
    await fundCustomer(db, customer.id, '30', clock.now());
    await fundCustomer(db, other.customer.id, '99', clock.now());
    clock.advance(10 * 60_000);
    await staff.post(
      `/admin/customers/${customer.id}/wallet/adjust`,
      { amount: '5.0000', direction: 'debit', reason: 'Staff-only reason' },
      { 'idempotency-key': 'a1' },
    );
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
});
