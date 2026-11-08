// Integration tests of the storefront refunds (feature 16, scenario b2c-refund, RESOLUTIONS money-4, money-11, money-12, user rule 7):
// the list and the read, approve (delivered, not delivered, partial, crypto), decline, retry, the gateway job and its events, the refund the
// system opens when a paid order is rejected, concurrency and the refusals.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { type Database, schema as s } from '../../src/infra/db';
import { UnrecoverableError } from '../../src/infra/queues';
import { RefundProcessModule, RefundSender } from '../../src/modules/money';
import { OrderSupplierMoves } from '../../src/modules/orders';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { GatewayTestModule } from '../support/billing';
import {
  type B2cWorld,
  B2cGateway,
  type PaidOrder,
  b2cWorld,
  hook,
  json,
  openCheckout,
  paidOrder,
  pay,
  refundEvent,
  storefrontEvent,
} from '../support/b2c';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { eventually } from '../support/infra';
import { ledgerTotals } from '../support/money';
import { rejectionOf } from '../support/rejection';
import { auditOf, eventsOf, ledgerOf, orderRow, outboxOf, systemBalance } from '../support/orders';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;
let sender: RefundSender;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, RefundProcessModule] });
  sender = t.app.get(RefundSender, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
  staff = await adminWith(t, ['refunds:*', 'orders:*', 'disputes:*'], { name: 'Layla Haddad' });
});

/** A storefront order that was paid (GBP 3.84, USD 4.79) and, when asked, delivered by a staff reply. */
async function order(options: { deliver?: boolean; email?: string } = {}): Promise<PaidOrder> {
  const paid = await paidOrder(t, clock, world, options.email === undefined ? {} : { email: options.email });
  if (options.deliver) {
    expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
  }
  return paid;
}

/** Inserts a refund request of a customer (the customer's own request route belongs to the support feature). */
async function request(paid: PaidOrder, values: Partial<typeof s.refunds.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.refunds)
    .values({
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      customerId: (await orderRow(db, paid.orderId)).customerId!,
      amount: paid.charged,
      currency: 'GBP',
      reason: 'The code did not work',
      method: 'original',
      status: 'requested',
      requestedByType: 'customer',
      requestedById: (await orderRow(db, paid.orderId)).customerId!,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...values,
    })
    .returning();
  return row!;
}

const refundRow = async (id: number) => (await db.select().from(s.refunds).where(eq(s.refunds.id, id)))[0]!;
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const refundOutbox = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'));

describe('GET /admin/refunds and /admin/refunds/:id', () => {
  it('lists storefront refunds with the customer, the order and the payment joined', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    const res = await staff.get('/admin/refunds');
    expect(res.status).toBe(200);
    expect(res.total).toBe(1);
    expect(res.body[0]).toEqual({
      id: refund.id,
      orderId: paid.orderId,
      amount: '4.7900',
      reason: 'The code did not work',
      status: 'requested',
      method: 'original',
      currency: 'GBP',
      fx: '0.80185000',
      partial: false,
      gatewayRefundId: null,
      note: null,
      requestedBy: { type: 'customer', name: null },
      approvedBy: null,
      customer: { id: expect.any(Number), name: 'sam@mail.example' },
      order: { id: paid.orderId, deliveredAt: '2026-11-07T12:00:00.000Z', cost: '0.0800' },
      payment: { id: paid.paymentId, method: 'card', brand: 'Visa •••• 4242', amount: '4.7900', taxAmount: '0.8000' },
      netAmount: null,
      taxAmount: null,
      completedAt: null,
      createdAt: '2026-11-07T12:00:00.000Z',
    });
    const one = await staff.get(`/admin/refunds/${refund.id}`);
    expect(one.body).toEqual(res.body[0]);
    expect((await staff.get('/admin/refunds/999999')).status).toBe(404);
  });

  it('filters by status, sorts, searches and pages with the exact total; merchant refunds never show', async () => {
    const paid = await order();
    const open = await request(paid);
    await request(paid, {
      status: 'rejected',
      note: 'No.',
      reason: 'Changed my mind',
      amount: '1.0000',
      createdAt: new Date('2026-11-06T12:00:00.000Z'),
    });
    await db.insert(s.refunds).values({
      amount: '5.0000',
      currency: 'USD',
      method: 'original',
      status: 'requested',
      requestedByType: 'system',
    });
    expect((await staff.get('/admin/refunds')).total).toBe(2);
    expect((await staff.get('/admin/refunds?status=requested')).body.map((row: { id: number }) => row.id)).toEqual([
      open.id,
    ]);
    expect(
      (await staff.get('/admin/refunds?_sort=amount&_order=asc')).body.map((row: { amount: string }) => row.amount),
    ).toEqual(['1.2471', '4.7900']);
    expect((await staff.get('/admin/refunds?q=sam@')).total).toBe(2);
    expect((await staff.get('/admin/refunds?q=did+not+work')).total).toBe(1);
    expect((await staff.get(`/admin/refunds?q=${open.id}`)).body[0].id).toBe(open.id);
    const page = await staff.get('/admin/refunds?_start=0&_end=1');
    expect(page.body).toHaveLength(1);
    expect(page.total).toBe(2);
    expect((await staff.get('/admin/refunds?status=bogus')).status).toBe(422);
  });

  it('needs the refunds:read permission', async () => {
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.get('/admin/refunds')).status).toBe(403);
    const reader = await adminWith(t, ['refunds:read']);
    expect((await reader.get('/admin/refunds')).status).toBe(200);
    const paid = await order();
    const refund = await request(paid);
    expect((await reader.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(403);
  });
});

describe('POST /admin/refunds/:id/approve', () => {
  it('a delivered order: reverses the revenue and the VAT, keeps the order, queues the gateway call', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    const res = await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'processing',
      method: 'original',
      amount: '4.7900',
      netAmount: '3.9900',
      taxAmount: '0.8000',
      approvedBy: { id: staff.staffId, name: 'Layla Haddad' },
      partial: false,
      completedAt: null,
    });
    const row = await refundRow(refund.id);
    expect(row).toMatchObject({
      status: 'processing',
      amount: '3.8400',
      approvedBy: staff.staffId,
      ledgerTxId: expect.any(Number),
    });
    // Dr revenue 3.99, Dr vat_payable 0.80, Cr gateway_clearing 4.79: customer funds became revenue at delivery, so revenue goes back.
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect((await ledgerOf(db, paid.orderId)).at(-1)).toEqual({ kind: 'refund', key: `refund:${refund.id}` });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // The order stays delivered; the payment stays captured until the gateway answers.
    expect((await orderRow(db, paid.orderId)).status).toBe('completed');
    expect((await paymentRow(paid.paymentId)).status).toBe('captured');
    expect(await refundOutbox()).toHaveLength(1);
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'refund',
      data: expect.objectContaining({ message: 'Refund of $4.79 sent to the original payment method' }),
    });
    expect(await auditOf(db, paid.orderId)).toBeDefined();
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'refund'));
    expect(audit).toMatchObject({
      action: 'approved refund',
      entityId: refund.id,
      entityLabel: `RF-${refund.id} for SF-${paid.orderId}, $4.79`,
    });
  });

  it('the gateway job sends it once with an idempotency key and completes it; the payment becomes refunded', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    expect(await sender.send(refund.id, false)).toBe('completed');
    const call = fake.calls('/v1/refunds')[0]!;
    const form = new URLSearchParams(call.body);
    expect(form.get('payment_intent')).toBe(paid.intent);
    expect(form.get('amount')).toBe('384');
    expect(form.get('metadata[refund_id]')).toBe(String(refund.id));
    expect(call.headers['idempotency-key']).toBe(`refund-${refund.id}`);
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'completed',
      gatewayRefundId: expect.stringMatching(/^re_/),
    });
    expect((await refundRow(refund.id)).completedAt).not.toBeNull();
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    // A second run (a retried job) sends nothing.
    expect(await sender.send(refund.id, false)).toBe('skipped');
    expect(fake.calls('/v1/refunds')).toHaveLength(1);
    const shown = await staff.get(`/admin/refunds/${refund.id}`);
    expect(shown.body).toMatchObject({ status: 'completed', completedAt: '2026-11-07T12:00:00.000Z' });
    const report = await staff.get('/admin/reports/payments');
    expect(report.status).toBe(403);
  });

  it('a partial refund takes its VAT share; the rest can still go back, and the last one leaves nothing behind', async () => {
    const paid = await order({ deliver: true });
    const first = await request(paid, { amount: '0.8000' });
    const res = await staff.post(`/admin/refunds/${first.id}/approve`, { amount: '1.00' });
    expect(res.status).toBe(200);
    // 1.00 USD is 0.80 GBP, which is 0.9977 USD again: that is what goes back. VAT share round(0.80 x 0.9977 / 4.79, 2) = 0.17.
    expect(res.body).toMatchObject({ amount: '0.9977', netAmount: '0.8277', taxAmount: '0.1700', partial: true });
    await sender.send(first.id, false);
    expect((await paymentRow(paid.paymentId)).status).toBe('partial_refund');

    const tooMuch = await request(paid, { amount: '3.0400' });
    const refused = await staff.post(`/admin/refunds/${tooMuch.id}/approve`, { amount: '4.00' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({
      field: 'amount',
      message: 'Enter an amount between $0.01 and $3.7923.',
    });

    const rest = await request(paid, { amount: '3.0400' });
    const closing = await staff.post(`/admin/refunds/${rest.id}/approve`, { amount: '3.7923' });
    expect(closing.status).toBe(200);
    // The refund that takes everything left takes exactly the USD and the VAT that are left.
    expect(closing.body).toMatchObject({ amount: '3.7923', netAmount: '3.1623', taxAmount: '0.6300' });
    await sender.send(rest.id, false);
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // Nothing is left to refund.
    const more = await request(paid, { amount: '0.0100' });
    expect((await staff.post(`/admin/refunds/${more.id}/approve`, {})).status).toBe(422);
  });

  it('an order that was not delivered is cancelled and refunded in full from customer funds', async () => {
    const paid = await order();
    const refund = await request(paid);
    const res = await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'processing',
      amount: '4.7900',
      netAmount: '3.9900',
      taxAmount: '0.8000',
    });
    expect((await orderRow(db, paid.orderId)).status).toBe('rejected');
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect((await ledgerOf(db, paid.orderId)).filter((entry) => entry.kind === 'refund')).toEqual([
      { kind: 'refund', key: `refund:${refund.id}` },
    ]);
    expect((await eventsOf(db, paid.orderId)).slice(-2).map((event) => event.type)).toEqual(['rejected', 'refund']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // The refund row was updated, not duplicated: the order's rejection opened no second refund.
    expect(await db.select().from(s.refunds)).toHaveLength(1);
    expect(await refundOutbox()).toHaveLength(1);
  });

  it('an order that was not delivered is refunded in full: a part is refused', async () => {
    const paid = await order();
    const refund = await request(paid);
    const res = await staff.post(`/admin/refunds/${refund.id}/approve`, { amount: '1.00' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'amount' });
    expect((await orderRow(db, paid.orderId)).status).toBe('pending');
    expect((await ledgerTotals(db)).transactions).toBe(2);
  });

  it('a crypto payment is paid out by hand: manual, completed at once, no gateway call', async () => {
    const paid = await order({ deliver: true });
    await db
      .update(s.payments)
      .set({ methodType: 'crypto', brand: 'USDT TRC-20' })
      .where(eq(s.payments.id, paid.paymentId));
    const refund = await request(paid);
    const res = await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'completed',
      method: 'manual',
      note: 'Crypto payments cannot be refunded by the gateway. Paid out manually from the treasury wallet.',
      payment: expect.objectContaining({ method: 'crypto', brand: 'USDT TRC-20' }),
    });
    expect(res.body.completedAt).not.toBeNull();
    expect(fake.calls('/v1/refunds')).toHaveLength(0);
    expect(await refundOutbox()).toHaveLength(0);
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
  });

  it('refuses a refund that is decided, an amount that is not valid, and a payment in dispute', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    for (const amount of ['0', '-1', 'abc', '4.80']) {
      const bad = await staff.post(`/admin/refunds/${refund.id}/approve`, { amount });
      expect(bad.status).toBe(422);
      expect(bad.body.errors[0]).toMatchObject({
        field: 'amount',
        message: 'Enter an amount between $0.01 and $4.79.',
      });
    }
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(200);
    const again = await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'REFUND_NOT_PENDING' });
    expect((await staff.post('/admin/refunds/999999/approve', {})).status).toBe(404);

    const other = await order({ deliver: true, email: 'ann@mail.example' });
    const disputed = await request(other);
    await db.update(s.payments).set({ status: 'disputed' }).where(eq(s.payments.id, other.paymentId));
    const blocked = await staff.post(`/admin/refunds/${disputed.id}/approve`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('two approvals at once refund once', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    const answers = await Promise.all([
      staff.post(`/admin/refunds/${refund.id}/approve`, {}),
      staff.post(`/admin/refunds/${refund.id}/approve`, {}),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect((await ledgerOf(db, paid.orderId)).filter((entry) => entry.kind === 'refund')).toHaveLength(1);
    expect(await refundOutbox()).toHaveLength(1);
  });
});

describe('POST /admin/refunds/:id/decline', () => {
  it('rejects the request with the reason the customer reads, on the timeline and in the audit log', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    const short = await staff.post(`/admin/refunds/${refund.id}/decline`, { reason: 'No' });
    expect(short.status).toBe(422);
    expect(short.body.errors[0]).toMatchObject({
      field: 'reason',
      message: 'Give the customer a reason, at least a sentence.',
    });
    const res = await staff.post(`/admin/refunds/${refund.id}/decline`, {
      reason: 'The code was delivered and works.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'rejected',
      note: 'The code was delivered and works.',
      approvedBy: { id: staff.staffId, name: 'Layla Haddad' },
    });
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'refund',
      data: expect.objectContaining({ message: 'Refund request declined: The code was delivered and works.' }),
    });
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'declined refund'));
    expect(audit).toMatchObject({ entityType: 'refund', entityId: refund.id });
    expect((await ledgerTotals(db)).transactions).toBe(3);
    const again = await staff.post(`/admin/refunds/${refund.id}/decline`, { reason: 'Still a sentence here.' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'REFUND_NOT_PENDING' });
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(409);
  });
});

describe('the gateway answer and POST /admin/refunds/:id/retry', () => {
  it('a refusal fails the refund with the gateway text; a retry sends it again and posts nothing', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    fake.refund = { status: 'failed', failure: 'charge_already_refunded' };
    expect(await sender.send(refund.id, false)).toBe('failed');
    const failed = await staff.get(`/admin/refunds/${refund.id}`);
    expect(failed.body).toMatchObject({ status: 'failed', note: 'charge_already_refunded' });
    expect((await paymentRow(paid.paymentId)).status).toBe('captured');

    const notFailed = await request(paid, { amount: '0.5000' });
    const refusedRetry = await staff.post(`/admin/refunds/${notFailed.id}/retry`, {});
    expect(refusedRetry.status).toBe(409);
    expect(refusedRetry.body).toMatchObject({ code: 'REFUND_NOT_FAILED' });

    const journals = (await ledgerTotals(db)).transactions;
    fake.refund = { status: 'succeeded' };
    const retried = await staff.post(`/admin/refunds/${refund.id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'processing', note: null });
    expect(await refundOutbox()).toHaveLength(2);
    expect(await sender.send(refund.id, false)).toBe('completed');
    expect((await ledgerTotals(db)).transactions).toBe(journals);
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    // The gateway refused the first call for good (a failed refund object): the retry sends under a new key, not the one it refused.
    expect(fake.calls('/v1/refunds').map((call) => call.headers['idempotency-key'])).toEqual([
      `refund-${refund.id}`,
      `refund-${refund.id}-2`,
    ]);
  });

  it('a failed refund still counts as taken: a second approval cannot post the same money again, the retry refunds once (under a new key)', async () => {
    const paid = await order({ deliver: true });
    const first = await request(paid);
    expect((await staff.post(`/admin/refunds/${first.id}/approve`, {})).status).toBe(200);
    fake.refund = { status: 'failed', failure: 'charge_already_refunded' };
    expect(await sender.send(first.id, false)).toBe('failed');
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    const journals = (await ledgerTotals(db)).transactions;

    // Staff open another request for the same payment: everything is already promised by the failed refund.
    const second = await request(paid);
    const refused = await staff.post(`/admin/refunds/${second.id}/approve`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({
      field: 'amount',
      message: 'Nothing is left to refund on this payment.',
    });
    expect((await refundRow(second.id)).status).toBe('requested');
    expect((await ledgerTotals(db)).transactions).toBe(journals);
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');

    // The way out is the retry of the failed one: one more gateway call under the same key, and no second posting.
    fake.refund = { status: 'succeeded' };
    expect((await staff.post(`/admin/refunds/${first.id}/retry`, {})).status).toBe(200);
    expect(await sender.send(first.id, false)).toBe('completed');
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    expect((await ledgerTotals(db)).transactions).toBe(journals);
    expect(fake.calls('/v1/refunds').map((call) => call.headers['idempotency-key'])).toEqual([
      `refund-${first.id}`,
      `refund-${first.id}-2`,
    ]);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('a failed partial refund keeps its share: the next approval can take only what is left after it', async () => {
    const paid = await order({ deliver: true });
    const first = await request(paid, { amount: '0.8000' });
    expect((await staff.post(`/admin/refunds/${first.id}/approve`, { amount: '1.00' })).status).toBe(200);
    fake.refund = { status: 'failed', failure: 'insufficient_funds' };
    expect(await sender.send(first.id, false)).toBe('failed');

    const second = await request(paid, { amount: '3.0400' });
    const tooMuch = await staff.post(`/admin/refunds/${second.id}/approve`, { amount: '4.00' });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.errors[0]).toMatchObject({ message: 'Enter an amount between $0.01 and $3.7923.' });
    const rest = await staff.post(`/admin/refunds/${second.id}/approve`, { amount: '3.7923' });
    expect(rest.status).toBe(200);
    expect(rest.body).toMatchObject({ amount: '3.7923', netAmount: '3.1623', taxAmount: '0.6300' });
    // Together the two refunds reverse exactly what was paid, once.
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
  });

  it('a gateway that is down is retried by the queue and fails the refund on the last attempt', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    fake.failWith = 500;
    expect(await rejectionOf(sender.send(refund.id, false))).toMatchObject({ code: 'GATEWAY_ERROR' });
    expect((await refundRow(refund.id)).status).toBe('processing');
    expect(await sender.send(refund.id, true)).toBe('failed');
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', note: expect.stringContaining('500') });
  });

  it('a permanent refusal (4xx) fails the refund at once and stops the queue; the staff retry sends under a new key, once', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    fake.failWith = 403;
    const refused = await rejectionOf(sender.send(refund.id, false));
    expect(refused).toBeInstanceOf(UnrecoverableError);
    expect((refused as Error).message).toContain('403');
    // One call, no queue retry, and the refund is failed with the gateway's text on the first attempt (not only on the last).
    expect(fake.calls('/v1/refunds')).toHaveLength(1);
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'failed',
      note: expect.stringContaining('403'),
      sendAttempt: 2,
    });
    const journals = (await ledgerTotals(db)).transactions;

    fake.failWith = undefined;
    expect((await staff.post(`/admin/refunds/${refund.id}/retry`, {})).status).toBe(200);
    expect(await sender.send(refund.id, false)).toBe('completed');
    expect(fake.calls('/v1/refunds').map((call) => call.headers['idempotency-key'])).toEqual([
      `refund-${refund.id}`,
      `refund-${refund.id}-2`,
    ]);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'completed', sendAttempt: 2 });
    expect((await ledgerTotals(db)).transactions).toBe(journals);
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
  });

  it('a 4xx that only says "not now" (429) is retried by the queue under the same key', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    fake.failWith = 429;
    const slow = await rejectionOf(sender.send(refund.id, false));
    expect(slow).not.toBeInstanceOf(UnrecoverableError);
    expect(slow).toMatchObject({ code: 'GATEWAY_ERROR' });
    expect(await refundRow(refund.id)).toMatchObject({ status: 'processing', sendAttempt: 1 });
    fake.failWith = undefined;
    expect(await sender.send(refund.id, false)).toBe('completed');
    expect(fake.calls('/v1/refunds').map((call) => call.headers['idempotency-key'])).toEqual([
      `refund-${refund.id}`,
      `refund-${refund.id}`,
    ]);
  });

  it('an unknown outcome (5xx) keeps the key all the way: the queue retries and the staff retry send the same one, so the gateway refunds once', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    fake.failWith = 503;
    expect(await rejectionOf(sender.send(refund.id, false))).toMatchObject({ code: 'GATEWAY_ERROR' });
    expect(await sender.send(refund.id, true)).toBe('failed');
    // Failed on its last attempt, but the gateway may have made the refund: the key does not move.
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', sendAttempt: 1 });

    fake.failWith = undefined;
    expect((await staff.post(`/admin/refunds/${refund.id}/retry`, {})).status).toBe(200);
    expect(await sender.send(refund.id, false)).toBe('completed');
    expect(fake.calls('/v1/refunds').map((call) => call.headers['idempotency-key'])).toEqual([
      `refund-${refund.id}`,
      `refund-${refund.id}`,
      `refund-${refund.id}`,
    ]);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'completed', sendAttempt: 1 });
  });

  it('a pending answer waits for the refund.succeeded event, which completes it once', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const stored = await refundRow(refund.id);
    const gatewayRefundId = stored.gatewayRefundId!;
    expect(gatewayRefundId).toMatch(/^re_/);
    expect(stored.status).toBe('processing');
    const body = refundEvent(`evt_${crypto.randomUUID()}`, { refund: gatewayRefundId, refundId: refund.id });
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'completed' });
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    // The same result again (a repeated delivery) changes nothing.
    const again = refundEvent(`evt_${crypto.randomUUID()}`, { refund: gatewayRefundId, refundId: refund.id });
    expect((await hook(t, clock, 'payments', 'card-b2c', again)).statusCode).toBe(200);
    expect((await refundRow(refund.id)).status).toBe('completed');
  });

  it('a refund.failed event found by the gateway id fails it with the text; an unknown refund is ignored', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    fake.refund = { status: 'pending' };
    await sender.send(refund.id, false);
    const gatewayRefundId = (await refundRow(refund.id)).gatewayRefundId!;
    const body = refundEvent(`evt_${crypto.randomUUID()}`, {
      refund: gatewayRefundId,
      type: 'refund.failed',
      failure: 'expired_or_canceled_card',
    });
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    // The gateway's own `refund.failed` is final for that refund object: the next send needs a new key.
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'failed',
      note: 'expired_or_canceled_card',
      sendAttempt: 2,
    });
    const unknown = refundEvent(`evt_${crypto.randomUUID()}`, { refund: 're_unknown' });
    expect((await hook(t, clock, 'payments', 'card-b2c', unknown)).statusCode).toBe(200);
  });

  it('a late refund.failed of the first gateway refund does not fail the retry that replaced it: the customer is refunded once', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    // Send 1: the gateway answers a refund object that is pending, then says it failed (attempt 1 ends; the key moves on to attempt 2).
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const first = (await refundRow(refund.id)).gatewayRefundId!;
    const failedFirst = () =>
      refundEvent(`evt_${crypto.randomUUID()}`, {
        refund: first,
        refundId: refund.id,
        sendAttempt: 1,
        type: 'refund.failed',
        failure: 'expired_or_canceled_card',
      });
    expect((await hook(t, clock, 'payments', 'card-b2c', failedFirst())).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', sendAttempt: 2 });

    // The staff retry is on its way: processing again, but its call has not been made, so no gateway id of its own is stored yet.
    expect((await staff.post(`/admin/refunds/${refund.id}/retry`, {})).status).toBe(200);
    expect((await hook(t, clock, 'payments', 'card-b2c', failedFirst())).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'processing', sendAttempt: 2 });

    // The retry sends under the new key and the attempt, and the gateway answers a second refund that is pending.
    expect(await sender.send(refund.id, false)).toBe('pending');
    const second = (await refundRow(refund.id)).gatewayRefundId!;
    expect(second).not.toBe(first);
    const calls = fake.calls('/v1/refunds');
    expect(calls.map((call) => call.headers['idempotency-key'])).toEqual([
      `refund-${refund.id}`,
      `refund-${refund.id}-2`,
    ]);
    expect(calls.map((call) => new URLSearchParams(call.body).get('metadata[send_attempt]'))).toEqual(['1', '2']);

    // The first refund's `refund.failed` is delivered again, late: it is of attempt 1, so it changes nothing.
    expect((await hook(t, clock, 'payments', 'card-b2c', failedFirst())).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'processing', sendAttempt: 2, gatewayRefundId: second });

    // The second refund's own result completes it, so the next staff retry can never send a third refund.
    const succeeded = refundEvent(`evt_${crypto.randomUUID()}`, {
      refund: second,
      refundId: refund.id,
      sendAttempt: 2,
    });
    expect((await hook(t, clock, 'payments', 'card-b2c', succeeded)).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'completed', sendAttempt: 2 });
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    expect((await staff.post(`/admin/refunds/${refund.id}/retry`, {})).status).toBe(409);
    expect(fake.calls('/v1/refunds')).toHaveLength(2);
  });

  it('a refund.failed of the current attempt still fails the refund (the key moves on once more)', async () => {
    const paid = await order({ deliver: true });
    const refund = await request(paid);
    await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    fake.refund = { status: 'failed', failure: 'charge_already_refunded' };
    expect(await sender.send(refund.id, false)).toBe('failed');
    expect((await staff.post(`/admin/refunds/${refund.id}/retry`, {})).status).toBe(200);
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const second = (await refundRow(refund.id)).gatewayRefundId!;
    const body = refundEvent(`evt_${crypto.randomUUID()}`, {
      refund: second,
      refundId: refund.id,
      sendAttempt: 2,
      type: 'refund.failed',
      failure: 'expired_or_canceled_card',
    });
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', sendAttempt: 3 });
  });
});

describe('the refund the system opens when a paid order is rejected', () => {
  it('a staff rejection refunds the whole payment, opens a processing refund and queues the gateway call', async () => {
    const paid = await order();
    const res = await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' });
    expect(res.status).toBe(204);
    const [refund] = await db.select().from(s.refunds);
    expect(refund).toMatchObject({
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      amount: '3.8400',
      currency: 'GBP',
      method: 'original',
      status: 'processing',
      requestedByType: 'staff',
      approvedBy: staff.staffId,
      ledgerTxId: expect.any(Number),
    });
    expect((await ledgerOf(db, paid.orderId)).at(-1)).toEqual({ kind: 'refund', key: `order:${paid.orderId}:refund` });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await refundOutbox()).toHaveLength(1);
    expect(await sender.send(refund!.id, false)).toBe('completed');
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    const shown = await staff.get(`/admin/refunds/${refund!.id}`);
    expect(shown.body).toMatchObject({
      status: 'completed',
      netAmount: '3.9900',
      taxAmount: '0.8000',
      requestedBy: { type: 'staff', name: 'Layla Haddad' },
    });
    expect((await outboxOf(db, 'order.status_changed', paid.orderId)).at(-1)!.payload).toMatchObject({
      toStatus: 'rejected',
    });
  });

  /** An order paid by the second of two payments of one checkout; the first one confirmed later and was refunded as a duplicate. */
  async function orderPaidSecond(): Promise<{ orderId: number; first: { id: number }; second: { id: number } }> {
    const { token } = await openCheckout(t, world);
    const first = json(await pay(t, token, undefined, 'k1')).payment;
    const second = json(await pay(t, token, undefined, 'k2')).payment;
    for (const payment of [second, first]) {
      const body = storefrontEvent(crypto.randomUUID(), payment.reference, {
        amount: payment.amount,
        intent: `pi_${crypto.randomUUID()}`,
      });
      expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    }
    const [created] = await db.select().from(s.orders);
    // The duplicate is refunded in full at once; the gateway's answer completes it.
    const [duplicate] = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, first.id));
    expect(duplicate).toMatchObject({ status: 'processing', requestedByType: 'system' });
    expect(await sender.send(duplicate!.id, false)).toBe('completed');
    expect((await paymentRow(first.id)).status).toBe('refunded');
    return { orderId: created!.id, first, second };
  }

  it('a rejection refunds the payment that paid the order, not a duplicate payment that was refunded already', async () => {
    const { orderId, first, second } = await orderPaidSecond();
    expect(first.id).toBeLessThan(second.id);
    expect(await systemBalance(db, 'customer_funds')).toBe('3.9900');

    expect((await staff.post(`/admin/orders/${orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(204);
    const refunds = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, second.id));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      orderId,
      amount: '3.8400',
      status: 'processing',
      requestedByType: 'staff',
      ledgerTxId: expect.any(Number),
    });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect(await sender.send(refunds[0]!.id, false)).toBe('completed');
    expect((await paymentRow(second.id)).status).toBe('refunded');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // Two gateway refunds in all, one for each payment, each for its own 3.84.
    expect(fake.calls('/v1/refunds')).toHaveLength(2);
  });

  it('an approved refund of an open order is paid out of the payment it names', async () => {
    const { orderId, second } = await orderPaidSecond();
    const customerId = (await orderRow(db, orderId)).customerId!;
    const [named] = await db
      .insert(s.refunds)
      .values({
        paymentId: second.id,
        orderId,
        customerId,
        amount: '3.8400',
        currency: 'GBP',
        reason: 'The code did not work',
        method: 'original',
        status: 'requested',
        requestedByType: 'customer',
        requestedById: customerId,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })
      .returning();
    const res = await staff.post(`/admin/refunds/${named!.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'processing',
      amount: '4.7900',
      netAmount: '3.9900',
      taxAmount: '0.8000',
    });
    expect(await refundRow(named!.id)).toMatchObject({ paymentId: second.id, ledgerTxId: expect.any(Number) });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect(await db.select().from(s.refunds)).toHaveLength(2);
    expect(await sender.send(named!.id, false)).toBe('completed');
    expect((await paymentRow(second.id)).status).toBe('refunded');
  });

  it('a crypto payment rejected before delivery is refunded by hand at once', async () => {
    const paid = await order();
    await db.update(s.payments).set({ methodType: 'crypto' }).where(eq(s.payments.id, paid.paymentId));
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const [refund] = await db.select().from(s.refunds);
    expect(refund).toMatchObject({ method: 'manual', status: 'completed' });
    expect(fake.calls('/v1/refunds')).toHaveLength(0);
  });
});

describe('the autoRefundFailed policy (RULES settings 5)', () => {
  /** A paid order that a supplier is working on, rejected by the supplier's answer (the system decides, not a person). */
  async function rejectedBySupplier(): Promise<PaidOrder> {
    const paid = await order();
    await db.update(s.orders).set({ status: 'processing', dispatchState: 'sent' }).where(eq(s.orders.id, paid.orderId));
    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    await db.transaction((tx) =>
      moves.settle(tx, { orderId: paid.orderId, result: 'rejected', supplierId: 1, text: 'Blacklisted phone' }),
    );
    return paid;
  }
  const policy = async (value: boolean) => {
    const settings = await adminWith(t, ['settings:storefront', 'settings:read']);
    expect((await settings.patch('/admin/storefront/settings', { autoRefundFailed: value })).status).toBe(200);
  };

  it('on (the default): a supplier rejection is refunded by the system, as before', async () => {
    const paid = await rejectedBySupplier();
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'rejected' });
    const [refund] = await db.select().from(s.refunds);
    expect(refund).toMatchObject({
      paymentId: paid.paymentId,
      amount: '3.8400',
      status: 'processing',
      requestedByType: 'system',
      requestedById: null,
      ledgerTxId: expect.any(Number),
    });
    expect((await ledgerOf(db, paid.orderId)).at(-1)).toEqual({ kind: 'refund', key: `order:${paid.orderId}:refund` });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await refundOutbox()).toHaveLength(1);
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'refund',
      data: expect.objectContaining({ message: 'Refund of $4.79 sent to the original payment method' }),
    });
  });

  it('switched on explicitly it is the same', async () => {
    await policy(true);
    const paid = await rejectedBySupplier();
    expect(await db.select().from(s.refunds)).toHaveLength(1);
    expect((await refundRow((await db.select().from(s.refunds))[0]!.id)).status).toBe('processing');
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'rejected' });
  });

  it('off: the rejection opens a refund request for staff and nothing goes back by itself; approving it pays it out of customer funds', async () => {
    await policy(false);
    const paid = await rejectedBySupplier();
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'rejected', dispatchState: 'done' });
    const [request] = await db.select().from(s.refunds);
    expect(request).toMatchObject({
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      amount: '3.8400',
      currency: 'GBP',
      status: 'requested',
      requestedByType: 'system',
      requestedById: null,
      approvedBy: null,
      ledgerTxId: null,
    });
    // No journal, no gateway call, no job: the customer's money is still held as customer funds and VAT.
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).toEqual(['b2c_payment', 'gateway_fee']);
    expect(await systemBalance(db, 'customer_funds')).toBe('3.9900');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.8000');
    expect(await refundOutbox()).toHaveLength(0);
    expect(fake.calls('/v1/refunds')).toHaveLength(0);
    expect((await paymentRow(paid.paymentId)).status).toBe('captured');
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'refund',
      data: expect.objectContaining({ message: 'Refund of $4.79 is waiting for staff to approve', requested: true }),
    });
    const listed = await staff.get(`/admin/refunds/${request!.id}`);
    expect(listed.body).toMatchObject({
      status: 'requested',
      requestedBy: { type: 'system', name: 'System' },
      amount: '4.7900',
    });

    // Staff approve it: the order is already rejected, so nothing is cancelled; the journal comes out of customer funds.
    const approved = await staff.post(`/admin/refunds/${request!.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'processing', netAmount: '3.9900', taxAmount: '0.8000' });
    expect((await ledgerOf(db, paid.orderId)).at(-1)).toEqual({ kind: 'refund', key: `refund:${request!.id}` });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await refundOutbox()).toHaveLength(1);
    expect(await sender.send(request!.id, false)).toBe('completed');
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // A second approval finds nothing left to refund.
    const again = await staff.post(`/admin/refunds/${request!.id}/approve`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'REFUND_NOT_PENDING' });
  });

  it('off: staff can decline the request, and a person who rejects the order still refunds it (the switch is about the system)', async () => {
    await policy(false);
    const paid = await rejectedBySupplier();
    const [request] = await db.select().from(s.refunds);
    const declined = await staff.post(`/admin/refunds/${request!.id}/decline`, { reason: 'The carrier did deliver.' });
    expect(declined.status).toBe(200);
    expect(await systemBalance(db, 'customer_funds')).toBe('3.9900');

    // A staff rejection of another order refunds at once, even with the switch off.
    const other = await order({ email: 'ann@mail.example' });
    expect((await staff.post(`/admin/orders/${other.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const refunds = await db.select().from(s.refunds).where(eq(s.refunds.orderId, other.orderId));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      status: 'processing',
      requestedByType: 'staff',
      ledgerTxId: expect.any(Number),
    });
    expect(paid.orderId).not.toBe(other.orderId);
  });
});

describe('lock order: the order, then the payment, then the refund', () => {
  it('an approval waits for the order before it takes the payment, as a rejection does (so the two cannot deadlock)', async () => {
    const { pool } = await testDb();
    const paid = await order();
    const refund = await request(paid);
    // Hold the order's row the way a rejection does with its guarded update, in a transaction of our own.
    const holder: PoolClient = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from orders where id = $1 for no key update', [paid.orderId]);
      const approving = staff.post(`/admin/refunds/${refund.id}/approve`, {});
      await eventually(async () => {
        const { rows } = await pool.query(
          `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from "orders"%for no key update%'`,
        );
        return rows.length > 0 ? true : undefined;
      });
      // The approval is waiting for the order and holds nothing else yet: the payment and the refund can be locked without waiting.
      const probe = await pool.connect();
      try {
        await probe.query('begin');
        await probe.query('select id from payments where id = $1 for update nowait', [paid.paymentId]);
        await probe.query('select id from refunds where id = $1 for update nowait', [refund.id]);
      } finally {
        await probe.query('rollback');
        probe.release();
      }
      await holder.query('commit');
      const res = await approving;
      expect(res.status).toBe(200);
      expect(await refundRow(refund.id)).toMatchObject({ status: 'processing' });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
  });

  it('a rejection and an approval of the same order at once never deadlock: one wins, the other is refused, and the money moves once', async () => {
    for (let round = 0; round < 4; round += 1) {
      const paid = await order({ email: `race-${round}@mail.example` });
      const refund = await request(paid);
      const [approved, rejected] = await Promise.all([
        staff.post(`/admin/refunds/${refund.id}/approve`, {}),
        staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' }),
      ]);
      const statuses = [approved.status, rejected.status];
      // 200 or 204 for the winner; the loser is a 409 (order closed) or a 422 (nothing left); never a 5xx from a deadlock.
      expect(
        statuses.every((status) => status < 500),
        `round ${round}: ${statuses.join(', ')}`,
      ).toBe(true);
      expect(statuses.filter((status) => status === 200 || status === 204)).toHaveLength(1);
      expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'rejected' });
      expect((await ledgerOf(db, paid.orderId)).filter((entry) => entry.kind === 'refund')).toHaveLength(1);
    }
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});
