// End-to-end walk of the rank change of a wallet (decision 064, beyond the map's 13 scenarios) on the real application: a retail account tops
// up its store balance by hand, staff approve the receipt, the Owner raises the account to a merchant rank, the balance moves to the merchant
// wallet in one posting and every session of the account ends, the account signs in again as a merchant, places a portal order from the moved
// balance, and staff complete it so the hold settles into revenue. Each step asserts the journals and that the books sum to zero and reconcile.
// The steps share one story, so the tests run in order.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { accountRow } from '../support/accounts';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertGateway, insertProofFile } from '../support/billing';
import { MINUTE, TestClock } from '../support/clock';
import { customerWalletRow, insertWalletTemplates, walletSettings } from '../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { seedDefaultTemplates } from '../support/notifications';
import { IMEIS, ledgerOf, orderRow, ordersWorld, systemBalance, walletOf, type OrdersWorld } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { type MadeCustomer, STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const PASSWORD = 'correct-horse-battery';
let t: TestApp;
let world: OrdersWorld;
let owner: AdminApi;
let desk: AdminApi;
let account: MadeCustomer;
let browser: StoreClient;
let wholesale = 0;
let cliq = 0;
let topUpId = 0;
let paymentId = 0;
let orderId = 0;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: STORE_ORIGIN } });
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  world = await ordersWorld(db);
  await walletSettings(t, db);
  await seedDefaultTemplates(db);
  await insertWalletTemplates(db);
  cliq = await insertGateway(t, db, {
    code: 'cliq',
    driver: 'manual',
    name: 'CliQ transfer',
    audience: 'b2c',
    isManual: true,
    feeFixed: '1.5',
  });
  // The merchant rank the account is raised to: no discount, no credit.
  const [rank] = await db
    .insert(s.clientGroups)
    .values({ name: 'Wholesale', kind: 'b2b', overdraftAllowed: false })
    .returning({ id: s.clientGroups.id });
  wholesale = rank!.id;
  owner = await adminWith(t, ['*'], { name: 'Rami K.', roleName: 'Owner' });
  desk = await adminWith(t, ['payments:*', 'orders:*', 'wallet:read'], { name: 'Layla Haddad' });
  account = await makeCustomer(t, { name: 'Daniel Rivera', password: PASSWORD });
  browser = new StoreClient(t, freshClientIp());
  expect((await browser.login(account.email, PASSWORD)).statusCode).toBe(200);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** The books must sum to zero and every stored balance must equal its lines. */
async function booksClean(): Promise<void> {
  const { db } = await testDb();
  expect((await ledgerTotals(db)).sum).toBe('0.0000');
  expect(await findBalanceDifferences(db)).toEqual([]);
}
/** The balance posting the rank change made for the account, oldest first. */
async function transfers() {
  const { db } = await testDb();
  return db
    .select()
    .from(s.ledgerTransactions)
    .where(and(eq(s.ledgerTransactions.kind, 'wallet_transfer'), eq(s.ledgerTransactions.refId, account.id)))
    .orderBy(asc(s.ledgerTransactions.id));
}

describe('rank change of a wallet: a retail top-up becomes a merchant balance that pays a portal order', () => {
  it('step 1: the retail account starts a CliQ top-up of 50 and uploads the receipt; the top-up waits for staff in Deposits', async () => {
    const { db } = await testDb();
    const created = await browser.call(
      'POST',
      '/store/v1/me/wallet/top-ups',
      { amount: '50', gatewayId: cliq },
      { headers: { 'idempotency-key': 'scenario-rank-topup' } },
    );
    expect(created.statusCode).toBe(201);
    topUpId = created.json().id;
    const fileId = await insertProofFile(db, account.id);
    const receipt = await browser.call(
      'POST',
      `/store/v1/me/wallet/top-ups/${topUpId}/receipt`,
      { fileId, reference: 'CLIQ-9042' },
      { headers: { 'idempotency-key': 'scenario-rank-receipt' } },
    );
    expect(receipt.statusCode).toBe(201);
    const deposits = await desk.get('/admin/payments?owner=customer');
    expect(deposits.body).toHaveLength(1);
    expect(deposits.body[0]).toMatchObject({ status: 'pending', customer: { id: account.id } });
    paymentId = deposits.body[0].id;
  });

  it('step 2: staff approve it: the store balance is 48.50 and no merchant wallet exists yet', async () => {
    const { db } = await testDb();
    expect((await desk.post(`/admin/payments/${paymentId}/approve`)).status).toBe(200);
    expect((await browser.call('GET', '/store/v1/me/wallet')).json()).toMatchObject({ balance: '48.5000' });
    expect((await customerWalletRow(db, account.id))!.balance).toBe('48.5000');
    expect(await walletOf(db, account.id)).toEqual({ wallet: '0.0000', hold: '0.0000' });
    await booksClean();
  });

  it('step 3: only the Owner raises the account to a merchant rank: the balance moves to the merchant wallet in one posting and every session ends', async () => {
    const { db } = await testDb();
    const refused = await desk.post(
      `/admin/clients/${account.id}/rank`,
      { groupId: wholesale },
      { 'idempotency-key': 'scenario-rank-refused' },
    );
    expect(refused.status).toBe(403);
    expect((await accountRow(account.id)).groupId).toBe(account.row.groupId);
    expect(await transfers()).toHaveLength(0);

    clock.advance(5 * MINUTE);
    const raised = await owner.post(
      `/admin/clients/${account.id}/rank`,
      { groupId: wholesale },
      { 'idempotency-key': 'scenario-rank-up' },
    );
    expect(raised.status).toBe(200);
    expect(raised.body).toMatchObject({
      rank: { id: wholesale, name: 'Wholesale', kind: 'merchant' },
      movedAmount: '48.5000',
      sessionsEnded: 1,
      apiKeysRevoked: 0,
      wallet: { kind: 'merchant', balance: '48.5000' },
    });
    expect(await accountRow(account.id)).toMatchObject({ groupId: wholesale, username: expect.any(String) });
    // The merchant wallet holds the money and the store balance is empty: one posting, under the key of the change.
    expect(await walletOf(db, account.id)).toEqual({ wallet: '48.5000', hold: '0.0000' });
    expect((await customerWalletRow(db, account.id))!.balance).toBe('0.0000');
    expect((await transfers()).map((row) => row.idempotencyKey)).toEqual([`rank:${account.id}:scenario-rank-up`]);
    const [change] = await db.select().from(s.accountRankChanges).where(eq(s.accountRankChanges.accountId, account.id));
    expect(change).toMatchObject({ fromKind: 'retail', toKind: 'merchant', movedAmount: '48.5000' });
    // The session of the retail browser ended with the change.
    expect((await browser.me()).statusCode).toBe(401);
    await booksClean();
  });

  it('step 4: the account signs in again on the one form as a merchant; the shop routes of a retail account are closed to it', async () => {
    const res = await browser.call('POST', '/client/auth/sign-in', { email: account.email, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'merchant', next: 'done', rank: { id: wholesale, kind: 'merchant' } });
    expect((await browser.call('GET', '/client/auth/me')).json()).toMatchObject({
      id: account.id,
      rank: { id: wholesale, kind: 'merchant' },
    });
    for (const url of ['/store/v1/me', '/store/v1/me/wallet']) {
      const closed = await browser.call('GET', url);
      expect(closed.statusCode, url).toBe(403);
      expect(closed.json(), url).toMatchObject({ code: 'RANK_NOT_ALLOWED' });
    }
  });

  it('step 5: it places a portal order from the moved balance: the price is held and the books stay in balance', async () => {
    const { db } = await testDb();
    const res = await browser.call('POST', '/client/orders', { serviceId: world.manual.serviceId, imei: IMEIS[1] });
    expect(res.statusCode).toBe(201);
    const [placed] = res.json().orders;
    orderId = placed.id;
    expect(placed).toMatchObject({ status: 'pending', unitPrice: '5.0000', totalPrice: '5.0000', source: 'portal' });
    expect(await orderRow(db, orderId)).toMatchObject({
      accountId: account.id,
      legacyClientId: account.id,
      source: 'portal',
      dispatchState: 'manual',
    });
    expect(await walletOf(db, account.id)).toEqual({ wallet: '43.5000', hold: '5.0000' });
    expect((await ledgerOf(db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold']);
    await booksClean();
  });

  it('step 6: staff complete the order: the hold settles into revenue and the merchant wallet keeps the rest', async () => {
    const { db } = await testDb();
    expect((await desk.post(`/admin/orders/${orderId}/accept`, {})).status).toBe(204);
    expect((await desk.post(`/admin/orders/${orderId}/reply`, { code: 'Unlocked: code 1127 0044' })).status).toBe(204);
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'completed', accountId: account.id });
    expect(await walletOf(db, account.id)).toEqual({ wallet: '43.5000', hold: '0.0000' });
    expect((await ledgerOf(db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold', 'order_settle']);
    expect(await systemBalance(db, 'revenue')).toBe('5.0000');
    // Nothing came back to the store balance, and the history of the old wallet is still readable by staff.
    expect((await customerWalletRow(db, account.id))!.balance).toBe('0.0000');
    const history = await owner.get(`/admin/clients/${account.id}/statement?wallet=store`);
    expect(history.status).toBe(200);
    expect(history.body.map((row: { kind: string }) => row.kind)).toEqual(
      expect.arrayContaining(['deposit', 'wallet_transfer']),
    );
    await booksClean();
  });
});
