// End-to-end walk of the customer wallet story (feature 21, beyond the map's 13 scenarios, plan § 11.2: manual top-up, balance paid, refund
// to the balance) on the real application: a signed-in customer tops up by CliQ, uploads the receipt, staff approve it, the customer pays a
// checkout from the balance and gets the order at once, staff reject the order and the money returns to the balance in the same
// transaction. Each step asserts the journal kinds and that the books sum to zero. The steps share one story, so the tests run in order.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertGateway, insertProofFile } from '../support/billing';
import { TestClock } from '../support/clock';
import {
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { notificationRows, seedDefaultTemplates } from '../support/notifications';
import { orderRow } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { type StorefrontWorld, storefrontWorld } from '../support/storefront';
import { type MadeCustomer, StoreClient, clearStoreRateLimits, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
let t: TestApp;
let world: StorefrontWorld;
let staff: AdminApi;
let customer: MadeCustomer;
let store: StoreClient;
let cliq: number;
let topUpId = 0;
let paymentId = 0;
let orderId = 0;

beforeAll(async () => {
  t = await createTestApp({ clock });
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  world = await storefrontWorld(db);
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
  staff = await adminWith(t, ['payments:*', 'orders:*', 'refunds:*', 'wallet:read'], { name: 'Layla Haddad' });
  customer = await makeCustomer(t, { name: 'Daniel Rivera' });
  store = new StoreClient(t, freshClientIp());
  expect((await store.login(customer.email)).statusCode).toBe(200);
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

/** The kinds of every journal so far, oldest first. */
async function journalKinds(): Promise<string[]> {
  const { db } = await testDb();
  return (await db.select().from(s.ledgerTransactions).orderBy(s.ledgerTransactions.id)).map((row) => row.kind);
}
const wallet = async () => (await store.call('GET', '/store/v1/me/wallet')).json();

describe('the customer wallet story: top up by hand, pay from the balance, refund to the balance', () => {
  it('step 1: the customer starts a CliQ top-up of 50 and reads the transfer details', async () => {
    expect(await wallet()).toMatchObject({ enabled: true, balance: '0.0000' });
    const res = await store.call(
      'POST',
      '/store/v1/me/wallet/top-ups',
      { amount: '50', gatewayId: cliq },
      { headers: { 'idempotency-key': 'scenario-topup' } },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'awaiting_payment',
      amount: '50.0000',
      fee: '1.5000',
      netAmount: '48.5000',
    });
    topUpId = res.json().id;
  });

  it('step 2: the customer uploads the receipt; the top-up waits for staff in Deposits', async () => {
    const { db } = await testDb();
    const fileId = await insertProofFile(db, customer.id, { ownerType: 'customer' });
    const res = await store.call(
      'POST',
      `/store/v1/me/wallet/top-ups/${topUpId}/receipt`,
      { fileId, reference: 'CLIQ-7781' },
      { headers: { 'idempotency-key': 'scenario-receipt' } },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('in_review');
    const deposits = await staff.get('/admin/payments?owner=customer');
    expect(deposits.body).toHaveLength(1);
    expect(deposits.body[0]).toMatchObject({ status: 'pending', customer: { id: customer.id } });
    paymentId = deposits.body[0].id;
  });

  it('step 3: staff approve it: the balance is 48.50, the customer is told, the books balance', async () => {
    expect((await staff.post(`/admin/payments/${paymentId}/approve`)).status).toBe(200);
    expect(await wallet()).toMatchObject({ balance: '48.5000', available: '48.5000' });
    expect((await store.call('GET', `/store/v1/me/wallet/top-ups/${topUpId}`)).json().status).toBe('credited');
    const { db } = await testDb();
    expect((await notificationRows(db)).filter((row) => row.event === 'wallet.topup_credited')).toHaveLength(1);
    expect(await journalKinds()).toEqual(['deposit']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('step 4: the customer pays a checkout from the balance and gets the order at once', async () => {
    const { token, session } = await openSignedInCheckout(store, world, customer.email);
    expect(session.balancePayable).toBe(true);
    const res = await payFromBalance(store, token, 'scenario-pay');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      payment: { method: 'balance', amountUsd: '4.7900' },
      wallet: { balance: '43.7100' },
    });
    orderId = res.json().order.id;
    const { db } = await testDb();
    expect((await orderRow(db, orderId)).customerId).toBe(customer.id);
    expect(await journalKinds()).toEqual(['deposit', 'b2c_payment']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('step 5: staff reject the order: the whole payment is back on the balance at once, with no gateway job', async () => {
    expect((await staff.post(`/admin/orders/${orderId}/reject`, { reason: 'Cannot be checked' })).status).toBe(204);
    expect(await wallet()).toMatchObject({ balance: '48.5000' });
    const { db } = await testDb();
    const [refund] = await db.select().from(s.refunds).where(eq(s.refunds.orderId, orderId));
    expect(refund!.status).toBe('completed');
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'))).toHaveLength(0);
    expect(await journalKinds()).toEqual(['deposit', 'b2c_payment', 'refund']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // The customer's statement tells the story, newest first, without any staff note.
    const statement = await store.call('GET', '/store/v1/me/wallet/statement');
    expect(statement.json().map((row: { kind: string; amount: string }) => [row.kind, row.amount])).toEqual([
      ['refund', '4.7900'],
      ['b2c_payment', '-4.7900'],
      ['deposit', '48.5000'],
    ]);
  });
});
