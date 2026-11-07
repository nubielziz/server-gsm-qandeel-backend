// Integration tests of the automatic credit of confirmed top-ups (user rule 6, RESOLUTIONS money-3): the wait, the second look at
// the gateway, the credit from gateway_clearing, the payments that go to staff, a gateway that is slow or down, a flagged payment,
// and the guarantee that two runs (or a run and a staff decision) credit once.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { JobRunsService } from '../../src/modules/health';
import { PaymentAutoCredit, PaymentAutoCreditModule } from '../../src/modules/money';
import { PaymentAutoCreditProcessor } from '../../src/modules/money/jobs/payment-auto-credit.processor';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  insertInvoiceRow,
  postWebhook,
  signedHeaders,
} from '../support/billing';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { accountFigures, insertWalletMerchant } from '../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
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
  clock.set('2026-11-01T10:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
});

/** Confirms a payment of 100 (fee 3.2) through the webhook, as the gateway would, and returns it. */
async function confirmed(gatewayOverrides: Record<string, unknown> = {}, reference = `pi_${crypto.randomUUID()}`) {
  const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  const gatewayId = await insertGateway(t, db, {
    code: 'card',
    name: 'Card gateway',
    driver: 'card',
    apiBase: fake.url,
    ...gatewayOverrides,
  });
  const invoice = await insertInvoiceRow(db, merchant.id, { amount: '100.0000', fee: '3.2000', gatewayId });
  const body = cardEvent(`evt_${crypto.randomUUID()}`, invoice.number, { reference, amount: 10000 });
  expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);
  const [payment] = await db.select().from(s.payments);
  return { merchant, gatewayId, invoice, payment: payment!, reference };
}

const reload = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const tick = async () => job.run(await job.due());

describe('PaymentAutoCredit', () => {
  it('credits the wallet 10 minutes after the confirmation, once the gateway says confirmed again', async () => {
    const { merchant, invoice, payment, reference } = await confirmed();
    clock.advance(9 * MINUTE + 59_000);
    expect(await job.due()).toEqual([]);
    clock.advance(1_000);
    expect(await job.due()).toEqual([payment.id]);

    expect(await tick()).toMatchObject({ checked: 1, credited: 1, review: 0, deferred: 0, failed: 0 });
    // The job asked the gateway about the payment before it credited, with the API credential.
    const asked = fake.requests.find((request) => request.method === 'GET');
    expect(asked).toMatchObject({ path: `/v1/payment_intents/${reference}` });
    expect(asked!.headers.authorization).toBe('Bearer sk_test_gateway_secret_1234');

    const done = await reload(payment.id);
    expect(done).toMatchObject({ status: 'approved', reviewedBy: null, autoCreditAt: null });
    expect(done.reviewedAt!.toISOString()).toBe('2026-11-01T10:10:00.000Z');
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('96.8000');
    expect((await accountFigures(db, 'gateway_clearing'))!.balance).toBe('100.0000');
    expect((await accountFigures(db, 'fee_income'))!.balance).toBe('3.2000');
    expect(await accountFigures(db, 'bank')).toBeUndefined();
    const [row] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id));
    expect(row!.status).toBe('paid');
    expect(row!.paidAt!.toISOString()).toBe('2026-11-01T10:10:00.000Z');
    const events = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'invoice.paid'));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ invoiceId: invoice.id, clientId: merchant.id });
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'credited deposit of'));
    expect(audit).toMatchObject({ actorType: 'system', entityType: 'payment', entityId: payment.id });
    const [journal] = await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.refId, payment.id));
    expect(journal).toMatchObject({
      kind: 'deposit',
      createdByType: 'system',
      idempotencyKey: `deposit:payment:${payment.id}`,
    });

    // The console shows the automatic credit as System, and a staff decision afterwards finds it done.
    const admin = await adminWith(t, ['payments:read', 'payments:approve']);
    expect((await admin.get(`/admin/payments/${payment.id}`)).body.reviewedBy).toEqual({ id: null, name: 'System' });
    expect((await admin.post(`/admin/payments/${payment.id}/approve`)).body.code).toBe('PAYMENT_ALREADY_REVIEWED');
    // A later tick finds nothing to do.
    expect(await job.due()).toEqual([]);
  });

  it('credits once when two runs overlap', async () => {
    const { merchant, payment } = await confirmed();
    clock.advance(11 * MINUTE);
    const ids = await job.due();
    const [one, two] = await Promise.all([job.run(ids), job.run(ids)]);
    expect(one.credited + two.credited).toBe(1);
    expect(one.failed + two.failed).toBe(0);
    expect(await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.refId, payment.id))).toHaveLength(
      1,
    );
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('96.8000');
  });

  it('leaves a payment that risk flagged after the tick listed it, so a racing staff approval credits it once', async () => {
    const { merchant, payment } = await confirmed();
    clock.advance(11 * MINUTE);
    const ids = await job.due();
    expect(ids).toEqual([payment.id]);
    await db.update(s.payments).set({ reviewRequired: true }).where(eq(s.payments.id, payment.id));
    const admin = await adminWith(t, ['payments:read', 'payments:approve']);
    const [summary, approved] = await Promise.all([job.run(ids), admin.post(`/admin/payments/${payment.id}/approve`)]);
    expect(summary).toMatchObject({ credited: 0, skipped: 1, failed: 0 });
    expect(approved.status).toBe(200);
    expect(await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.refId, payment.id))).toHaveLength(
      1,
    );
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('96.8000');
    expect((await reload(payment.id)).reviewedBy).not.toBeNull();
  });

  it('refuses a staff approval that arrives while the job credits, and posts once', async () => {
    const { merchant, payment } = await confirmed();
    clock.advance(11 * MINUTE);
    const ids = await job.due();
    const admin = await adminWith(t, ['payments:read', 'payments:approve']);
    const [summary, approved] = await Promise.all([job.run(ids), admin.post(`/admin/payments/${payment.id}/approve`)]);
    expect(summary).toMatchObject({ credited: 1, failed: 0 });
    // The approval either looked first (the payment still waits for the job) or after the job's commit (it is done).
    expect(approved.status).toBe(409);
    expect(['PAYMENT_AUTO_CREDIT_PENDING', 'PAYMENT_ALREADY_REVIEWED']).toContain(approved.body.code);
    expect(await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.refId, payment.id))).toHaveLength(
      1,
    );
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('96.8000');
    expect((await reload(payment.id)).reviewedBy).toBeNull();
  });

  it('never credits a due payment whose stored gateway event says another amount was paid, and sends it to staff', async () => {
    const { merchant, payment, invoice, reference } = await confirmed();
    // The row still says 100 (the invoice) and is due, but the event the gateway sent says 50 was paid.
    const less = JSON.parse(cardEvent(`evt_${crypto.randomUUID()}`, invoice.number, { reference, amount: 5000 }));
    await db.update(s.payments).set({ raw: less }).where(eq(s.payments.id, payment.id));
    clock.advance(11 * MINUTE);
    expect(await tick()).toMatchObject({ checked: 1, credited: 0, review: 1, failed: 0 });
    const flagged = await reload(payment.id);
    expect(flagged).toMatchObject({ status: 'pending', reviewRequired: true, autoCreditAt: null });
    expect(flagged.reviewNote).toContain('The gateway reports 50.0000 paid; the invoice is 100.0000.');
    expect(await db.select().from(s.ledgerTransactions)).toHaveLength(0);
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('0.0000');
  });

  it('sends a payment to staff when the gateway no longer confirms it, and staff can then approve it from gateway_clearing', async () => {
    const { merchant, payment, reference } = await confirmed();
    fake.status.set(reference, { status: 'canceled' });
    clock.advance(11 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 0, review: 1 });
    const flagged = await reload(payment.id);
    expect(flagged).toMatchObject({ status: 'pending', reviewRequired: true, autoCreditAt: null });
    expect(flagged.reviewNote).toBe('The gateway no longer reports this payment as confirmed.');
    expect(await db.select().from(s.ledgerTransactions)).toHaveLength(0);
    expect(await job.due()).toEqual([]);

    const admin = await adminWith(t, ['payments:read', 'payments:approve']);
    expect((await admin.get(`/admin/payments/${payment.id}`)).body.note).toBe(
      'The gateway no longer reports this payment as confirmed.',
    );
    const approved = await admin.post(`/admin/payments/${payment.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.client.walletBalance).toBe('96.8000');
    expect((await accountFigures(db, 'gateway_clearing'))!.balance).toBe('100.0000');
    expect(merchant.id).toBeGreaterThan(0);
  });

  it('asks again in 5 minutes while the gateway has not confirmed, and after a day sends the payment to staff', async () => {
    const { payment, reference } = await confirmed();
    fake.status.set(reference, { status: 'processing' });
    clock.advance(11 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 0, deferred: 1 });
    expect((await reload(payment.id)).autoCreditAt!.getTime()).toBe(clock.nowMs() + 5 * MINUTE);
    expect(await job.due()).toEqual([]);
    clock.advance(5 * MINUTE);
    expect(await job.due()).toEqual([payment.id]);

    clock.advance(24 * HOUR);
    expect(await tick()).toMatchObject({ review: 1 });
    expect((await reload(payment.id)).reviewNote).toBe('The gateway has not confirmed this payment after 24 hours.');
  });

  it('treats a gateway that cannot be reached as not confirmed yet and credits on the next try', async () => {
    const { payment } = await confirmed();
    fake.failWith = 503;
    clock.advance(11 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 0, deferred: 1, failed: 0 });
    expect((await reload(payment.id)).status).toBe('pending');
    fake.failWith = undefined;
    clock.advance(5 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 1 });
    expect((await reload(payment.id)).status).toBe('approved');
  });

  it('waits the gateway hold hours instead of 10 minutes and leaves a flagged payment alone', async () => {
    const held = await confirmed({ holdHours: 3 });
    clock.advance(2 * HOUR + 59 * MINUTE);
    expect(await job.due()).toEqual([]);
    clock.advance(2 * MINUTE);
    expect(await job.due()).toEqual([held.payment.id]);
    // Risk flags it before the job runs: it is no longer due and nothing is credited.
    await db.update(s.payments).set({ reviewRequired: true }).where(eq(s.payments.id, held.payment.id));
    expect(await job.due()).toEqual([]);
    expect(await tick()).toMatchObject({ checked: 0, credited: 0 });
    expect((await reload(held.payment.id)).status).toBe('pending');
  });

  it('sends a payment to staff when its invoice is no longer open', async () => {
    const { invoice, payment } = await confirmed();
    await db.update(s.invoices).set({ status: 'void' }).where(eq(s.invoices.id, invoice.id));
    clock.advance(11 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 0, review: 1 });
    expect((await reload(payment.id)).reviewNote).toBe(`The invoice of PAY-${payment.id} is already void.`);
  });

  it('credits a crypto payment only when the gateway reports the required confirmations', async () => {
    const merchant = await insertWalletMerchant(db);
    const gatewayId = await insertGateway(t, db, { code: 'crypto', driver: 'crypto', apiBase: fake.url });
    const invoice = await insertInvoiceRow(db, merchant.id, { gatewayId, amount: '100.0000', fee: '1.0000' });
    const body = JSON.stringify({
      id: 'evt_c1',
      type: 'invoice.confirmed',
      data: {
        id: 'cinv_9',
        reference: invoice.number,
        amount: '100.00',
        currency: 'USD',
        confirmations: 3,
        requiredConfirmations: 3,
      },
    });
    await postWebhook(t, 'crypto', body, signedHeaders(WEBHOOK_KEY, body, clock, 'x-gsm-signature'));
    fake.status.set('cinv_9', { status: 'confirmed', confirmations: 1, requiredConfirmations: 3 });
    clock.advance(11 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 0, deferred: 1 });
    fake.status.set('cinv_9', { status: 'confirmed', confirmations: 3, requiredConfirmations: 3 });
    clock.advance(5 * MINUTE);
    expect(await tick()).toMatchObject({ credited: 1 });
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))!.balance).toBe('99.0000');
  });
});

describe('PaymentAutoCreditProcessor', () => {
  it('records a job run only for a tick that handled payments, and always for a manual run', async () => {
    const processor = t.app.get(PaymentAutoCreditProcessor, { strict: false });
    const runs = t.app.get(JobRunsService, { strict: false });
    const job$ = (data: { runId?: number }) => ({ data }) as never;
    expect(await processor.process(job$({}))).toMatchObject({ checked: 0 });
    expect(await db.select().from(s.jobRuns)).toHaveLength(0);

    const { payment } = await confirmed();
    clock.advance(11 * MINUTE);
    expect(await processor.process(job$({}))).toMatchObject({ checked: 1, credited: 1 });
    const [run] = await db.select().from(s.jobRuns);
    expect(run).toMatchObject({ job: 'payment_auto_credit', trigger: 'schedule', status: 'succeeded', processed: 1 });
    expect(run!.result).toMatchObject({ credited: 1 });

    const manual = await runs.start({ job: 'payment_auto_credit', trigger: 'manual', overlap: 'refuse' });
    await processor.process(job$({ runId: manual.id }));
    expect((await db.select().from(s.jobRuns).where(eq(s.jobRuns.id, manual.id)))[0]).toMatchObject({
      status: 'succeeded',
      processed: 0,
    });
    expect(payment.id).toBeGreaterThan(0);
  });
});
