// Integration tests of top-up chargebacks (feature 21, plan § 5.6.9, defect D4): the dispute webhook now handles disputes of top-up payments
// for customers and merchants: `created` records it and holds a customer's balance, `lost` claws the credit back once (below zero when it
// was spent, frozen at commit), `won` closes it and leaves the hold; a top-up never credited posts nothing and can never be credited later;
// `/admin/disputes` never serves a top-up dispute; the Deposits wire shows it; the books still reconcile.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { PaymentAutoCredit, PaymentAutoCreditModule } from '../../src/modules/money';
import { findBalanceDifferences } from '../../src/modules/money/infra/ledger-read.repository';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { hook } from '../support/b2c';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  postWebhook,
  signedHeaders,
} from '../support/billing';
import { MINUTE, TestClock } from '../support/clock';
import { customerWalletRow, insertWalletTemplates, walletSettings } from '../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { insertWalletMerchant, ledgerTotals } from '../support/money';
import { walletOf } from '../support/orders';
import { insertCustomer } from '../support/support';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
const fake = new FakeGateway();
let t: TestApp;
let db: Database;
let job: PaymentAutoCredit;
let staff: AdminApi;
let gatewayId: number;

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
  await walletSettings(t, db, { 'wallet.customer.card_topups': true });
  await insertWalletTemplates(db);
  gatewayId = await insertGateway(t, db, {
    code: 'card',
    name: 'Card',
    driver: 'card',
    audience: 'both',
    apiBase: fake.url,
  });
  staff = await adminWith(t, ['payments:*', 'wallet:*', 'disputes:*', 'refunds:*']);
});

let invoiceCounter = 0;

/** A top-up invoice of 50 USD (fee 1.50) for a customer or a merchant, confirmed by the gateway and, unless told otherwise, credited. */
async function topUp(owner: { customerId?: number; clientId?: number }, options: { credit?: boolean } = {}) {
  invoiceCounter += 1;
  const [invoice] = await db
    .insert(s.invoices)
    .values({
      number: `INV-2026-${String(invoiceCounter).padStart(4, '0')}`,
      customerId: owner.customerId ?? null,
      clientId: owner.clientId ?? null,
      kind: 'topup',
      amount: '50.0000',
      fee: '1.5000',
      netAmount: '48.5000',
      total: '50.0000',
      currency: 'USD',
      gatewayId,
      checkoutUrl: 'https://pay.example/cs_1',
    })
    .returning();
  const reference = `pi_${crypto.randomUUID()}`;
  const body = cardEvent(`evt_${crypto.randomUUID()}`, invoice!.number, { reference, amount: 5000 });
  expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);
  if (options.credit !== false) {
    clock.advance(10 * MINUTE);
    expect(await job.run(await job.due())).toMatchObject({ credited: 1 });
  }
  const [payment] = await db.select().from(s.payments).where(eq(s.payments.invoiceId, invoice!.id));
  return { invoice: invoice!, payment: payment!, reference };
}

/** A signed card dispute event on a USD payment. */
function dispute(
  reference: string,
  options: { dispute?: string; type?: 'created' | 'won' | 'lost'; amount?: number; fee?: number } = {},
): string {
  const type = options.type ?? 'created';
  return JSON.stringify({
    id: `evt_${crypto.randomUUID()}`,
    type: type === 'created' ? 'charge.dispute.created' : 'charge.dispute.closed',
    data: {
      object: {
        id: options.dispute ?? 'dp_1',
        payment_intent: reference,
        amount: options.amount ?? 5000,
        currency: 'usd',
        fee: options.fee ?? 1500,
        reason: 'fraudulent',
        status: type === 'created' ? 'needs_response' : type,
      },
    },
  });
}

const send = async (body: string) => {
  const res = await hook(t, clock, 'disputes', 'card', body);
  expect(res.statusCode).toBe(200);
  return res.json<{ received: true; duplicate?: boolean }>();
};

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

const disputeRows = () => db.select().from(s.disputes);

describe('a dispute of a customer top-up', () => {
  it('created: records it without an order, keeps the payment approved, holds the balance; once for a repeated event', async () => {
    const customer = await insertCustomer(db, { hasAccount: true, name: 'Daniel Rivera' });
    const { payment, reference } = await topUp({ customerId: customer.id });
    expect(await send(dispute(reference))).toEqual({ received: true });
    expect(await send(dispute(reference))).toEqual({ received: true, duplicate: true });

    const [row] = await disputeRows();
    expect(row).toMatchObject({
      paymentId: payment.id,
      orderId: null,
      customerId: customer.id,
      status: 'needs_response',
    });
    const [stored] = await db.select().from(s.payments).where(eq(s.payments.id, payment.id));
    expect(stored!.status).toBe('approved');
    const wallet = await customerWalletRow(db, customer.id);
    expect(wallet).toMatchObject({ balance: '48.5000', frozenReason: `Dispute DP-${row!.id} on PAY-${payment.id}` });
    expect(wallet!.frozenAt).not.toBeNull();
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'froze wallet of'));
    expect(audit).toMatchObject({ entityType: 'customer', entityId: customer.id, actorType: 'system' });
    expect(await db.select().from(s.notifications).where(eq(s.notifications.event, 'wallet.frozen'))).toHaveLength(1);

    // Staff see it on the deposit and the wallet, never in /admin/disputes; the hold cannot be lifted while it is open.
    expect((await staff.get(`/admin/payments/${payment.id}`)).body.dispute).toMatchObject({
      id: row!.id,
      status: 'needs_response',
      amount: '50.0000',
      fee: '15.0000',
      transactionId: null,
    });
    expect((await staff.get('/admin/disputes')).body).toEqual([]);
    expect((await staff.get(`/admin/disputes/${row!.id}`)).status).toBe(404);
    expect((await staff.get(`/admin/customers/${customer.id}/wallet`)).body.openDisputes).toBe(1);
    const unfreeze = await staff.post(
      `/admin/customers/${customer.id}/wallet/unfreeze`,
      { reason: 'Checked the dispute' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(unfreeze.status).toBe(409);
    expect(unfreeze.body.code).toBe('OPEN_DISPUTE');
  });

  it('lost after the money was spent: takes the credit back below zero, reverses the fee, books the dispute fee; once', async () => {
    const customer = await insertCustomer(db, { hasAccount: true, name: 'Daniel Rivera' });
    const { payment, reference } = await topUp({ customerId: customer.id });
    expect(
      (
        await staff.post(
          `/admin/customers/${customer.id}/wallet/adjust`,
          { amount: '40.0000', direction: 'debit', reason: 'Spent on an order' },
          { 'idempotency-key': crypto.randomUUID() },
        )
      ).status,
    ).toBe(200);
    await send(dispute(reference));
    await send(dispute(reference, { type: 'lost' }));
    expect(await send(dispute(reference, { type: 'lost' }))).toEqual({ received: true, duplicate: true });

    const [row] = await disputeRows();
    const ledgerTxId = row!.ledgerTxId!;
    expect(row!.status).toBe('lost');
    expect(ledgerTxId).toBeGreaterThan(0);
    expect(await journal(`dispute:${row!.id}:chargeback`)).toEqual([
      { account: 'chargeback_loss', amount: '15.0000' },
      { account: 'customer_wallet', amount: '48.5000' },
      { account: 'fee_income', amount: '1.5000' },
      { account: 'gateway_clearing', amount: '-65.0000' },
    ]);
    const [tx] = await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.id, ledgerTxId));
    expect(tx).toMatchObject({ kind: 'chargeback', refType: 'dispute', refId: row!.id });
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '-40.0000' });
    expect((await customerWalletRow(db, customer.id))!.frozenAt).not.toBeNull();
    const [stored] = await db.select().from(s.payments).where(eq(s.payments.id, payment.id));
    expect(stored!.status).toBe('approved');
    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'charged back deposit of'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: 'payment', entityId: payment.id, actorType: 'system' });

    // Below zero stays frozen until staff collect it (an audited credit adjustment), then the hold can be lifted.
    const refused = await staff.post(
      `/admin/customers/${customer.id}/wallet/unfreeze`,
      { reason: 'Collected' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONFLICT');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('lost for part of the top-up: the fee share is pro rata and the rest of the credit stays', async () => {
    const customer = await insertCustomer(db, { hasAccount: true });
    const { reference } = await topUp({ customerId: customer.id });
    await send(dispute(reference, { amount: 2000, fee: 0 }));
    await send(dispute(reference, { amount: 2000, fee: 0, type: 'lost' }));
    const [row] = await disputeRows();
    // Fee share round(1.50 x 20 / 50, 4) = 0.60; the wallet gives back 20.00 − 0.60 = 19.40.
    expect(await journal(`dispute:${row!.id}:chargeback`)).toEqual([
      { account: 'customer_wallet', amount: '19.4000' },
      { account: 'fee_income', amount: '0.6000' },
      { account: 'gateway_clearing', amount: '-20.0000' },
    ]);
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '29.1000' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('won: closes it, posts nothing and leaves the hold for staff, who can then lift it', async () => {
    const customer = await insertCustomer(db, { hasAccount: true });
    const { reference } = await topUp({ customerId: customer.id });
    await send(dispute(reference));
    await send(dispute(reference, { type: 'won' }));
    expect(await send(dispute(reference, { type: 'lost' }))).toEqual({ received: true, duplicate: true });
    const [row] = await disputeRows();
    expect(row).toMatchObject({ status: 'won', ledgerTxId: null });
    expect(await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.kind, 'chargeback'))).toEqual([]);
    expect((await customerWalletRow(db, customer.id))!.frozenAt).not.toBeNull();
    const unfreeze = await staff.post(
      `/admin/customers/${customer.id}/wallet/unfreeze`,
      { reason: 'Dispute won' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(unfreeze.status).toBe(200);
    expect(unfreeze.body.frozen).toBeNull();
  });

  it('a top-up disputed before it was credited is never credited: the job skips it, the loss rejects it and posts nothing', async () => {
    const customer = await insertCustomer(db, { hasAccount: true });
    const { payment, invoice, reference } = await topUp({ customerId: customer.id }, { credit: false });
    await send(dispute(reference));
    clock.advance(10 * MINUTE);
    expect(await job.run(await job.due())).toMatchObject({ credited: 0 });
    await send(dispute(reference, { type: 'lost' }));

    const [stored] = await db.select().from(s.payments).where(eq(s.payments.id, payment.id));
    expect(stored).toMatchObject({ status: 'rejected', autoCreditAt: null });
    const [voided] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id));
    expect(voided!.status).toBe('void');
    expect(await disputeRows()).toEqual([expect.objectContaining({ status: 'lost', ledgerTxId: null })]);
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '0.0000' });
    expect((await customerWalletRow(db, customer.id))!.frozenAt).not.toBeNull();
    const approve = await staff.post(`/admin/payments/${payment.id}/approve`);
    expect(approve.status).toBe(409);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

describe('a dispute of a merchant top-up', () => {
  it('created records it (no hold); lost takes the credit back from the merchant wallet, below zero if need be', async () => {
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const { payment, reference } = await topUp({ clientId: merchant.id });
    expect((await walletOf(db, merchant.id)).wallet).toBe('48.5000');
    await send(dispute(reference));
    const [opened] = await disputeRows();
    expect(opened).toMatchObject({ paymentId: payment.id, orderId: null, customerId: null });
    expect((await staff.get('/admin/payments')).body[0].dispute).toMatchObject({ status: 'needs_response' });

    await send(dispute(reference, { type: 'lost' }));
    const [row] = await disputeRows();
    expect(await journal(`dispute:${row!.id}:chargeback`)).toEqual([
      { account: 'chargeback_loss', amount: '15.0000' },
      { account: 'client_wallet', amount: '48.5000' },
      { account: 'fee_income', amount: '1.5000' },
      { account: 'gateway_clearing', amount: '-65.0000' },
    ]);
    expect((await walletOf(db, merchant.id)).wallet).toBe('0.0000');
    const [stored] = await db
      .select()
      .from(s.payments)
      .where(and(eq(s.payments.id, payment.id), eq(s.payments.status, 'approved')));
    expect(stored).toBeDefined();
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await findBalanceDifferences(db)).toEqual([]);
  });
});
