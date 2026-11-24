// Integration tests of refunds to the store balance and the reports with balance payments (feature 21, plan § 5.6.7 and § 5.6.8): a
// rejected balance-paid order goes back to the balance in the same transaction with no gateway job, a staff refund after delivery, two
// partial refunds then the closing one never return more than was paid, the payment's status, the mails, the VAT report and the payments
// report (D1, D7).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { json } from '../../support/b2c';
import { TestClock } from '../../support/clock';
import {
  customerWalletRow,
  fundCustomer,
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { ledgerTotals } from '../../support/money';
import { notificationRows, seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, orderRow, systemBalance } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { type StorefrontWorld, storefrontWorld } from '../../support/storefront';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
let t: TestApp;
let db: Database;
let world: StorefrontWorld;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: STORE_ORIGIN } });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  world = await storefrontWorld(db);
  await walletSettings(t, db);
  await seedDefaultTemplates(db);
  await insertWalletTemplates(db);
  staff = await adminWith(t, ['refunds:*', 'orders:*', 'reports:*'], { name: 'Layla Haddad' });
});

/** An order of the iCloud check (net 3.99 + VAT 0.80 = 4.79 USD, 3.84 GBP) paid from a balance of 50, delivered when asked. */
async function balanceOrder(options: { deliver?: boolean } = {}) {
  const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
  const client = new StoreClient(t, freshClientIp());
  expect((await client.login(customer.email)).statusCode).toBe(200);
  await fundCustomer(db, customer.id, '50');
  const { token } = await openSignedInCheckout(client, world, customer.email);
  const res = await payFromBalance(client, token);
  expect(res.statusCode).toBe(201);
  const body = json(res);
  if (options.deliver) {
    expect((await staff.post(`/admin/orders/${body.order.id}/reply`, { code: 'Clean' })).status).toBe(204);
  }
  return { customerId: customer.id, orderId: body.order.id as number, paymentId: body.payment.id as number };
}

/** A customer's refund request (the request route belongs to the support feature). */
async function request(paid: { customerId: number; orderId: number; paymentId: number }, amount = '3.8400') {
  const [row] = await db
    .insert(s.refunds)
    .values({
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      accountId: paid.customerId,
      amount,
      currency: 'GBP',
      reason: 'The result was wrong',
      method: 'original',
      status: 'requested',
      requestedByType: 'account',
      requestedById: paid.customerId,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning();
  return row!;
}

/** The lines of one journal by its key: account kind and signed amount (debit above zero), sorted by kind. */
async function journal(key: string): Promise<Array<{ account: string; amount: string }>> {
  const result = await db.execute<{ account: string; amount: string }>(
    sql`select a.kind as account, e.amount::text as amount
        from ledger_entries e join ledger_accounts a on a.id = e.account_id
        join ledger_transactions x on x.id = e.transaction_id
        where x.idempotency_key = ${key} order by a.kind`,
  );
  return result.rows;
}

const paymentStatus = async (id: number) =>
  (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!.status;
const refundJobs = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'));
const mailsOf = async (event: string) => (await notificationRows(db)).filter((row) => row.event === event);

describe('refunds of a balance payment', () => {
  it('a rejected order goes back to the balance in the same transaction: completed, no gateway job, the wallet mail', async () => {
    const paid = await balanceOrder();
    expect((await customerWalletRow(db, paid.customerId))!.balance).toBe('45.2100');
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be checked' })).status).toBe(
      204,
    );

    const [refund] = await db.select().from(s.refunds);
    expect(refund).toMatchObject({ method: 'original', status: 'completed', amount: '3.8400', currency: 'GBP' });
    expect(await journal(`order:${paid.orderId}:refund`)).toEqual([
      { account: 'customer_funds', amount: '3.9900' },
      { account: 'customer_wallet', amount: '-4.7900' },
      { account: 'vat_payable', amount: '0.8000' },
    ]);
    expect((await customerWalletRow(db, paid.customerId))!.balance).toBe('50.0000');
    expect(await paymentStatus(paid.paymentId)).toBe('refunded');
    expect(await refundJobs()).toHaveLength(0);
    expect(await mailsOf('wallet.order_refunded')).toHaveLength(1);
    expect(await mailsOf('order.failed')).toHaveLength(0);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');

    const shown = await staff.get(`/admin/refunds/${refund!.id}`);
    expect(shown.body).toMatchObject({ status: 'completed', payment: { method: 'balance', brand: 'Store balance' } });
  });

  it('staff refund a delivered order to the balance at once, from revenue, with the timeline saying so', async () => {
    const paid = await balanceOrder({ deliver: true });
    const refund = await request(paid);
    const res = await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'completed',
      method: 'original',
      amount: '4.7900',
      netAmount: '3.9900',
      taxAmount: '0.8000',
      payment: { method: 'balance' },
    });
    expect(await journal(`refund:${refund.id}`)).toEqual([
      { account: 'customer_wallet', amount: '-4.7900' },
      { account: 'revenue', amount: '3.9900' },
      { account: 'vat_payable', amount: '0.8000' },
    ]);
    expect((await customerWalletRow(db, paid.customerId))!.balance).toBe('50.0000');
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await paymentStatus(paid.paymentId)).toBe('refunded');
    expect(await refundJobs()).toHaveLength(0);
    expect((await orderRow(db, paid.orderId)).status).toBe('completed');
    expect((await eventsOf(db, paid.orderId)).at(-1)!.data).toMatchObject({
      message: 'Refund of $4.79 returned to the store balance',
    });
    const mails = await mailsOf('wallet.order_refunded');
    expect(mails).toHaveLength(1);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('two partial refunds then the closing one return exactly what was paid, never more', async () => {
    const paid = await balanceOrder({ deliver: true });
    const first = await request(paid, '0.8000');
    const one = await staff.post(`/admin/refunds/${first.id}/approve`, { amount: '1.00' });
    expect(one.status).toBe(200);
    // The same conversion as a card: 1.00 USD is 0.80 GBP, which is 0.9977 USD again.
    expect(one.body).toMatchObject({ status: 'completed', amount: '0.9977', partial: true });
    expect(await paymentStatus(paid.paymentId)).toBe('partial_refund');

    const second = await request(paid, '0.8000');
    expect((await staff.post(`/admin/refunds/${second.id}/approve`, { amount: '1.00' })).status).toBe(200);
    // What went back on the wallet line counts as refunded (D7): the third may take only what is left.
    const tooMuch = await request(paid, '3.0000');
    const refused = await staff.post(`/admin/refunds/${tooMuch.id}/approve`, { amount: '3.00' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({
      field: 'amount',
      message: 'Enter an amount between $0.01 and $2.7946.',
    });

    const closing = await staff.post(`/admin/refunds/${tooMuch.id}/approve`, { amount: '2.7946' });
    expect(closing.status).toBe(200);
    expect(await paymentStatus(paid.paymentId)).toBe('refunded');
    expect((await customerWalletRow(db, paid.customerId))!.balance).toBe('50.0000');
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    const more = await request(paid, '0.0100');
    expect((await staff.post(`/admin/refunds/${more.id}/approve`, {})).status).toBe(422);
    expect(await refundJobs()).toHaveLength(0);
  });
});

describe('the reports with balance payments', () => {
  it('the VAT report counts a balance payment and its refund (D1)', async () => {
    const kept = await balanceOrder();
    const refunded = await balanceOrder({ deliver: true });
    const refund = await request(refunded);
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(200);
    expect(kept.orderId).toBeGreaterThan(0);

    const res = await staff.get('/admin/reports/vat?from=2026-11-01&to=2026-11-30');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      { country: 'GB', period: '2026-11', rate: '20.0000', orders: 2, taxable: '3.9900', vat: '0.8000' },
    ]);
    expect(await systemBalance(db, 'vat_payable')).toBe('0.8000');
  });

  it('the payments report has a fourth method, balance, with no fee; its refund is read from the wallet line (D7)', async () => {
    const paid = await balanceOrder({ deliver: true });
    const refund = await request(paid);
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(200);

    const res = await staff.get('/admin/reports/payments');
    expect(res.status).toBe(200);
    expect(res.body.methods.map((row: { method: string }) => row.method)).toEqual([
      'card',
      'wallet',
      'crypto',
      'balance',
    ]);
    expect(res.body.methods[3]).toMatchObject({
      method: 'balance',
      payments: 1,
      volume: '4.7900',
      fees: '0.0000',
      refunds: 1,
    });
    expect(res.body.payments).toEqual([
      expect.objectContaining({ id: paid.paymentId, method: 'balance', brand: 'Store balance', feeAmount: '0.0000' }),
    ]);
    expect(res.body.totals).toMatchObject({ refundedCount: 1, refundedAmount: '4.7900' });
    const filtered = await staff.get('/admin/reports/payments?method=balance');
    expect(filtered.body.total).toBe(1);
  });
});
