// Integration tests of the risk screening at the storefront capture (feature 18 on feature 16, RESOLUTIONS orders-suppliers-11, scenario
// b2c-paid): every captured payment is scored before the order exists. allow places the order as always, review places it held (no dispatch,
// the Risk page lists it), block places it held and refunds it at once as the system. The staff decisions on an order placed this way:
// approve releases it by the placement rule, refund gives the whole payment back through feature 16's refund.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { RefundProcessModule } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { B2cGateway, type B2cWorld, type PaidOrder, b2cWorld, paidOrder } from '../support/b2c';
import { GatewayTestModule } from '../support/billing';
import { insertSupplierLink } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { notificationRows, seedDefaultTemplates } from '../support/notifications';
import { auditOf, eventsOf, ledgerOf, orderRow, outboxOf, systemBalance } from '../support/orders';
import { assessmentOf, blocklistRows, insertBlock } from '../support/risk';

const clock = new TestClock('2026-11-08T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let risk: AdminApi;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, RefundProcessModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-08T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
  // The iCloud service is worked by a supplier (dispatch `pending`); the AT&T service has no link (the manual queue).
  await insertSupplierLink(db, world.icloud.serviceId);
  risk = await adminWith(t, ['risk:*'], { name: 'Rami K.' });
  staff = await adminWith(t, ['refunds:*', 'orders:*', 'risk:*', 'settings:*'], { name: 'Layla Haddad' });
});

type Rule = { id: string; on: boolean; value: number | null };

/** Saves the rules with the given numbers changed, as the console sends them (the whole set). */
async function setRules(values: Record<string, number>): Promise<void> {
  const current: Rule[] = (await risk.get('/admin/risk/rules')).body.rules;
  const rules = current.map(({ id, on, value }) => ({ id, on, value: id in values ? values[id]! : value }));
  expect((await risk.put('/admin/risk/rules', { rules })).status).toBe(200);
}

/** Rules that hold any first order above 1 USD (18 points, review from 10). */
const holdFirstOrders = () => setRules({ reviewFirstOrderAbove: 1, reviewThreshold: 10 });

/** Rules that block any first order above 1 USD (18 points, block from 15). */
const blockFirstOrders = () => setRules({ reviewFirstOrderAbove: 1, reviewThreshold: 5, blockThreshold: 15 });

const refundRows = () => db.select().from(s.refunds);
const refundEvents = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'));

/** The lines of one ledger transaction, by its idempotency key: the account kind and the signed amount (debit above zero). */
async function journal(key: string): Promise<Array<{ account: string; amount: string }>> {
  const result = await db.execute<{ account: string; amount: string }>(
    sql`select a.kind as account, e.amount::text as amount
        from ledger_entries e
        join ledger_accounts a on a.id = e.account_id
        join ledger_transactions x on x.id = e.transaction_id
        where x.idempotency_key = ${key}
        order by e.id`,
  );
  return result.rows;
}

describe('a payment the rules allow', () => {
  it('writes an allow assessment linked to the order and queues the dispatch as before', async () => {
    const paid = await paidOrder(t, clock, world);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'pending' });
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(1);
    const [session] = await db.select().from(s.checkoutSessions);
    expect(await assessmentOf(db, paid.orderId)).toMatchObject({
      decision: 'allow',
      checkoutSessionId: session!.id,
      customerId: (await orderRow(db, paid.orderId)).customerId,
      reviewedAt: null,
      outcome: null,
    });
    expect(await refundRows()).toEqual([]);
    expect((await risk.get('/admin/risk/queue')).body.held).toEqual([]);
  });
});

describe('a payment the rules hold', () => {
  it('places the order held with the hold sentence on the timeline, sends nothing to a supplier and lists it on the Risk page', async () => {
    await holdFirstOrders();
    const paid = await paidOrder(t, clock, world);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'held' });
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(0);
    const events = await eventsOf(db, paid.orderId);
    expect(events.map((event) => event.type)).toEqual(['created', 'paid', 'review']);
    expect(events.at(-1)!.data).toEqual({
      message: 'Risk hold: score 18. New customer, first order above $1',
      reason: 'Risk hold: score 18. New customer, first order above $1',
    });
    const assessment = await assessmentOf(db, paid.orderId);
    expect(assessment).toMatchObject({
      decision: 'review',
      score: 18,
      signals: ['New customer, first order above $1'],
      reviewedAt: null,
    });
    // The payment is captured and the money is in customer funds until someone decides.
    expect(await systemBalance(db, 'customer_funds')).toBe('3.9900');
    expect(await refundRows()).toEqual([]);
    const queue = (await risk.get('/admin/risk/queue')).body;
    expect(queue.held).toHaveLength(1);
    expect(queue.held[0]).toMatchObject({
      orderId: paid.orderId,
      score: 18,
      signals: ['New customer, first order above $1'],
      capturedAmount: '4.7900',
      currency: 'GBP',
      paymentMethod: 'card',
      customer: { email: 'sam@mail.example' },
    });
  });

  it('still tells the buyer the order was received', async () => {
    await seedDefaultTemplates(db);
    await holdFirstOrders();
    await paidOrder(t, clock, world);
    expect((await notificationRows(db)).map((row) => row.event)).toEqual(['order.received']);
  });

  it('claims no stock for a held order', async () => {
    await holdFirstOrders();
    const stocker = await adminWith(t, ['inventory:write']);
    const imported = await stocker.post(`/admin/services/${world.icloud.serviceId}/inventory/import`, {
      codes: ['GSM-STOCK-0001'],
    });
    expect(imported.status).toBeLessThan(300);
    const paid = await paidOrder(t, clock, world);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'held' });
    const [code] = await db.select().from(s.inventoryCodes);
    expect(code).toMatchObject({ status: 'available', orderId: null });
  });

  it('approve releases it by the placement rule: the dispatch job for a supplier service', async () => {
    await holdFirstOrders();
    const paid = await paidOrder(t, clock, world);
    expect((await risk.post(`/admin/risk/orders/${paid.orderId}/approve`)).status).toBe(204);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'pending' });
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(1);
    expect(await assessmentOf(db, paid.orderId)).toMatchObject({ outcome: 'approved', reviewedBy: risk.staffId });
    expect((await eventsOf(db, paid.orderId)).at(-1)!.data).toMatchObject({
      message: 'Risk review: approved, sent to the supplier',
    });
    expect((await risk.get('/admin/risk/queue')).body.held).toEqual([]);
  });

  it('approve releases it to the manual queue for a service without an active supplier link', async () => {
    await holdFirstOrders();
    const paid = await paidOrder(t, clock, world, { serviceId: world.att.serviceId });
    expect(await orderRow(db, paid.orderId)).toMatchObject({ dispatchState: 'held' });
    expect((await risk.post(`/admin/risk/orders/${paid.orderId}/approve`)).status).toBe(204);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'manual' });
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(0);
  });
});

describe('POST /admin/risk/orders/:id/refund on an order the rules held', () => {
  /** What the refund must have written for the held order of a GBP 3.84 payment (USD 3.99 net + 0.80 VAT). */
  async function expectWholeRefund(paid: PaidOrder, requestedBy: 'staff' | 'system', staffId: number | null) {
    const rows = await refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      amount: '3.8400',
      currency: 'GBP',
      method: 'original',
      status: 'processing',
      requestedByType: requestedBy,
      requestedById: staffId,
      ledgerTxId: expect.any(Number),
    });
    // One b2c_refund journal, keyed by the order: customer funds and VAT debited, the gateway account credited with the gross.
    expect((await ledgerOf(db, paid.orderId)).filter((entry) => entry.kind === 'refund')).toEqual([
      { kind: 'refund', key: `order:${paid.orderId}:refund` },
    ]);
    expect(await journal(`order:${paid.orderId}:refund`)).toEqual([
      { account: 'customer_funds', amount: '3.9900' },
      { account: 'vat_payable', amount: '0.8000' },
      { account: 'gateway_clearing', amount: '-4.7900' },
    ]);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // One gateway job for the refund, none for dispatch.
    const events = await refundEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregateId).toBe(rows[0]!.id);
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(0);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'rejected', dispatchState: 'done' });
  }

  it('opens one refund of the whole payment requested by the staff member, posts one journal and queues one gateway job', async () => {
    await holdFirstOrders();
    const paid = await paidOrder(t, clock, world);
    const res = await risk.post(`/admin/risk/orders/${paid.orderId}/refund`, {
      reason: 'Card owner did not match',
      blockEmail: false,
      blockDevice: false,
    });
    expect(res.status).toBe(204);
    await expectWholeRefund(paid, 'staff', risk.staffId);
    expect(await assessmentOf(db, paid.orderId)).toMatchObject({ outcome: 'refunded', reviewedBy: risk.staffId });
    expect((await auditOf(db, paid.orderId)).map((row) => row.action)).toEqual(['refunded after risk review']);
    // The refund shows on the Refunds page like a staff rejection's.
    const shown = await staff.get(`/admin/refunds/${(await refundRows())[0]!.id}`);
    expect(shown.body).toMatchObject({ status: 'processing', requestedBy: { type: 'staff', name: 'Rami K.' } });
  });

  it('a second refund answers 409 NOT_HELD and writes no second journal, refund or job', async () => {
    await holdFirstOrders();
    const paid = await paidOrder(t, clock, world);
    expect((await risk.post(`/admin/risk/orders/${paid.orderId}/refund`, {})).status).toBe(204);
    const again = await risk.post(`/admin/risk/orders/${paid.orderId}/refund`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOT_HELD');
    await expectWholeRefund(paid, 'staff', risk.staffId);
  });
});

describe('a payment the rules block', () => {
  it('refunds it at once as the system: a processing refund, the b2c_refund journal and the refund.process event, no dispatch', async () => {
    await blockFirstOrders();
    const paid = await paidOrder(t, clock, world);
    const order = await orderRow(db, paid.orderId);
    // The order was placed held, then rejected by the system with the first signal as the reason.
    expect(order).toMatchObject({
      status: 'rejected',
      dispatchState: 'done',
      resultCode: 'Refunded after risk review: New customer, first order above $1',
    });
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(0);
    const rows = await refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      paymentId: paid.paymentId,
      amount: '3.8400',
      method: 'original',
      status: 'processing',
      requestedByType: 'system',
      requestedById: null,
      approvedBy: null,
      ledgerTxId: expect.any(Number),
    });
    expect(await journal(`order:${paid.orderId}:refund`)).toEqual([
      { account: 'customer_funds', amount: '3.9900' },
      { account: 'vat_payable', amount: '0.8000' },
      { account: 'gateway_clearing', amount: '-4.7900' },
    ]);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await refundEvents()).toHaveLength(1);
    // The assessment records the block and its refund; nobody reviewed it, and no blocklist entry or audit row was added.
    expect(await assessmentOf(db, paid.orderId)).toMatchObject({
      decision: 'block',
      score: 18,
      outcome: 'refunded',
      reviewedBy: null,
    });
    expect(await blocklistRows(db)).toEqual([]);
    expect(await auditOf(db, paid.orderId)).toEqual([]);
    const types = (await eventsOf(db, paid.orderId)).map((event) => event.type);
    expect(types).toEqual(['created', 'paid', 'review', 'risk', 'refund']);
    // The checkout is paid and points at the order; the Risk page does not list it, but its recent decisions do.
    const [session] = await db.select().from(s.checkoutSessions);
    expect(session).toMatchObject({ status: 'paid', orderId: paid.orderId });
    const queue = (await risk.get('/admin/risk/queue')).body;
    expect(queue.held).toEqual([]);
    expect(queue.recent[0]).toMatchObject({ orderId: paid.orderId, outcome: 'refunded', reviewedBy: null });
  });

  it('blocks a card fingerprint on the blocklist even when the score is low', async () => {
    await insertBlock(t, db, 'card', 'fp_stolen');
    const paid = await paidOrder(t, clock, world, {
      card: { brand: 'visa', last4: '4242', fingerprint: 'fp_stolen', threeDs: true },
    });
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'rejected' });
    expect(await assessmentOf(db, paid.orderId)).toMatchObject({
      decision: 'block',
      score: 100,
      signals: ['Card is on the blocklist'],
    });
    expect(await refundRows()).toHaveLength(1);
    expect(await refundEvents()).toHaveLength(1);
  });

  it('refunds even while autoRefundFailed is off: the rules decided, not a failed delivery', async () => {
    expect((await staff.patch('/admin/storefront/settings', { autoRefundFailed: false })).status).toBe(200);
    await blockFirstOrders();
    const paid = await paidOrder(t, clock, world);
    const [refund] = await refundRows();
    expect(refund).toMatchObject({ status: 'processing', requestedByType: 'system', paymentId: paid.paymentId });
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
  });

  it('tells the buyer the order failed and was refunded, not that it was received', async () => {
    await seedDefaultTemplates(db);
    await blockFirstOrders();
    const paid = await paidOrder(t, clock, world);
    const mails = await notificationRows(db);
    expect(mails.map((row) => row.event)).toEqual(['order.failed']);
    expect(mails[0]).toMatchObject({
      recipientType: 'customer',
      recipientId: (await orderRow(db, paid.orderId)).customerId,
    });
  });
});
