// Integration tests of the staff routes on wallet top-ups (map stage 8): the list and read, approving (the deposit journal with the
// source account of user rule 4, the invoice, `invoice.paid`, the audit row), rejecting, the guards of an automatic gateway, and the
// race between two decisions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import {
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  insertInvoiceRow,
  insertPendingPayment,
  insertProofFile,
  postWebhook,
  signedHeaders,
} from '../support/billing';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { accountFigures, insertWalletMerchant } from '../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

/** A merchant, a gateway of the given kind and a pending top-up of 103 with a fee of 3. */
async function world(kind: 'manual' | 'automatic', paymentOverrides: Partial<typeof s.payments.$inferInsert> = {}) {
  const { db } = await testDb();
  const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  const gatewayId = await insertGateway(
    t,
    db,
    kind === 'manual' ? { name: 'Bank transfer', isManual: true } : { name: 'Card gateway', driver: 'card' },
  );
  const invoice = await insertInvoiceRow(db, merchant.id, { amount: '103.0000', fee: '3.0000', gatewayId });
  const receiptFileId = await insertProofFile(db, merchant.id);
  const payment = await insertPendingPayment(db, invoice, gatewayId, {
    methodType: kind === 'manual' ? 'bank' : 'card',
    gatewayTxnId: 'TRX-1',
    receiptFileId,
    ...paymentOverrides,
  });
  return { db, merchant, gatewayId, invoice, payment };
}

async function journalOf(db: Awaited<ReturnType<typeof testDb>>['db'], paymentId: number) {
  const [header] = await db
    .select()
    .from(s.ledgerTransactions)
    .where(and(eq(s.ledgerTransactions.refType, 'payment'), eq(s.ledgerTransactions.refId, paymentId)));
  if (!header) return undefined;
  const lines = await db
    .select({ kind: s.ledgerAccounts.kind, amount: s.ledgerEntries.amount })
    .from(s.ledgerEntries)
    .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.ledgerEntries.accountId))
    .where(eq(s.ledgerEntries.transactionId, header.id));
  return { header, lines: Object.fromEntries(lines.map((line) => [line.kind, line.amount])) };
}

describe('POST /admin/payments/:id/approve', () => {
  it('credits the wallet from the bank for a manual gateway, pays the invoice and queues invoice.paid', async () => {
    const { db, merchant, invoice, payment } = await world('manual');
    const admin = await adminWith(t, ['payments:approve', 'payments:read'], { name: 'Omar T.' });
    clock.advance(60_000);
    const res = await admin.post(`/admin/payments/${payment.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: payment.id,
      status: 'approved',
      netAmount: '100.0000',
      reviewedBy: { id: admin.staffId, name: 'Omar T.' },
      reviewedAt: '2026-11-01T10:01:00.000Z',
      client: { id: merchant.id, name: 'Zain Mobile Hub', walletBalance: '100.0000' },
      gateway: { name: 'Bank transfer' },
      gatewayTxnId: 'TRX-1',
    });
    const journal = await journalOf(db, payment.id);
    expect(journal!.header).toMatchObject({
      kind: 'deposit',
      idempotencyKey: `deposit:payment:${payment.id}`,
      memo: `Deposit PAY-${payment.id} (Bank transfer)`,
    });
    // Dr bank 103 (gross), Cr client_wallet 100 (net), Cr fee_income 3: debits are positive, credits negative.
    expect(journal!.lines).toEqual({ bank: '103.0000', client_wallet: '-100.0000', fee_income: '-3.0000' });
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('100.0000');
    const [paid] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id));
    expect(paid).toMatchObject({ status: 'paid' });
    expect(paid!.paidAt!.toISOString()).toBe('2026-11-01T10:01:00.000Z');
    const events = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'invoice.paid'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: 'invoices',
      aggregateId: invoice.id,
      payload: { invoiceId: invoice.id, clientId: merchant.id },
    });
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'approved deposit of'));
    expect(audit).toMatchObject({ entityType: 'payment', entityId: payment.id, actorName: 'Omar T.' });
    expect(audit!.entityLabel).toBe('100.0000 USD from Zain Mobile Hub');
  });

  it('debits gateway_clearing for an automatic gateway that was sent to review', async () => {
    const { db, payment } = await world('automatic', { reviewRequired: true, reviewNote: 'Flagged by risk' });
    const admin = await adminWith(t, ['payments:approve']);
    expect((await admin.post(`/admin/payments/${payment.id}/approve`)).status).toBe(200);
    const journal = await journalOf(db, payment.id);
    expect(journal!.lines).toEqual({ gateway_clearing: '103.0000', client_wallet: '-100.0000', fee_income: '-3.0000' });
  });

  it('refuses an automatic gateway that credits by itself, a second decision, an unknown payment and an order payment', async () => {
    const auto = await world('automatic', { autoCreditAt: new Date('2026-11-01T10:10:00.000Z') });
    const admin = await adminWith(t, ['payments:approve', 'payments:read']);
    const pending = await admin.post(`/admin/payments/${auto.payment.id}/approve`);
    expect(pending.status).toBe(409);
    expect(pending.body).toMatchObject({
      code: 'PAYMENT_AUTO_CREDIT_PENDING',
      detail: `PAY-${auto.payment.id} is credited automatically after the gateway check.`,
    });
    expect((await admin.post(`/admin/payments/${auto.payment.id}/reject`, { reason: 'No' })).body.code).toBe(
      'PAYMENT_AUTO_CREDIT_PENDING',
    );
    expect(await journalOf(auto.db, auto.payment.id)).toBeUndefined();

    const manual = await world('manual');
    expect((await admin.post(`/admin/payments/${manual.payment.id}/approve`)).status).toBe(200);
    const again = await admin.post(`/admin/payments/${manual.payment.id}/approve`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'PAYMENT_ALREADY_REVIEWED',
      detail: `PAY-${manual.payment.id} was already approved.`,
    });
    expect((await admin.post('/admin/payments/99999/approve')).status).toBe(404);

    const [order] = await manual.db
      .insert(s.payments)
      .values({
        purpose: 'order',
        gatewayId: manual.gatewayId,
        amount: '10.0000',
        currency: 'USD',
        status: 'captured',
        methodType: 'card',
      })
      .returning({ id: s.payments.id });
    expect((await admin.post(`/admin/payments/${order!.id}/approve`)).status).toBe(404);
    expect((await admin.get(`/admin/payments/${order!.id}`)).status).toBe(404);
  });

  it('posts once when two approvals race', async () => {
    const { db, merchant, payment } = await world('manual');
    const admin = await adminWith(t, ['payments:approve']);
    const results = await Promise.all([1, 2, 3].map(() => admin.post(`/admin/payments/${payment.id}/approve`)));
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(
      results.filter((res) => res.status === 409).every((res) => res.body.code === 'PAYMENT_ALREADY_REVIEWED'),
    ).toBe(true);
    const deposits = await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.kind, 'deposit'));
    expect(deposits).toHaveLength(1);
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('100.0000');
  });

  it('refuses a caller without payments:approve', async () => {
    const { payment } = await world('manual');
    const reader = await adminWith(t, ['payments:read']);
    expect((await reader.post(`/admin/payments/${payment.id}/approve`)).status).toBe(403);
  });
});

/**
 * A card payment that came through the real webhook, as the gateway reported it: the invoice asks 100 (fee 3, so the wallet would
 * get 97), the event carries `reported`.
 */
async function confirmedThroughWebhook(reported: { amount?: number; currency?: string }) {
  const { db } = await testDb();
  const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  const gatewayId = await insertGateway(t, db, { code: 'card', name: 'Card gateway', driver: 'card' });
  const invoice = await insertInvoiceRow(db, merchant.id, { amount: '100.0000', fee: '3.0000', gatewayId });
  const body = cardEvent(`evt_${crypto.randomUUID()}`, invoice.number, { reference: 'pi_review', ...reported });
  expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);
  const [payment] = await db.select().from(s.payments);
  return { db, merchant, gatewayId, invoice, payment: payment! };
}

describe('POST /admin/payments/:id/approve (a confirmation that does not match its invoice)', () => {
  /** Approving is refused with 409, nothing is credited, and staff can still reject (which voids the invoice). */
  async function expectNeverCredited(fixture: Awaited<ReturnType<typeof confirmedThroughWebhook>>, reason: string) {
    const { db, merchant, invoice, payment } = fixture;
    expect(payment).toMatchObject({ status: 'pending', reviewRequired: true, autoCreditAt: null });
    const admin = await adminWith(t, ['payments:approve', 'payments:read']);
    const approve = await admin.post(`/admin/payments/${payment.id}/approve`);
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('CONFLICT');
    expect(approve.body.detail).toContain(reason);
    expect(approve.body.detail).toContain('Reject it');
    expect(await journalOf(db, payment.id)).toBeUndefined();
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '0.0000',
    });
    expect((await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id)))[0]!.status).toBe('open');
    expect((await db.select().from(s.payments).where(eq(s.payments.id, payment.id)))[0]).toMatchObject({
      status: 'pending',
      reviewedBy: null,
    });
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'invoice.paid'))).toHaveLength(0);

    const reject = await admin.post(`/admin/payments/${payment.id}/reject`, { reason: 'Paid less than the invoice' });
    expect(reject.status).toBe(200);
    expect(reject.body).toMatchObject({ status: 'rejected' });
    expect((await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id)))[0]!.status).toBe('void');
  }

  it('never credits a payment the gateway reported as less than the invoice', async () => {
    await expectNeverCredited(
      await confirmedThroughWebhook({ amount: 5000 }),
      'The gateway reports 50.0000 paid; the invoice is 100.0000.',
    );
  });

  it('never credits a payment the gateway reported as more than the invoice', async () => {
    await expectNeverCredited(
      await confirmedThroughWebhook({ amount: 15000 }),
      'The gateway reports 150.0000 paid; the invoice is 100.0000.',
    );
  });

  it('never credits a payment in another currency, even for the same number', async () => {
    await expectNeverCredited(
      await confirmedThroughWebhook({ amount: 10000, currency: 'eur' }),
      'The gateway reports a payment in EUR; the invoice is in USD.',
    );
  });

  it('refuses a payment whose gateway event can no longer be read, because its amount cannot be checked', async () => {
    const fixture = await confirmedThroughWebhook({ amount: 10000 });
    await fixture.db
      .update(s.payments)
      .set({ reviewRequired: true, autoCreditAt: null, raw: { type: 'something.else' } })
      .where(eq(s.payments.id, fixture.payment.id));
    const [payment] = await fixture.db.select().from(s.payments);
    await expectNeverCredited({ ...fixture, payment: payment! }, 'can no longer be read');
  });

  it('still credits a matching confirmation that was sent to review for another reason', async () => {
    const { db, merchant, payment } = await confirmedThroughWebhook({ amount: 10000 });
    await db
      .update(s.payments)
      .set({ reviewRequired: true, reviewNote: 'Flagged by risk', autoCreditAt: null })
      .where(eq(s.payments.id, payment.id));
    const admin = await adminWith(t, ['payments:approve']);
    expect((await admin.post(`/admin/payments/${payment.id}/approve`)).status).toBe(200);
    expect((await journalOf(db, payment.id))!.lines).toEqual({
      gateway_clearing: '100.0000',
      client_wallet: '-97.0000',
      fee_income: '-3.0000',
    });
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('97.0000');
  });
});

describe('POST /admin/payments/:id/reject', () => {
  it('rejects with the reason, voids a top-up invoice and posts nothing', async () => {
    const { db, invoice, payment } = await world('manual');
    const admin = await adminWith(t, ['payments:approve', 'payments:read'], { name: 'Omar T.' });
    const empty = await admin.post(`/admin/payments/${payment.id}/reject`, { reason: '  ' });
    expect(empty.status).toBe(422);
    expect(empty.body.errors[0].field).toBe('reason');
    const res = await admin.post(`/admin/payments/${payment.id}/reject`, {
      reason: 'Receipt unreadable. Please upload again.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'rejected',
      note: 'Receipt unreadable. Please upload again.',
      reviewedBy: { name: 'Omar T.' },
      capturedAt: null,
    });
    expect((await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id)))[0]!.status).toBe('void');
    expect(await journalOf(db, payment.id)).toBeUndefined();
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'rejected deposit of'));
    expect(audit!.after).toMatchObject({ reason: 'Receipt unreadable. Please upload again.' });
    const again = await admin.post(`/admin/payments/${payment.id}/reject`, { reason: 'Again' });
    expect(again.body.code).toBe('PAYMENT_ALREADY_REVIEWED');
  });

  it('leaves a staff-issued manual invoice open so the merchant can upload another receipt', async () => {
    const { db, merchant, gatewayId } = await world('manual');
    const manualInvoice = await insertInvoiceRow(db, merchant.id, {
      kind: 'manual',
      gatewayId,
      description: 'Support',
    });
    const payment = await insertPendingPayment(db, manualInvoice, gatewayId);
    const admin = await adminWith(t, ['payments:approve']);
    expect((await admin.post(`/admin/payments/${payment.id}/reject`, { reason: 'Wrong amount' })).status).toBe(200);
    expect((await db.select().from(s.invoices).where(eq(s.invoices.id, manualInvoice.id)))[0]!.status).toBe('open');
  });
});

describe('GET /admin/payments', () => {
  it('lists top-ups only, with the merchant, group, gateway, hints and the filters of the Deposits tab', async () => {
    const first = await world('manual');
    const admin = await adminWith(t, ['payments:read', 'payments:approve']);
    const second = await world('manual');
    clock.advance(60_000);
    await admin.post(`/admin/payments/${second.payment.id}/approve`);
    await first.db.insert(s.payments).values({
      purpose: 'order',
      gatewayId: first.gatewayId,
      amount: '10.0000',
      currency: 'USD',
      status: 'captured',
      methodType: 'card',
    });

    const all = await admin.get('/admin/payments?purpose=topup&_start=0&_end=25&_sort=createdAt&_order=desc');
    expect(all.status).toBe(200);
    expect(all.total).toBe(2);
    expect(all.body.every((row: { purpose: string }) => row.purpose === 'topup')).toBe(true);
    const pending = (await admin.get('/admin/payments?status=pending')).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: first.payment.id,
      status: 'pending',
      reviewedBy: null,
      note: 'First deposit of this merchant.',
    });
    expect(pending[0].client.group).toMatch(/^Group /);
    expect((await admin.get('/admin/payments?status=approved')).body[0].reviewedBy.name).toBe('Test Staff');
    expect((await admin.get('/admin/payments?purpose=order')).total).toBe(0);
    expect((await admin.get('/admin/payments?q=TRX-1')).total).toBe(2);
    expect((await admin.get(`/admin/payments?clientId=${first.merchant.id}`)).total).toBe(1);
    expect((await admin.get('/admin/payments?_sort=amount&_order=asc')).status).toBe(200);
    expect((await admin.get('/admin/payments?_sort=nope')).status).toBe(422);
  });

  it('shows an automatic credit as System and says when a waiting payment credits itself', async () => {
    const { db, payment } = await world('automatic', {
      autoCreditAt: new Date('2026-11-01T10:10:00.000Z'),
      capturedAt: clock.now(),
    });
    const admin = await adminWith(t, ['payments:read']);
    expect((await admin.get(`/admin/payments/${payment.id}`)).body.note).toBe(
      'Credited automatically after the gateway check at 2026-11-01T10:10:00.000Z',
    );
    await db
      .update(s.payments)
      .set({ status: 'approved', reviewedAt: new Date('2026-11-01T10:12:00.000Z') })
      .where(eq(s.payments.id, payment.id));
    expect((await admin.get(`/admin/payments/${payment.id}`)).body.reviewedBy).toEqual({ id: null, name: 'System' });
  });
});
