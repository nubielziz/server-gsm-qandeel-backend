// Integration tests of an automatic store balance top-up (feature 21, plan § 5.6.5): the gateway's confirmation of a customer's top-up
// invoice records a pending payment (customer and fingerprint kept), a duplicate delivery records nothing, the automatic credit job credits
// the customer's balance from gateway_clearing once (also when staff race it), and a confirmation of another amount goes to review.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { PaymentAutoCredit, PaymentAutoCreditModule } from '@src/modules/money';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  postWebhook,
  signedHeaders,
} from '../../support/billing';
import { MINUTE, TestClock } from '../../support/clock';
import { customerWalletRow, insertWalletTemplates, walletSettings } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { insertCustomer } from '../../support/support';

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
  await walletSettings(t, db, { 'wallet.customer.card_topups': true });
  await insertWalletTemplates(db);
});

/** A customer's automatic top-up invoice of 50 (fee 1.50) and its gateway's signed confirmation. */
async function confirmedTopUp(amountCents = 5000, reference = `pi_${crypto.randomUUID()}`) {
  const customer = await insertCustomer(db, { hasAccount: true, name: 'Daniel Rivera' });
  const gatewayId = await insertGateway(t, db, {
    code: 'card',
    name: 'Card',
    driver: 'card',
    audience: 'b2c',
    apiBase: fake.url,
  });
  const [invoice] = await db
    .insert(s.invoices)
    .values({
      number: `INV-2026-${String(Math.floor(Math.random() * 9000) + 1000)}`,
      accountId: customer.id,
      walletKind: 'customer_wallet',
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
  fake.paid(reference, { minor: amountCents, reference: invoice!.number });
  const body = cardEvent(`evt_${crypto.randomUUID()}`, invoice!.number, { reference, amount: amountCents });
  const res = await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock));
  return { customer, gatewayId, invoice: invoice!, body, res, reference };
}

const tick = async () => job.run(await job.due());

describe('POST /webhooks/payments/:gateway for a customer top-up', () => {
  it('records the pending payment of the customer, once for a duplicate delivery', async () => {
    const { customer, invoice, body, res } = await confirmedTopUp();
    expect(res.statusCode).toBe(200);
    const again = await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock));
    expect(again.json()).toMatchObject({ received: true, duplicate: true });
    const payments = await db.select().from(s.payments).where(eq(s.payments.invoiceId, invoice.id));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      purpose: 'topup',
      status: 'pending',
      accountId: customer.id,
      reviewRequired: false,
      methodType: 'card',
    });
    expect(payments[0]!.autoCreditAt).not.toBeNull();
  });

  it('lets the automatic credit put the net on the balance from gateway_clearing, with one email', async () => {
    const { customer, invoice } = await confirmedTopUp();
    clock.advance(10 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 1 });
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '48.5000' });
    const [paid] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id));
    expect(paid!.status).toBe('paid');
    const [journal] = await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.kind, 'deposit'));
    expect(journal).toMatchObject({ createdByType: 'system' });
    const lines = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.transactionId, journal!.id));
    expect(lines.map((line) => line.amount).sort()).toEqual(['-1.5000', '-48.5000', '50.0000']);
    expect(
      await db.select().from(s.notifications).where(eq(s.notifications.event, 'wallet.topup_credited')),
    ).toHaveLength(1);
    expect(await tick()).toMatchObject({ credited: 0 });
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('credits once when staff approve a flagged payment while the job runs', async () => {
    const { customer, invoice } = await confirmedTopUp();
    const [payment] = await db.select().from(s.payments).where(eq(s.payments.invoiceId, invoice.id));
    await db.update(s.payments).set({ reviewRequired: true }).where(eq(s.payments.id, payment!.id));
    const staff = await adminWith(t, ['payments:approve', 'payments:read']);
    clock.advance(10 * MINUTE);
    const [approved, ran] = await Promise.all([staff.post(`/admin/payments/${payment!.id}/approve`), tick()]);
    expect(approved.status).toBe(200);
    expect(ran).toMatchObject({ credited: 0 });
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '48.5000' });
  });

  it('sends a confirmation of another amount to review instead of crediting it', async () => {
    const { customer, invoice } = await confirmedTopUp(4000);
    const [payment] = await db.select().from(s.payments).where(eq(s.payments.invoiceId, invoice.id));
    expect(payment).toMatchObject({ reviewRequired: true, autoCreditAt: null });
    clock.advance(10 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 0 });
    expect(await customerWalletRow(db, customer.id)).toBeUndefined();
  });
});
