// Integration tests of the staff review of a store balance top-up (feature 21, plan § 5.6.5): the Deposits wire with the customer, the
// owner and customer filters and the search; approve credits the customer's balance once (also when two approvals race), with one email
// and no merchant outbox row; reject voids the top-up, tells the customer why and names them in the audit; merchant rows are unchanged.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment, insertProofFile } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { customerWalletRow, insertWalletTemplates, walletSettings } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { insertWalletMerchant } from '../../support/money';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let staff: AdminApi;
let cliq: number;

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
  cliq = await insertGateway(t, db, {
    code: 'cliq',
    driver: 'manual',
    name: 'CliQ transfer',
    audience: 'b2c',
    isManual: true,
    feeFixed: '1.5',
  });
  staff = await adminWith(t, ['payments:read', 'payments:approve', 'wallet:read'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A customer with a manual top-up of 50 (fee 1.50) whose receipt waits for review. */
async function inReview(name = 'Daniel Rivera') {
  const customer = await makeCustomer(t, { name });
  const store = new StoreClient(t);
  expect((await store.login(customer.email)).statusCode).toBe(200);
  const created = await store.call(
    'POST',
    '/store/v1/me/wallet/top-ups',
    { amount: '50', gatewayId: cliq },
    { headers: { 'idempotency-key': crypto.randomUUID() } },
  );
  expect(created.statusCode).toBe(201);
  const { db } = await testDb();
  const fileId = await insertProofFile(db, customer.id, { ownerType: 'customer' });
  const attached = await store.call(
    'POST',
    `/store/v1/me/wallet/top-ups/${created.json().id}/receipt`,
    { fileId },
    { headers: { 'idempotency-key': 'r' } },
  );
  expect(attached.statusCode).toBe(201);
  const [payment] = await db.select().from(s.payments).where(eq(s.payments.invoiceId, created.json().id));
  return { customer, store, topUpId: created.json().id as number, paymentId: payment!.id };
}

async function mailsOf(customerId: number, event: string) {
  const { db } = await testDb();
  return db
    .select()
    .from(s.notifications)
    .where(and(eq(s.notifications.recipientId, customerId), eq(s.notifications.event, event)));
}

describe('the Deposits wire with customer top-ups', () => {
  it('names the customer with the balance, filters by owner and customer, and searches the email', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const merchantGateway = await insertGateway(t, db, { isManual: true, driver: 'bank', code: 'bank' });
    const invoice = await insertInvoiceRow(db, merchant.id, { gatewayId: merchantGateway });
    await insertPendingPayment(db, invoice, merchantGateway);
    const { customer, paymentId } = await inReview();

    const all = await staff.get('/admin/payments');
    expect(all.total).toBe(2);
    const row = all.body.find((payment: { id: number }) => payment.id === paymentId);
    expect(row).toMatchObject({
      status: 'pending',
      amount: '50.0000',
      feeAmount: '1.5000',
      netAmount: '48.5000',
      client: null,
      customer: { id: customer.id, name: 'Daniel Rivera', email: customer.email, walletBalance: null },
      gateway: { id: cliq, name: 'CliQ transfer' },
      note: 'First top-up of this customer.',
    });
    expect(all.body.find((payment: { id: number }) => payment.id !== paymentId).customer).toBeNull();
    expect((await staff.get('/admin/payments?owner=customer')).body.map((p: { id: number }) => p.id)).toEqual([
      paymentId,
    ]);
    expect((await staff.get('/admin/payments?owner=merchant')).body.map((p: { id: number }) => p.id)).not.toContain(
      paymentId,
    );
    expect((await staff.get(`/admin/payments?customerId=${customer.id}`)).total).toBe(1);
    expect((await staff.get(`/admin/payments?q=${encodeURIComponent(customer.email.slice(0, 18))}`)).body[0].id).toBe(
      paymentId,
    );
    expect((await staff.get(`/admin/payments/${paymentId}`)).body.customer.id).toBe(customer.id);
  });
});

describe('POST /admin/payments/:id/approve for a customer top-up', () => {
  it('credits the net to the balance once, pays the invoice, emails once and writes no merchant outbox row', async () => {
    const { customer, store, topUpId, paymentId } = await inReview();
    const approved = await staff.post(`/admin/payments/${paymentId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'approved',
      customer: { id: customer.id, walletBalance: '48.5000' },
    });
    const { db } = await testDb();
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '48.5000' });
    const [journal] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `deposit:payment:${paymentId}`));
    expect(journal).toMatchObject({
      kind: 'deposit',
      refType: 'payment',
      refId: paymentId,
      createdByType: 'staff',
      createdById: staff.staffId,
    });
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, topUpId));
    expect(invoice).toMatchObject({ status: 'paid', pdfFileId: null });
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'invoice.paid'))).toEqual([]);
    const mails = await mailsOf(customer.id, 'wallet.topup_credited');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.payload).toMatchObject({
      variables: { amount: '48.50 USD', balance: '48.50 USD', customerName: 'Daniel Rivera' },
    });
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, paymentId));
    expect(audit).toMatchObject({ action: 'approved deposit of', entityLabel: '48.5000 USD from Daniel Rivera' });
    expect((await staff.post(`/admin/payments/${paymentId}/approve`)).body.code).toBe('PAYMENT_ALREADY_REVIEWED');
    const wallet = (await store.call('GET', '/store/v1/me/wallet')).json();
    expect(wallet).toMatchObject({ balance: '48.5000', available: '48.5000', pendingTopUps: { count: 0 } });
    const topUp = (await store.call('GET', `/store/v1/me/wallet/top-ups/${topUpId}`)).json();
    expect(topUp).toMatchObject({ status: 'credited', creditedAt: '2026-11-10T09:00:00.000Z' });
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('credits once when two approvals race', async () => {
    const { customer, paymentId } = await inReview();
    const results = await Promise.all([
      staff.post(`/admin/payments/${paymentId}/approve`),
      staff.post(`/admin/payments/${paymentId}/approve`),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const { db } = await testDb();
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '48.5000' });
    expect(await mailsOf(customer.id, 'wallet.topup_credited')).toHaveLength(1);
  });

  it('credits a frozen wallet and a switched-off one (money received is always booked)', async () => {
    const { customer, paymentId } = await inReview();
    const { db } = await testDb();
    await db.insert(s.ledgerAccounts).values({
      kind: 'customer_wallet',
      ownerType: 'customer',
      ownerId: customer.id,
      currency: 'USD',
      frozenAt: new Date(),
      frozenReason: 'Hold',
    });
    await walletSettings(t, db, { 'wallet.customer.enabled': false });
    expect((await staff.post(`/admin/payments/${paymentId}/approve`)).status).toBe(200);
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '48.5000', frozenReason: 'Hold' });
  });
});

describe('POST /admin/payments/:id/reject for a customer top-up', () => {
  it('voids the top-up, tells the customer why and names them in the audit', async () => {
    const { customer, store, topUpId, paymentId } = await inReview();
    const rejected = await staff.post(`/admin/payments/${paymentId}/reject`, {
      reason: 'The transfer did not arrive.',
    });
    expect(rejected.status).toBe(200);
    const { db } = await testDb();
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, topUpId));
    expect(invoice!.status).toBe('void');
    expect(await customerWalletRow(db, customer.id)).toBeUndefined();
    const mails = await mailsOf(customer.id, 'wallet.topup_rejected');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.payload).toMatchObject({
      variables: { reason: 'The transfer did not arrive.', amount: '50.00 USD' },
    });
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, paymentId));
    expect(audit).toMatchObject({ action: 'rejected deposit of', entityLabel: '50.0000 USD from Daniel Rivera' });
    const topUp = (await store.call('GET', `/store/v1/me/wallet/top-ups/${topUpId}`)).json();
    expect(topUp).toMatchObject({ status: 'rejected', rejectionReason: 'The transfer did not arrive.' });
  });
});
