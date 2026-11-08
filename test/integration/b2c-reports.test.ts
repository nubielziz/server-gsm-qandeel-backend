// Integration tests of the storefront money reports (feature 16, RESOLUTIONS money-4 and money-5, ANSWERS refunds Q2): the VAT report worked out from
// the ledger (payments minus refunds, by country and month) and the payments report by method (volumes, fees, refunds, disputes, the strip).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { RefundProcessModule, RefundSender } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { GatewayTestModule } from '../support/billing';
import {
  type B2cWorld,
  B2cGateway,
  type PaidOrder,
  b2cWorld,
  disputeEvent,
  hook,
  openCheckout,
  pay,
  paidOrder,
} from '../support/b2c';
import { DAY, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';

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
  staff = await adminWith(t, ['reports:finance', 'refunds:*', 'disputes:*', 'orders:*'], { name: 'Layla Haddad' });
});

const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;

/** The books of this file: two UK card orders (one refunded in full), a UK Apple Pay order that lost a dispute, and a US crypto order. */
async function books(): Promise<{ card: PaidOrder; refunded: PaidOrder; wallet: PaidOrder; crypto: PaidOrder }> {
  const card = await paidOrder(t, clock, world, { email: 'a@mail.example' });
  clock.advance(MINUTE);
  const refunded = await paidOrder(t, clock, world, { email: 'b@mail.example' });
  expect((await staff.post(`/admin/orders/${refunded.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
  const [row] = await db
    .insert(s.refunds)
    .values({
      paymentId: refunded.paymentId,
      orderId: refunded.orderId,
      customerId: (await db.select().from(s.orders).where(eq(s.orders.id, refunded.orderId)))[0]!.customerId!,
      amount: refunded.charged,
      currency: 'GBP',
      reason: 'The code did not work',
      method: 'original',
      status: 'requested',
      requestedByType: 'system',
    })
    .returning();
  expect((await staff.post(`/admin/refunds/${row!.id}/approve`, {})).status).toBe(200);
  expect(await sender.send(row!.id, false)).toBe('completed');
  clock.advance(MINUTE);
  const wallet = await paidOrder(t, clock, world, {
    email: 'c@mail.example',
    card: { brand: 'visa', last4: '4242', wallet: 'apple_pay' },
  });
  expect((await staff.post(`/admin/orders/${wallet.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
  const opened = await hook(
    t,
    clock,
    'disputes',
    world.gateway.code,
    disputeEvent('evt_book_dispute', {
      dispute: 'dp_book',
      intent: wallet.intent,
      dueBy: Math.floor(clock.nowMs() / 1000) + 7 * 86_400,
    }),
  );
  expect(opened.statusCode).toBe(200);
  const [dispute] = await db.select().from(s.disputes);
  expect((await staff.post(`/admin/disputes/${dispute!.id}/accept`, {})).status).toBe(200);
  clock.advance(MINUTE);
  const crypto = await paidOrder(t, clock, world, { email: 'd@mail.example', country: 'US', currency: 'USD' });
  await db
    .update(s.payments)
    .set({ methodType: 'crypto', brand: 'USDT TRC-20' })
    .where(eq(s.payments.id, crypto.paymentId));
  return { card, refunded, wallet, crypto };
}

describe('GET /admin/reports/vat', () => {
  it('is the ledger: VAT paid minus VAT refunded, one row per country and month', async () => {
    await books();
    const res = await staff.get('/admin/reports/vat?from=2026-11-01&to=2026-11-30');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      currency: 'USD',
      // GB: three paid orders of net 3.99 and VAT 0.80, one refunded in full (net 3.99, VAT 0.80 back). US: no VAT window, one order of 3.99.
      rows: [
        { country: 'GB', period: '2026-11', rate: '20.0000', orders: 3, taxable: '7.9800', vat: '1.6000' },
        { country: 'US', period: '2026-11', rate: '0.0000', orders: 1, taxable: '3.9900', vat: '0.0000' },
      ],
      totals: { orders: 4, taxable: '11.9700', vat: '1.6000' },
    });
    // The report ties to the books: what is still in vat_payable.
    const [vatPayable] = (
      await db.execute<{ balance: string }>(
        sql`select balance::text from ledger_accounts where kind = 'vat_payable' and owner_type is null`,
      )
    ).rows;
    expect(vatPayable!.balance).toBe('1.6000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('counts the journals posted inside the days asked for, both days included, newest month first', async () => {
    await paidOrder(t, clock, world, { email: 'a@mail.example' });
    clock.set('2026-12-01T00:00:00.000Z');
    staff = await adminWith(t, ['reports:finance'], { name: 'Layla Haddad' });
    await db.update(s.checkoutSessions).set({ expiresAt: new Date('2027-01-01T00:00:00.000Z') });
    const december = await paidOrder(t, clock, world, { email: 'b@mail.example' });
    expect(december.orderId).toBeGreaterThan(0);
    const both = await staff.get('/admin/reports/vat?from=2026-11-07&to=2026-12-01');
    expect(both.body.rows.map((row: { period: string }) => row.period)).toEqual(['2026-12', '2026-11']);
    expect(both.body.totals).toEqual({ orders: 2, taxable: '7.9800', vat: '1.6000' });
    const first = await staff.get('/admin/reports/vat?from=2026-11-07&to=2026-11-07');
    expect(first.body.totals).toEqual({ orders: 1, taxable: '3.9900', vat: '0.8000' });
    const last = await staff.get('/admin/reports/vat?from=2026-12-01&to=2026-12-01');
    expect(last.body.rows).toHaveLength(1);
    expect(last.body.rows[0]).toMatchObject({ period: '2026-12', orders: 1 });
    const none = await staff.get('/admin/reports/vat?from=2025-01-01&to=2025-01-31');
    expect(none.body).toEqual({
      from: '2025-01-01',
      to: '2025-01-31',
      currency: 'USD',
      rows: [],
      totals: { orders: 0, taxable: '0.0000', vat: '0.0000' },
    });
  });

  it('refuses a bad date, a missing date and a start after the end, and needs reports:finance', async () => {
    for (const path of [
      '/admin/reports/vat',
      '/admin/reports/vat?from=2026-11-01',
      '/admin/reports/vat?from=2026-13-01&to=2026-11-30',
      '/admin/reports/vat?from=yesterday&to=2026-11-30',
      '/admin/reports/vat?from=2026-11-30&to=2026-11-01',
    ]) {
      expect((await staff.get(path)).status, path).toBe(422);
    }
    const inverted = await staff.get('/admin/reports/vat?from=2026-11-30&to=2026-11-01');
    expect(inverted.body.errors[0]).toMatchObject({ field: 'from' });
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.get('/admin/reports/vat?from=2026-11-01&to=2026-11-30')).status).toBe(403);
    expect((await staff.anonymous('GET', '/admin/reports/vat?from=2026-11-01&to=2026-11-30')).status).toBe(401);
  });
});

describe('GET /admin/reports/payments', () => {
  it('compares the three methods, lists the payments and totals the strip, all in USD tied to the books', async () => {
    const { card, refunded, wallet, crypto } = await books();
    // A payment that was opened but never confirmed is never listed or counted.
    const { token } = await openCheckout(t, world, { email: 'e@mail.example' });
    expect((await pay(t, token, undefined)).statusCode).toBe(201);
    // A request waiting for staff counts in "awaiting".
    await db.insert(s.refunds).values({
      paymentId: card.paymentId,
      orderId: card.orderId,
      customerId: (await db.select().from(s.orders).where(eq(s.orders.id, card.orderId)))[0]!.customerId!,
      amount: card.charged,
      currency: 'GBP',
      reason: 'Changed my mind',
      method: 'original',
      status: 'requested',
      requestedByType: 'system',
    });

    const res = await staff.get('/admin/reports/payments');
    expect(res.status).toBe(200);
    const fees = (
      await db.execute<{ id: number; fee: string }>(
        sql`select p.id, abs(sum(le.amount))::numeric(18,4)::text as fee
        from payments p join ledger_transactions lt on lt.idempotency_key = 'payment:' || p.id || ':fee'
        join ledger_entries le on le.transaction_id = lt.id join ledger_accounts la on la.id = le.account_id and la.kind = 'gateway_clearing'
        group by p.id`,
      )
    ).rows;
    const fee = (id: number) => fees.find((row) => Number(row.id) === id)!.fee;
    expect(res.body.methods.map((row: { method: string }) => row.method)).toEqual(['card', 'wallet', 'crypto']);
    // 2.9 % of 4.79 plus 0.30 = 0.4389 for a UK order; 2.9 % of 3.99 plus 0.30 = 0.4157 for the US one.
    expect(fee(card.paymentId)).toBe('0.4389');
    expect(fee(crypto.paymentId)).toBe('0.4157');
    expect(res.body.methods).toEqual([
      { method: 'card', payments: 2, volume: '9.5800', fees: '0.8778', feeRate: '9.16', refunds: 1, disputes: 0 },
      { method: 'wallet', payments: 1, volume: '4.7900', fees: '0.4389', feeRate: '9.16', refunds: 0, disputes: 1 },
      { method: 'crypto', payments: 1, volume: '3.9900', fees: '0.4157', feeRate: '10.42', refunds: 0, disputes: 0 },
    ]);
    expect(res.body.total).toBe(4);
    // Newest first; the unconfirmed payment is not among them.
    expect(res.body.payments.map((line: { id: number }) => line.id)).toEqual([
      crypto.paymentId,
      wallet.paymentId,
      refunded.paymentId,
      card.paymentId,
    ]);
    expect(res.body.payments[0]).toEqual({
      id: crypto.paymentId,
      orderId: crypto.orderId,
      amount: '3.9900',
      feeAmount: '0.4157',
      createdAt: '2026-11-07T12:03:00.000Z',
      method: 'crypto',
      brand: 'USDT TRC-20',
      status: 'captured',
      currency: 'USD',
      fx: '1.00000000',
      customer: { id: expect.any(Number), name: 'd@mail.example' },
    });
    expect(res.body.payments[1]).toMatchObject({
      method: 'wallet',
      brand: 'Apple Pay',
      status: 'chargeback',
      amount: '4.7900',
      currency: 'GBP',
    });
    expect(res.body.payments[2]).toMatchObject({
      method: 'card',
      brand: 'Visa •••• 4242',
      status: 'refunded',
      amount: '4.7900',
    });
    expect(res.body.payments[3]).toMatchObject({ status: 'captured', fx: '0.80185000' });
    // Strip: one completed refund of 4.79 against 4.79 x 3 + 3.99 of sales; one request of 4.79 waits; the lost dispute cost 4.79 + its fee.
    const dispute = (await db.select().from(s.disputes))[0]!;
    expect(dispute.status).toBe('lost');
    expect(res.body.totals).toEqual({
      refundedCount: 1,
      refundedAmount: '4.7900',
      refundedPercentOfSales: '26.09',
      awaitingAmount: '4.7900',
      chargebackLoss: expect.stringMatching(/^\d+\.\d{4}$/),
    });
    const loss = (
      await db.execute<{ loss: string }>(
        sql`select abs(sum(le.amount))::numeric(18,4)::text as loss from ledger_entries le
        join ledger_accounts la on la.id = le.account_id and la.kind = 'chargeback_loss'`,
      )
    ).rows[0]!.loss;
    expect(res.body.totals.chargebackLoss).toBe(loss);
    expect(res.body.totals.chargebackLoss).toBe('19.7554');
  });

  it('filters by method, pages and sorts; the method comparison ignores the filter and the page', async () => {
    const { card, refunded, wallet, crypto } = await books();
    const cards = await staff.get('/admin/reports/payments?method=card&_sort=createdAt&_order=asc');
    expect(cards.body.total).toBe(2);
    expect(cards.body.payments.map((line: { id: number }) => line.id)).toEqual([card.paymentId, refunded.paymentId]);
    expect(cards.body.methods.map((row: { payments: number }) => row.payments)).toEqual([2, 1, 1]);
    const page = await staff.get('/admin/reports/payments?_start=1&_end=3&_sort=amount&_order=desc');
    expect(page.body.payments).toHaveLength(2);
    expect(page.body.total).toBe(4);
    expect(page.body.payments.map((line: { id: number }) => line.id)).not.toContain(crypto.paymentId);
    const strip = await staff.get('/admin/reports/payments?_start=0&_end=1');
    expect(strip.body.payments).toHaveLength(1);
    expect(strip.body.total).toBe(4);
    const byAmount = await staff.get('/admin/reports/payments?_sort=amount&_order=asc');
    expect(byAmount.body.payments[0].id).toBe(crypto.paymentId);
    const byMethod = await staff.get('/admin/reports/payments?_sort=method&_order=asc');
    expect(byMethod.body.payments.map((line: { method: string }) => line.method)).toEqual([
      'card',
      'card',
      'crypto',
      'wallet',
    ]);
    const byStatus = await staff.get('/admin/reports/payments?_sort=status&_order=asc');
    expect(byStatus.body.payments.map((line: { status: string }) => line.status)).toEqual(
      ['captured', 'captured', 'chargeback', 'refunded'].sort(),
    );
    const aliases = await staff.get('/admin/reports/payments?start=0&end=1&sort=orderId&order=desc');
    expect(aliases.status).toBe(200);
    expect(aliases.body.payments.map((line: { id: number }) => line.id)).toEqual([crypto.paymentId]);
    expect(wallet.paymentId).toBeGreaterThan(0);
  });

  it('is empty with zeros before any sale, and refuses a bad method or sort', async () => {
    const empty = await staff.get('/admin/reports/payments');
    expect(empty.status).toBe(200);
    expect(empty.body.methods).toEqual(
      ['card', 'wallet', 'crypto'].map((method) => ({
        method,
        payments: 0,
        volume: '0.0000',
        fees: '0.0000',
        feeRate: '0.00',
        refunds: 0,
        disputes: 0,
      })),
    );
    expect(empty.body).toMatchObject({
      payments: [],
      total: 0,
      totals: {
        refundedCount: 0,
        refundedAmount: '0.0000',
        refundedPercentOfSales: '0.00',
        awaitingAmount: '0.0000',
        chargebackLoss: '0.0000',
      },
    });
    expect((await staff.get('/admin/reports/payments?method=bank')).status).toBe(422);
    expect((await staff.get('/admin/reports/payments?_sort=customer')).status).toBe(422);
    expect((await staff.get('/admin/reports/payments?sort=customer')).status).toBe(422);
    expect((await staff.get('/admin/reports/payments?_order=sideways')).status).toBe(422);
    const nobody = await adminWith(t, ['refunds:read']);
    expect((await nobody.get('/admin/reports/payments')).status).toBe(403);
  });

  it('the strip counts the refunds of the last 30 days only; a failed refund waits, a payment of a top-up never shows', async () => {
    const { card, refunded } = await books();
    clock.advance(31 * DAY);
    staff = await adminWith(t, ['reports:finance'], { name: 'Layla Haddad' });
    const aged = await staff.get('/admin/reports/payments');
    // The refund completed 31 days ago: out of the window, and so are the sales.
    expect(aged.body.totals).toMatchObject({
      refundedCount: 0,
      refundedAmount: '0.0000',
      refundedPercentOfSales: '0.00',
    });
    await db
      .update(s.refunds)
      .set({ status: 'failed', note: 'The gateway said no' })
      .where(eq(s.refunds.paymentId, refunded.paymentId));
    await db.update(s.payments).set({ status: 'failed' }).where(eq(s.payments.id, card.paymentId));
    const failed = await staff.get('/admin/reports/payments');
    expect(failed.body.totals.awaitingAmount).toBe('4.7900');
    expect(failed.body.total).toBe(3);
    expect((await paymentRow(card.paymentId)).status).toBe('failed');
  });
});
