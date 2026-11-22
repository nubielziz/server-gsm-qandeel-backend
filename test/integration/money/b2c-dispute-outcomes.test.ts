// Integration tests of what a card dispute does to the books and to the payment (feature 16, scenario b2c-chargeback, decision 048): a
// lost dispute of an order that was never delivered gives back what the sale booked as owed to the buyer and as VAT, and only the dispute
// fee is a loss; a delivered order's dispute stays a loss of the amount and the fee; a card network inquiry records nothing until the
// gateway reports it as a dispute; and a payment's status after one of its disputes ends is worked out from all of its disputes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, disputeEvent, hook, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { ledgerTotals } from '../../support/money';
import { seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, ledgerOf, orderRow, systemBalance } from '../../support/orders';

const clock = new TestClock('2026-11-21T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;
let counter = 0;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-21T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
  await seedDefaultTemplates(db);
  staff = await adminWith(t, ['orders:*', 'refunds:*', 'disputes:*', 'reports:*'], { name: 'Layla Haddad' });
});

const unique = (): string => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const refundRows = () => db.select().from(s.refunds).orderBy(s.refunds.id);
const disputeRows = () => db.select().from(s.disputes).orderBy(s.disputes.id);
const disputeOf = async (gatewayId: string) =>
  (await db.select().from(s.disputes).where(eq(s.disputes.gatewayDisputeId, gatewayId)))[0]!;
const chargebacks = () => db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.kind, 'chargeback'));

/** One dispute event of the paid order's payment (GBP 3.84 and a GBP 12.00 fee unless told otherwise). */
async function report(
  paid: PaidOrder,
  gatewayId: string,
  options: { type?: string; status?: string; amount?: number; fee?: number } = {},
) {
  const res = await hook(
    t,
    clock,
    'disputes',
    world.gateway.code,
    disputeEvent(`evt_${unique()}`, { dispute: gatewayId, intent: paid.intent, ...options }),
  );
  expect(res.statusCode).toBe(200);
  return res.json<{ received: true; duplicate?: boolean }>();
}

const lose = (paid: PaidOrder, gatewayId: string) =>
  report(paid, gatewayId, { type: 'charge.dispute.closed', status: 'lost' });
const win = (paid: PaidOrder, gatewayId: string) =>
  report(paid, gatewayId, { type: 'charge.dispute.closed', status: 'won' });

/** The checkout's locked rate (GBP per USD). */
async function fxOf(orderId: number): Promise<string> {
  const order = await orderRow(db, orderId);
  const [session] = await db
    .select()
    .from(s.checkoutSessions)
    .where(eq(s.checkoutSessions.id, order.checkoutSessionId!));
  return session!.fxRate;
}

const usd = (gbp: string, fx: string): Decimal => new Decimal(gbp).div(fx).toDecimalPlaces(4);

/** What one ledger transaction moved, per account kind (debit positive). */
async function linesOf(transactionId: number): Promise<Record<string, string>> {
  const result = await db.execute<{ kind: string; amount: string }>(sql`
    select la.kind, sum(le.amount)::numeric(18,4)::text as amount
    from ledger_entries le join ledger_accounts la on la.id = le.account_id
    where le.transaction_id = ${transactionId}
    group by la.kind order by la.kind`);
  return Object.fromEntries(result.rows.map((row) => [row.kind, row.amount]));
}

async function vatTotals() {
  const res = await staff.get('/admin/reports/vat?from=2026-11-01&to=2026-11-30');
  expect(res.status).toBe(200);
  return res.body.totals as { orders: number; taxable: string; vat: string };
}

async function reject(paid: PaidOrder) {
  expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(204);
  expect((await orderRow(db, paid.orderId)).status).toBe('rejected');
}

describe('what a lost dispute books', () => {
  it('an order that was never delivered gives back customer funds and VAT; only the dispute fee is a loss and no VAT is reported', async () => {
    const paid = await paidOrder(t, clock, world);
    await report(paid, 'dp_rejected');
    await reject(paid);
    await lose(paid, 'dp_rejected');
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    const fee = usd('12', await fxOf(paid.orderId));
    // The chargeback journal: Dr customer_funds 3.99 (net), Dr vat_payable 0.80, Dr chargeback_loss the fee / Cr gateway_clearing 4.79 + fee.
    const lost = await disputeOf('dp_rejected');
    expect(await linesOf(lost.ledgerTxId!)).toEqual({
      chargeback_loss: fee.toFixed(4),
      customer_funds: '3.9900',
      gateway_clearing: fee.add('4.79').neg().toFixed(4),
      vat_payable: '0.8000',
    });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect(await systemBalance(db, 'chargeback_loss')).toBe(fee.toFixed(4));
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await vatTotals()).toEqual({ orders: 1, taxable: '0.0000', vat: '0.0000' });
    // The payments report's strip ties to the books: the loss is the dispute fee.
    const payments = await staff.get('/admin/reports/payments');
    expect(payments.status).toBe(200);
    expect(payments.body.totals.chargebackLoss).toBe(fee.toFixed(4));
    // The refund request the rejection opened is closed: the card network returned the money.
    expect((await refundRows()).map((row) => row.status)).toEqual(['rejected']);
  });

  it('staff accepting the loss of a rejected order book the same journal', async () => {
    const paid = await paidOrder(t, clock, world);
    await report(paid, 'dp_accepted');
    await reject(paid);
    const res = await staff.post(`/admin/disputes/${(await disputeOf('dp_accepted')).id}/accept`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'lost' });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect(await systemBalance(db, 'chargeback_loss')).toBe(usd('12', await fxOf(paid.orderId)).toFixed(4));
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await chargebacks()).toHaveLength(1);
  });

  it('a rejected order whose refund was booked but not sent: the refund is reversed and the money leaves the books once', async () => {
    const paid = await paidOrder(t, clock, world);
    await reject(paid);
    const [refund] = await refundRows();
    expect(refund).toMatchObject({ status: 'processing', gatewayRefundId: null });
    expect(refund!.ledgerTxId).not.toBeNull();
    await report(paid, 'dp_booked');
    await lose(paid, 'dp_booked');
    expect((await refundRows())[0]).toMatchObject({ id: refund!.id, status: 'rejected' });
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'refund',
      'refund',
      'chargeback',
    ]);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect(await systemBalance(db, 'chargeback_loss')).toBe(usd('12', await fxOf(paid.orderId)).toFixed(4));
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await vatTotals()).toEqual({ orders: 1, taxable: '0.0000', vat: '0.0000' });
  });

  it('a dispute of part of a rejected order gives back that part, split into net and VAT like a refund', async () => {
    const paid = await paidOrder(t, clock, world);
    await report(paid, 'dp_part', { amount: 192, fee: 0 });
    await reject(paid);
    await lose(paid, 'dp_part');
    // GBP 1.92 of 3.84 at the locked rate; VAT share = round(0.80 x part / 4.79, 2).
    const part = usd('1.92', await fxOf(paid.orderId));
    const vat = new Decimal('0.80').times(part).div('4.79').toDecimalPlaces(2);
    const net = part.sub(vat);
    expect(await linesOf((await disputeOf('dp_part')).ledgerTxId!)).toEqual({
      customer_funds: net.toFixed(4),
      gateway_clearing: part.neg().toFixed(4),
      vat_payable: vat.toFixed(4),
    });
    expect(await systemBalance(db, 'customer_funds')).toBe(new Decimal('3.99').sub(net).toFixed(4));
    expect(await systemBalance(db, 'vat_payable')).toBe(new Decimal('0.80').sub(vat).toFixed(4));
    expect(await systemBalance(db, 'chargeback_loss')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('a second lost dispute of a rejected order gives back only what the first one left', async () => {
    const paid = await paidOrder(t, clock, world);
    await report(paid, 'dp_half', { amount: 192, fee: 0 });
    await report(paid, 'dp_whole', { fee: 0 });
    await reject(paid);
    await lose(paid, 'dp_half');
    await lose(paid, 'dp_whole');
    const part = usd('1.92', await fxOf(paid.orderId));
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    // The second dispute took the whole payment again: what the first one already gave back is a loss.
    expect(await systemBalance(db, 'chargeback_loss')).toBe(part.toFixed(4));
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await vatTotals()).toEqual({ orders: 1, taxable: '0.0000', vat: '0.0000' });
  });

  it('a delivered order stays a loss of the amount and the fee, and its VAT stays owed', async () => {
    const paid = await paidOrder(t, clock, world);
    expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
    await report(paid, 'dp_delivered');
    await lose(paid, 'dp_delivered');
    const fee = usd('12', await fxOf(paid.orderId));
    expect(await linesOf((await disputeOf('dp_delivered')).ledgerTxId!)).toEqual({
      chargeback_loss: fee.add('4.79').toFixed(4),
      gateway_clearing: fee.add('4.79').neg().toFixed(4),
    });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.8000');
    expect(await vatTotals()).toEqual({ orders: 1, taxable: '3.9900', vat: '0.8000' });
    expect((await staff.get('/admin/reports/payments')).body.totals.chargebackLoss).toBe(fee.add('4.79').toFixed(4));
  });
});

describe('card network inquiries', () => {
  it('an inquiry records nothing and its closing changes nothing: the payment stays captured and a rejection refunds at once', async () => {
    const paid = await paidOrder(t, clock, world);
    expect(await report(paid, 'du_inquiry', { status: 'warning_needs_response' })).toEqual({
      received: true,
    });
    expect(
      await report(paid, 'du_inquiry', { type: 'charge.dispute.updated', status: 'warning_under_review' }),
    ).toEqual({
      received: true,
    });
    expect(await report(paid, 'du_inquiry', { type: 'charge.dispute.closed', status: 'warning_closed' })).toEqual({
      received: true,
    });
    expect(await disputeRows()).toHaveLength(0);
    expect((await paymentRow(paid.paymentId)).status).toBe('captured');
    expect((await eventsOf(db, paid.orderId)).filter((line) => line.type === 'dispute')).toHaveLength(0);
    await reject(paid);
    expect((await refundRows()).map((row) => row.status)).toEqual(['processing']);
    expect(await chargebacks()).toHaveLength(0);
  });

  it("an inquiry the gateway turns into a dispute is opened by the gateway's update and books one chargeback when lost", async () => {
    const paid = await paidOrder(t, clock, world);
    await report(paid, 'du_escalated', { status: 'warning_needs_response' });
    expect(await disputeRows()).toHaveLength(0);
    expect(await report(paid, 'du_escalated', { type: 'charge.dispute.updated', status: 'needs_response' })).toEqual({
      received: true,
    });
    expect(await disputeRows()).toEqual([
      expect.objectContaining({ gatewayDisputeId: 'du_escalated', status: 'needs_response' }),
    ]);
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
    // A later update of the same dispute opens nothing more.
    expect(
      await report(paid, 'du_escalated', { type: 'charge.dispute.funds_withdrawn', status: 'needs_response' }),
    ).toEqual({
      received: true,
      duplicate: true,
    });
    await lose(paid, 'du_escalated');
    expect(await disputeRows()).toHaveLength(1);
    expect(await chargebacks()).toHaveLength(1);
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
  });
});

describe('more than one dispute of a payment', () => {
  it('a second dispute won after the first was lost leaves the payment charged back, and a rejection then only opens a request', async () => {
    const paid = await paidOrder(t, clock, world);
    await report(paid, 'dp_first');
    await lose(paid, 'dp_first');
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    await report(paid, 'dp_second');
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    await win(paid, 'dp_second');
    expect(await disputeOf('dp_second')).toMatchObject({ status: 'won' });
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    await reject(paid);
    expect(await refundRows()).toEqual([expect.objectContaining({ status: 'requested', ledgerTxId: null })]);
    expect(fake.calls('/v1/refunds')).toHaveLength(0);
  });

  it('a dispute won while another is still open leaves the payment disputed; it is captured again once both are won', async () => {
    const paid = await paidOrder(t, clock, world);
    await report(paid, 'dp_open');
    await report(paid, 'dp_other');
    await win(paid, 'dp_other');
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
    await reject(paid);
    expect(await refundRows()).toEqual([expect.objectContaining({ status: 'requested', ledgerTxId: null })]);
    await win(paid, 'dp_open');
    expect((await paymentRow(paid.paymentId)).status).toBe('captured');
  });
});
