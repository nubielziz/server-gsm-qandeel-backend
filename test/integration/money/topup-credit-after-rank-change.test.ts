// Integration tests of the credit of a top-up after the account changed rank kind (decision 064): a credit is never refused
// and lands on the wallet of the account's rank kind now, whatever kind of wallet the invoice was made for. A rank change refuses only while
// a live top-up is open, so this happens to a payment of an automatic invoice that is no longer live and was paid late, or to a payment a
// staff member decides later. The audit row records both kinds.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { PaymentAutoCredit, PaymentAutoCreditModule } from '@src/modules/money';
import { adminWith } from '../../support/admin-api';
import { makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  insertInvoiceRow,
  insertPendingPayment,
  postWebhook,
  signedHeaders,
} from '../../support/billing';
import { DAY, MINUTE, TestClock } from '../../support/clock';
import { customerWalletRow, insertWalletTemplates, walletSettings } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { accountFigures, insertWalletMerchant, ledgerTotals } from '../../support/money';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
const fake = new FakeGateway();
let t: TestApp;
let db: Database;
let job: PaymentAutoCredit;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, PaymentAutoCreditModule] });
  job = t.app.get(PaymentAutoCredit, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await insertUsd(db);
  await walletSettings(t, db);
  await insertWalletTemplates(db);
});

/** The lines of the deposit journal of a payment: account kind to signed amount (debit above zero). */
async function depositLines(paymentId: number): Promise<Record<string, string>> {
  const rows = await db
    .select({ kind: s.ledgerAccounts.kind, amount: s.ledgerEntries.amount })
    .from(s.ledgerEntries)
    .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.ledgerEntries.accountId))
    .innerJoin(s.ledgerTransactions, eq(s.ledgerTransactions.id, s.ledgerEntries.transactionId))
    .where(eq(s.ledgerTransactions.idempotencyKey, `deposit:payment:${paymentId}`));
  return Object.fromEntries(rows.map((row) => [row.kind, row.amount]));
}

describe('a top-up paid after the account became a retail account', () => {
  it('credits the store balance of a late payment of an automatic merchant invoice, with the store mail and no merchant event', async () => {
    // A retail account now; the invoice was made for its merchant wallet three days ago, so it is no longer live and a rank change
    // did not wait for it.
    const account = await makeAccount({ rank: 'retail', name: 'Daniel Rivera', db });
    const gatewayId = await insertGateway(t, db, {
      code: 'card',
      name: 'Card gateway',
      driver: 'card',
      audience: 'both',
      apiBase: fake.url,
    });
    const invoice = await insertInvoiceRow(db, account.id, {
      amount: '100.0000',
      fee: '3.2000',
      gatewayId,
      createdAt: new Date(clock.nowMs() - 3 * DAY),
    });
    expect(invoice.walletKind).toBe('client_wallet');
    const reference = `pi_${crypto.randomUUID()}`;
    fake.paid(reference, { minor: 10000, reference: invoice.number });
    const body = cardEvent(`evt_${crypto.randomUUID()}`, invoice.number, { reference, amount: 10000 });
    expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);
    const [payment] = await db.select().from(s.payments);
    expect(payment).toMatchObject({ accountId: account.id, status: 'pending' });

    clock.advance(11 * MINUTE);
    expect(await job.run(await job.due())).toMatchObject({ checked: 1, credited: 1, failed: 0 });

    // The live wallet is credited: the store balance, never a merchant wallet.
    expect(await depositLines(payment!.id)).toEqual({
      customer_wallet: '-96.8000',
      fee_income: '-3.2000',
      gateway_clearing: '100.0000',
    });
    expect((await customerWalletRow(db, account.id))!.balance).toBe('96.8000');
    expect(await accountFigures(db, 'client_wallet', { type: 'account', id: account.id })).toBeUndefined();
    expect((await db.select().from(s.payments).where(eq(s.payments.id, payment!.id)))[0]!.status).toBe('approved');
    expect((await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id)))[0]!.status).toBe('paid');
    // A store credit tells the account by mail and queues no merchant event.
    expect(
      await db.select().from(s.notifications).where(eq(s.notifications.event, 'wallet.topup_credited')),
    ).toHaveLength(1);
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'invoice.paid'))).toHaveLength(0);
    // The audit row records both kinds.
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'credited deposit of'));
    expect(audit).toMatchObject({ entityType: 'payment', entityId: payment!.id, actorType: 'system' });
    expect(audit!.after).toMatchObject({ invoiceWallet: 'client_wallet', creditedWallet: 'customer_wallet' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

describe('a top-up decided after the account became a merchant', () => {
  it('credits the merchant wallet when staff approve a payment of a store balance invoice, and queues invoice.paid', async () => {
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const gatewayId = await insertGateway(t, db, { name: 'Bank transfer', isManual: true, audience: 'both' });
    // The invoice was made for the store balance when the account was a retail account.
    const invoice = await insertInvoiceRow(db, merchant.id, {
      amount: '103.0000',
      fee: '3.0000',
      gatewayId,
      walletKind: 'customer_wallet',
      legacyClientId: null,
    });
    const payment = await insertPendingPayment(db, invoice, gatewayId, { methodType: 'bank', gatewayTxnId: 'TRX-9' });
    const admin = await adminWith(t, ['payments:read', 'payments:approve']);

    const res = await admin.post(`/admin/payments/${payment.id}/approve`);
    expect(res.status).toBe(200);
    expect(await depositLines(payment.id)).toEqual({
      bank: '103.0000',
      client_wallet: '-100.0000',
      fee_income: '-3.0000',
    });
    expect((await accountFigures(db, 'client_wallet', { type: 'account', id: merchant.id }))!.balance).toBe('100.0000');
    expect(await customerWalletRow(db, merchant.id)).toBeUndefined();
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'invoice.paid'))).toHaveLength(1);
    expect(
      await db.select().from(s.notifications).where(eq(s.notifications.event, 'wallet.topup_credited')),
    ).toHaveLength(0);
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'approved deposit of'));
    expect(audit!.after).toMatchObject({ invoiceWallet: 'customer_wallet', creditedWallet: 'client_wallet' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('records no crossing when the invoice and the live wallet are of one kind', async () => {
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const gatewayId = await insertGateway(t, db, { name: 'Bank transfer', isManual: true, audience: 'both' });
    const invoice = await insertInvoiceRow(db, merchant.id, { amount: '103.0000', fee: '3.0000', gatewayId });
    const payment = await insertPendingPayment(db, invoice, gatewayId, { methodType: 'bank', gatewayTxnId: 'TRX-10' });
    const admin = await adminWith(t, ['payments:read', 'payments:approve']);

    expect((await admin.post(`/admin/payments/${payment.id}/approve`)).status).toBe(200);
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'approved deposit of'));
    expect(audit!.after).not.toHaveProperty('invoiceWallet');
    expect(audit!.after).not.toHaveProperty('creditedWallet');
  });
});
