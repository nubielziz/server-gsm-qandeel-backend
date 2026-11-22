// Integration tests of order-engine refunds of a payment the buyer disputed with the card network (decision 048): a staff reject, a supplier
// rejection and a risk refund open a refund request instead of paying out; the request waits until the dispute is won; a refund opened
// before the dispute is not sent to the gateway while the dispute is open; and a chargeback closes the refunds the gateway has not paid,
// locking only those, while the VAT report leaves the reversed refund out.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, pgErrorInfo, schema as s } from '@src/infra/db';
import { B2cRefunds, RefundProcessModule, RefundSender } from '@src/modules/money';
import { CHARGEBACK_NOT_SENT_NOTE } from '@src/modules/money/domain/refund-rules';
import { DISPUTED_REFUND_NOTE } from '@src/modules/money/jobs/refund-sender';
import { OrderSupplierMoves } from '@src/modules/orders';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, disputeEvent, hook, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { notificationRows, seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, ledgerOf, orderRow, systemBalance } from '../../support/orders';
import { insertBareSupplier } from '../../support/suppliers';

const clock = new TestClock('2026-11-21T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;
let sender: RefundSender;
let counter = 0;

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
  clock.set('2026-11-21T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
  await seedDefaultTemplates(db);
  staff = await adminWith(t, ['orders:*', 'refunds:*', 'disputes:*', 'risk:*', 'settings:*'], { name: 'Layla Haddad' });
});

const unique = () => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;
const refundRows = () => db.select().from(s.refunds);
const refundEvents = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'));
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const refundJournals = async (orderId: number) =>
  (await ledgerOf(db, orderId)).filter((entry) => entry.kind === 'refund');
/** What the refund journals of an order (the refunds and their reversals) moved, per account kind. */
const refundNet = async (orderId: number) =>
  (
    await db.execute<{ kind: string; net: string }>(sql`
      select la.kind, sum(le.amount)::numeric(18,4)::text as net
      from ledger_entries le
      join ledger_accounts la on la.id = le.account_id
      join ledger_transactions lt on lt.id = le.transaction_id
      where lt.ref_type = 'order' and lt.ref_id = ${orderId} and lt.kind = 'refund'
      group by la.kind order by la.kind`)
  ).rows;
const chargebacks = (orderId: number) =>
  db
    .select()
    .from(s.ledgerTransactions)
    .where(and(eq(s.ledgerTransactions.refId, orderId), eq(s.ledgerTransactions.kind, 'chargeback')));
const DISPUTED_LINE =
  'Refund of $4.79 is waiting for staff: the buyer disputed this payment with the card network, so nothing was sent back';

/** The gateway reports a dispute of the whole payment; `status` closes it. */
async function dispute(paid: PaidOrder, gatewayId: string, status?: 'won' | 'lost') {
  const body = disputeEvent(`evt_${unique()}`, {
    dispute: gatewayId,
    intent: paid.intent,
    ...(status === undefined ? {} : { type: 'charge.dispute.closed', status }),
  });
  expect((await hook(t, clock, 'disputes', world.gateway.code, body)).statusCode).toBe(200);
}

/** What a request opened instead of a payout must look like: requested by the system, nothing posted, sent or mailed. */
async function expectRequestOnly(paid: PaidOrder) {
  const refunds = await refundRows();
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({
    paymentId: paid.paymentId,
    orderId: paid.orderId,
    status: 'requested',
    requestedByType: 'system',
    requestedById: null,
    ledgerTxId: null,
  });
  expect(await refundJournals(paid.orderId)).toHaveLength(0);
  expect(await refundEvents()).toHaveLength(0);
  expect((await notificationRows(db)).map((row) => row.event)).not.toContain('order.failed');
  return refunds[0]!;
}

describe('order-engine refunds of a disputed payment (decision 048)', () => {
  it('a staff reject of an order whose payment is disputed opens a refund request and sends nothing', async () => {
    const paid = await paidOrder(t, clock, world);
    await dispute(paid, 'dp_reject');
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
    const res = await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' });
    expect(res.status).toBe(204);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'rejected' });
    await expectRequestOnly(paid);
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'refund',
      data: expect.objectContaining({ message: DISPUTED_LINE, requested: true, disputed: true }),
    });
  });

  it('a supplier rejection of a disputed payment opens a request while autoRefundFailed is on', async () => {
    const paid = await paidOrder(t, clock, world);
    await dispute(paid, 'dp_supplier');
    const supplierId = await insertBareSupplier(db);
    await db
      .update(s.orders)
      .set({ status: 'processing', dispatchState: 'sent', supplierId, supplierRef: 'REF-1' })
      .where(eq(s.orders.id, paid.orderId));
    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    await db.transaction((tx) =>
      moves.settle(tx, {
        orderId: paid.orderId,
        result: 'rejected',
        supplierId,
        supplierRef: 'REF-1',
        text: 'Blacklisted',
      }),
    );
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'rejected' });
    await expectRequestOnly(paid);
  });

  it('a risk refund of a held order whose payment was charged back opens a request', async () => {
    // Rules that hold any first order above 1 USD.
    const rules = (await staff.get('/admin/risk/rules')).body.rules as Array<{
      id: string;
      on: boolean;
      value: number | null;
    }>;
    const changed = { reviewFirstOrderAbove: 1, reviewThreshold: 10 } as Record<string, number>;
    const body = { rules: rules.map(({ id, on, value }) => ({ id, on, value: id in changed ? changed[id]! : value })) };
    expect((await staff.put('/admin/risk/rules', body)).status).toBe(200);
    const paid = await paidOrder(t, clock, world);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ dispatchState: 'held' });
    await dispute(paid, 'dp_risk');
    await dispute(paid, 'dp_risk', 'lost');
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    expect((await staff.post(`/admin/risk/orders/${paid.orderId}/refund`, {})).status).toBe(204);
    await expectRequestOnly(paid);
    const lines = (await eventsOf(db, paid.orderId)).slice(-2);
    expect(lines[0]).toMatchObject({ type: 'risk' });
    expect(String(lines[0]!.data.message)).toStartWith('Risk review: refund waits for staff');
    expect(lines[1]).toMatchObject({ type: 'refund', data: expect.objectContaining({ message: DISPUTED_LINE }) });
  });

  it('the request is refused while the dispute is open and approved once it is won', async () => {
    const paid = await paidOrder(t, clock, world);
    await dispute(paid, 'dp_approve');
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const request = await expectRequestOnly(paid);
    const refused = await staff.post(`/admin/refunds/${request.id}/approve`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    await dispute(paid, 'dp_approve', 'won');
    expect((await paymentRow(paid.paymentId)).status).toBe('captured');
    const approved = await staff.post(`/admin/refunds/${request.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'processing' });
    expect(await refundEvents()).toHaveLength(1);
  });

  it('a refund opened before the dispute is not sent while the payment is disputed, and is sent once the dispute is won', async () => {
    const paid = await paidOrder(t, clock, world);
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const [refund] = await refundRows();
    expect(refund).toMatchObject({ status: 'processing' });
    await dispute(paid, 'dp_late');
    expect(await sender.send(refund!.id, false)).toBe('failed');
    expect(fake.calls('/v1/refunds')).toHaveLength(0);
    expect((await refundRows())[0]).toMatchObject({ status: 'failed', note: DISPUTED_REFUND_NOTE, sendAttempt: 1 });
    await dispute(paid, 'dp_late', 'won');
    const retried = await staff.post(`/admin/refunds/${refund!.id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(await sender.send(refund!.id, false)).toBe('completed');
    const calls = fake.calls('/v1/refunds');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['idempotency-key']).toBe(`refund-${refund!.id}`);
  });
});

describe('a chargeback closes the refunds the gateway has not paid (decision 048)', () => {
  /** A paid order rejected by staff: its refund is opened and booked, then the buyer's bank opens a dispute and the refund is not sent. */
  async function bookedThenDisputed(disputeId: string) {
    const paid = await paidOrder(t, clock, world);
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const [refund] = await refundRows();
    expect(refund).toMatchObject({ status: 'processing' });
    expect(refund!.ledgerTxId).not.toBeNull();
    await dispute(paid, disputeId);
    expect(await sender.send(refund!.id, false)).toBe('failed');
    return { paid, refund: refund! };
  }

  it('a booked refund that was not sent is closed and its journal reversed when the dispute is lost: the money leaves once', async () => {
    const { paid, refund } = await bookedThenDisputed('dp_lost');
    await dispute(paid, 'dp_lost', 'lost');
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    expect((await refundRows())[0]).toMatchObject({
      id: refund.id,
      status: 'rejected',
      note: CHARGEBACK_NOT_SENT_NOTE,
    });
    // The refund's journal and its reversal cancel out on every account; the chargeback is the one outflow.
    const journals = await ledgerOf(db, paid.orderId);
    expect(journals.map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'refund',
      'refund',
      'chargeback',
    ]);
    expect(journals[3]!.key).toBe(`reverse:${refund.ledgerTxId}`);
    expect((await refundNet(paid.orderId)).map((row) => row.net)).toEqual(['0.0000', '0.0000', '0.0000']);
    expect(await chargebacks(paid.orderId)).toHaveLength(1);
    expect(fake.calls('/v1/refunds')).toHaveLength(0);
    // The refund as the console shows it, and the order's timeline, say it was not sent.
    const shown = await staff.get(`/admin/refunds/${refund.id}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ status: 'rejected', note: CHARGEBACK_NOT_SENT_NOTE });
    const lines = await eventsOf(db, paid.orderId);
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: 'refund',
        data: expect.objectContaining({ message: CHARGEBACK_NOT_SENT_NOTE, refundId: refund.id }),
      }),
    );
    // A closed refund cannot be sent again.
    expect((await staff.post(`/admin/refunds/${refund.id}/retry`, {})).status).toBe(409);
    // The VAT report ties to the books: the refund and its reversal are left out, so the payment's VAT is what vat_payable holds.
    const finance = await adminWith(t, ['reports:finance'], { name: 'Omar Saleh' });
    const vat = await finance.get('/admin/reports/vat?from=2026-11-01&to=2026-11-30');
    expect(vat.status).toBe(200);
    expect(vat.body.totals).toEqual({ orders: 1, taxable: '3.9900', vat: '0.8000' });
    expect(await systemBalance(db, 'vat_payable')).toBe(vat.body.totals.vat);
  });

  it('a refund request opened during the dispute is closed too, with nothing to reverse', async () => {
    const paid = await paidOrder(t, clock, world);
    await dispute(paid, 'dp_request');
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const request = await expectRequestOnly(paid);
    await dispute(paid, 'dp_request', 'lost');
    expect((await refundRows())[0]).toMatchObject({
      id: request.id,
      status: 'rejected',
      note: CHARGEBACK_NOT_SENT_NOTE,
    });
    expect(await refundJournals(paid.orderId)).toHaveLength(0);
    expect(await chargebacks(paid.orderId)).toHaveLength(1);
  });

  it('a refund the gateway completed before the dispute keeps both journals', async () => {
    const paid = await paidOrder(t, clock, world);
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const [refund] = await refundRows();
    expect(await sender.send(refund!.id, false)).toBe('completed');
    await dispute(paid, 'dp_after');
    await dispute(paid, 'dp_after', 'lost');
    expect((await refundRows())[0]).toMatchObject({ id: refund!.id, status: 'completed' });
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'refund',
      'chargeback',
    ]);
  });

  it('a replay of the loss event changes nothing', async () => {
    const { paid, refund } = await bookedThenDisputed('dp_replay');
    await dispute(paid, 'dp_replay', 'lost');
    const journals = await ledgerOf(db, paid.orderId);
    const closed = (await refundRows())[0];
    const timeline = await eventsOf(db, paid.orderId);
    const replay = disputeEvent(`evt_${unique()}`, {
      dispute: 'dp_replay',
      intent: paid.intent,
      type: 'charge.dispute.closed',
      status: 'lost',
    });
    const res = await hook(t, clock, 'disputes', world.gateway.code, replay);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(await ledgerOf(db, paid.orderId)).toEqual(journals);
    expect((await refundRows())[0]).toEqual(closed);
    expect(await eventsOf(db, paid.orderId)).toHaveLength(timeline.length);
    expect(closed).toMatchObject({ id: refund.id, status: 'rejected' });
  });

  it('locks only the refunds it closes: a refund the gateway acknowledged is never locked', async () => {
    const paid = await paidOrder(t, clock, world);
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const [acknowledged] = await refundRows();
    // The gateway took this refund and has not answered yet.
    await db.update(s.refunds).set({ gatewayRefundId: 're_taken' }).where(eq(s.refunds.id, acknowledged!.id));
    const [request] = await db
      .insert(s.refunds)
      .values({
        paymentId: paid.paymentId,
        orderId: paid.orderId,
        customerId: acknowledged!.customerId,
        amount: '1.0000',
        currency: acknowledged!.currency,
        reason: 'Asked by the buyer',
        method: 'original',
        status: 'requested',
        requestedByType: 'system',
      })
      .returning();
    await dispute(paid, 'dp_locks');
    const refunds = t.app.get(B2cRefunds, { strict: false });
    /** Whether another connection can lock the refund's row right now. */
    const lockState = (id: number) =>
      db.execute(sql`select id from refunds where id = ${id} for update nowait`).then(
        () => 'free',
        (error: unknown) => (pgErrorInfo(error)?.code === '55P03' ? 'locked' : String(error)),
      );
    await db.transaction(async (tx) => {
      const [payment] = await tx.select().from(s.payments).where(eq(s.payments.id, paid.paymentId)).for('update');
      const closed = await refunds.closeNotSent(tx, payment!, { type: 'system', id: null });
      expect(closed.map((refund) => refund.id)).toEqual([request!.id]);
      expect(await lockState(acknowledged!.id)).toBe('free');
      expect(await lockState(request!.id)).toBe('locked');
    });
    const after = await refundRows();
    expect(after.find((refund) => refund.id === acknowledged!.id)).toMatchObject({
      status: 'processing',
      gatewayRefundId: 're_taken',
    });
    expect(after.find((refund) => refund.id === request!.id)).toMatchObject({
      status: 'rejected',
      note: CHARGEBACK_NOT_SENT_NOTE,
    });
  });

  it('a loss the database ends in a deadlock answers 503 and writes nothing; the next delivery books it', async () => {
    const { paid, refund } = await bookedThenDisputed('dp_clash');
    const body = disputeEvent(`evt_${unique()}`, {
      dispute: 'dp_clash',
      intent: paid.intent,
      type: 'charge.dispute.closed',
      status: 'lost',
    });
    // The refund settlement holds the refund and waits for the payment: Postgres ends the dispute's transaction.
    const deadlock = new Error('Failed query', {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    });
    const clash = spyOn(B2cRefunds.prototype, 'closeNotSent').mockImplementationOnce(() => Promise.reject(deadlock));
    const first = await hook(t, clock, 'disputes', world.gateway.code, body).finally(() => clash.mockRestore());
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ code: 'UNAVAILABLE' });
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
    expect(await chargebacks(paid.orderId)).toHaveLength(0);
    expect((await refundRows())[0]).toMatchObject({ id: refund.id, status: 'failed' });
    // The gateway delivers the same event again.
    const again = await hook(t, clock, 'disputes', world.gateway.code, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ received: true });
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    expect(await chargebacks(paid.orderId)).toHaveLength(1);
    expect((await refundRows())[0]).toMatchObject({
      id: refund.id,
      status: 'rejected',
      note: CHARGEBACK_NOT_SENT_NOTE,
    });
  });
});
