// Integration tests of refunds of a payment that is charged back (decision 048) on the real application, Postgres and the fake gateway: a
// refund the gateway fails after the chargeback is closed and its journal reversed, as the chargeback closes the refunds the gateway has
// not paid; a retried refund counts as not sent at a chargeback; a refund the gateway accepted is not sent or closed again by its job
// while the payment is disputed or charged back; a refund the gateway completes after the chargeback keeps both journals;
// and the gateway's answer to a refund reads the payment under its lock, so a dispute recorded meanwhile is kept.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { RefundProcessModule, RefundSender } from '@src/modules/money';
import { RefundSettlement } from '@src/modules/money/application/refund-settlement';
import { CHARGEBACK_NOT_SENT_NOTE } from '@src/modules/money/domain/refund-rules';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  type B2cWorld,
  B2cGateway,
  type PaidOrder,
  b2cWorld,
  disputeEvent,
  hook,
  paidOrder,
  refundEvent,
} from '../../support/b2c';
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
  staff = await adminWith(t, ['orders:*', 'refunds:*', 'disputes:*', 'reports:*'], { name: 'Layla Haddad' });
});

const unique = () => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;
const refundRows = () => db.select().from(s.refunds).orderBy(s.refunds.id);
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
/** What the journals of an order moved, per account kind; `kind` narrows to one kind of journal. */
const orderNet = async (orderId: number, kind?: string) =>
  (
    await db.execute<{ kind: string; net: string }>(sql`
      select la.kind, sum(le.amount)::numeric(18,4)::text as net
      from ledger_entries le
      join ledger_accounts la on la.id = le.account_id
      join ledger_transactions lt on lt.id = le.transaction_id
      where lt.ref_type = 'order' and lt.ref_id = ${orderId} and (${kind ?? null}::text is null or lt.kind = ${kind ?? null})
      group by la.kind order by la.kind`)
  ).rows;

/** What one ledger transaction moved, per account kind (debit positive). */
async function linesOf(transactionId: number): Promise<Record<string, string>> {
  const result = await db.execute<{ kind: string; amount: string }>(sql`
    select la.kind, sum(le.amount)::numeric(18,4)::text as amount
    from ledger_entries le join ledger_accounts la on la.id = le.account_id
    where le.transaction_id = ${transactionId}
    group by la.kind order by la.kind`);
  return Object.fromEntries(result.rows.map((row) => [row.kind, row.amount]));
}

/** The dispute fee the fake gateway reports (GBP 12.00), in USD at the checkout's locked rate. */
async function disputeFeeUsd(paid: PaidOrder): Promise<Decimal> {
  const order = await orderRow(db, paid.orderId);
  const [session] = await db
    .select()
    .from(s.checkoutSessions)
    .where(eq(s.checkoutSessions.id, order.checkoutSessionId!));
  return new Decimal('12').div(session!.fxRate).toDecimalPlaces(4);
}

/** The VAT report's totals of the month. */
async function vatTotals() {
  const res = await staff.get('/admin/reports/vat?from=2026-11-01&to=2026-11-30');
  expect(res.status).toBe(200);
  return res.body.totals as { orders: number; taxable: string; vat: string };
}

/** The gateway reports a dispute of the whole payment; `status` closes it. */
async function dispute(paid: PaidOrder, gatewayId: string, status?: 'won' | 'lost') {
  const body = disputeEvent(`evt_${unique()}`, {
    dispute: gatewayId,
    intent: paid.intent,
    ...(status === undefined ? {} : { type: 'charge.dispute.closed', status }),
  });
  expect((await hook(t, clock, 'disputes', world.gateway.code, body)).statusCode).toBe(200);
}

/** A paid order rejected by staff: its whole payment is booked back and the refund waits for the gateway job. */
async function rejected() {
  const paid = await paidOrder(t, clock, world);
  expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(204);
  const [refund] = await refundRows();
  expect(refund).toMatchObject({ status: 'processing' });
  expect(refund!.ledgerTxId).not.toBeNull();
  return { paid, refund: refund! };
}

/**
 * The books of a never delivered order whose refund was closed unsent: the refund and its reversal cancel out, the chargeback is the one
 * outflow, and what the sale booked as customer funds and VAT goes back against the loss: inside the loss's journal when the refund was
 * closed at the loss, in a journal of its own when the gateway's failure closed it after the loss.
 */
async function expectMoneyLeftOnce(paid: PaidOrder, ledgerTxId: number, closed: 'at the loss' | 'after the loss') {
  const journals = await ledgerOf(db, paid.orderId);
  expect(journals.map((entry) => entry.kind).sort()).toEqual(
    closed === 'at the loss'
      ? ['b2c_payment', 'chargeback', 'gateway_fee', 'refund', 'refund']
      : ['b2c_payment', 'chargeback', 'chargeback', 'gateway_fee', 'refund', 'refund'],
  );
  expect(journals.filter((entry) => entry.key === `reverse:${ledgerTxId}`)).toHaveLength(1);
  expect(journals.filter((entry) => entry.key === `order:${paid.orderId}:chargeback-return`)).toHaveLength(
    closed === 'at the loss' ? 0 : 1,
  );
  expect((await orderNet(paid.orderId, 'refund')).map((row) => row.net)).toEqual(['0.0000', '0.0000', '0.0000']);
  // Per account, debit positive: the payment (4.79) came in and left once with the chargeback, with the gateway fee (2.9 % + 0.30 =
  // 0.4389) and the dispute fee (GBP 12.00 = 14.9654); customer funds and VAT are back to zero and only the dispute fee is a loss.
  expect(Object.fromEntries((await orderNet(paid.orderId)).map((row) => [row.kind, row.net]))).toEqual({
    chargeback_loss: '14.9654',
    customer_funds: '0.0000',
    gateway_clearing: '-15.4043',
    gateway_fees: '0.4389',
    vat_payable: '0.0000',
  });
  const vat = await vatTotals();
  expect(vat).toEqual({ orders: 1, taxable: '0.0000', vat: '0.0000' });
  expect(await systemBalance(db, 'vat_payable')).toBe(vat.vat);
  expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
}

describe('a refund of a charged-back payment never stays booked unless the gateway paid it (decision 048)', () => {
  it('a refund the gateway fails after the chargeback is closed and its journal reversed', async () => {
    const { paid, refund } = await rejected();
    // The gateway takes the refund and has not finished it when the buyer's bank opens a dispute that the shop loses.
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const taken = (await refundRows())[0]!;
    await dispute(paid, 'dp_pending');
    await dispute(paid, 'dp_pending', 'lost');
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    expect((await refundRows())[0]).toMatchObject({ status: 'processing', gatewayRefundId: taken.gatewayRefundId });

    // The gateway then fails the refund: the card network has already returned the money.
    const failed = refundEvent(`evt_${unique()}`, {
      refund: taken.gatewayRefundId!,
      refundId: refund.id,
      sendAttempt: 1,
      type: 'refund.failed',
      failure: 'charge_disputed',
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, failed)).statusCode).toBe(200);
    expect((await refundRows())[0]).toMatchObject({ status: 'rejected', note: CHARGEBACK_NOT_SENT_NOTE });
    await expectMoneyLeftOnce(paid, refund.ledgerTxId!, 'after the loss');
    expect(await eventsOf(db, paid.orderId)).toContainEqual(
      expect.objectContaining({
        type: 'refund',
        data: expect.objectContaining({ message: CHARGEBACK_NOT_SENT_NOTE, refundId: refund.id }),
      }),
    );
    // Nothing is left to send, and a repeated delivery changes nothing.
    expect((await staff.post(`/admin/refunds/${refund.id}/retry`, {})).status).toBe(409);
    expect((await hook(t, clock, 'payments', world.gateway.code, failed)).statusCode).toBe(200);
    expect((await ledgerOf(db, paid.orderId)).filter((entry) => entry.kind === 'refund')).toHaveLength(2);
    expect(fake.calls('/v1/refunds')).toHaveLength(1);
  });

  it('a retried refund has no gateway refund yet, so a chargeback before its send closes it', async () => {
    const { paid, refund } = await rejected();
    // The gateway refuses the refund for good, with a refund object of its own.
    fake.refund = { status: 'failed', failure: 'expired_or_canceled_card' };
    expect(await sender.send(refund.id, false)).toBe('failed');
    expect((await refundRows())[0]!.gatewayRefundId).not.toBeNull();
    const refused = (await refundRows())[0]!;
    const retried = await staff.post(`/admin/refunds/${refund.id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'processing', gatewayRefundId: null });
    // The audit row records the gateway refund id the retry cleared.
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'retried refund'));
    expect(audit).toMatchObject({
      entityId: refund.id,
      before: { status: 'failed', gatewayRefundId: refused.gatewayRefundId },
      after: { status: 'processing', gatewayRefundId: null },
    });

    await dispute(paid, 'dp_retried');
    await dispute(paid, 'dp_retried', 'lost');
    expect((await refundRows())[0]).toMatchObject({ status: 'rejected', note: CHARGEBACK_NOT_SENT_NOTE });
    // The job finds nothing to send.
    fake.refund = { status: 'succeeded' };
    expect(await sender.send(refund.id, false)).toBe('skipped');
    expect(fake.calls('/v1/refunds')).toHaveLength(1);
    await expectMoneyLeftOnce(paid, refund.ledgerTxId!, 'at the loss');
  });

  it('a failed refund of a charged-back payment is closed by its send instead of being sent', async () => {
    const { paid, refund } = await rejected();
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    await dispute(paid, 'dp_stored');
    await dispute(paid, 'dp_stored', 'lost');
    // A refund left failed beside the chargeback (as stored before the failure closed it).
    await db.update(s.refunds).set({ status: 'failed', note: 'charge_disputed' }).where(eq(s.refunds.id, refund.id));

    expect((await staff.post(`/admin/refunds/${refund.id}/retry`, {})).status).toBe(200);
    expect(await sender.send(refund.id, false)).toBe('failed');
    expect((await refundRows())[0]).toMatchObject({ status: 'rejected', note: CHARGEBACK_NOT_SENT_NOTE });
    expect(fake.calls('/v1/refunds')).toHaveLength(1);
    await expectMoneyLeftOnce(paid, refund.ledgerTxId!, 'after the loss');
  });

  it('a refund the gateway completes after the chargeback stays completed with both journals', async () => {
    const { paid, refund } = await rejected();
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const taken = (await refundRows())[0]!;
    await dispute(paid, 'dp_paid');
    await dispute(paid, 'dp_paid', 'lost');
    const succeeded = refundEvent(`evt_${unique()}`, {
      refund: taken.gatewayRefundId!,
      refundId: refund.id,
      sendAttempt: 1,
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, succeeded)).statusCode).toBe(200);
    expect((await refundRows())[0]).toMatchObject({ status: 'completed' });
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'refund',
      'chargeback',
    ]);
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    // The gateway paid both: the refund took the customer funds and the VAT back, so the loss gives nothing back and the money left
    // clearing twice (4.79 refunded, 4.79 + the GBP 12.00 dispute fee charged back, and the gateway fee).
    expect(Object.fromEntries((await orderNet(paid.orderId)).map((row) => [row.kind, row.net]))).toEqual({
      chargeback_loss: '19.7554',
      customer_funds: '0.0000',
      gateway_clearing: '-20.1943',
      gateway_fees: '0.4389',
      vat_payable: '0.0000',
    });
    expect(await vatTotals()).toEqual({ orders: 1, taxable: '0.0000', vat: '0.0000' });
  });

  it('a job run again for a refund the gateway accepted, after the chargeback, sends nothing and leaves the refund to the gateway', async () => {
    const { paid, refund } = await rejected();
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const taken = (await refundRows())[0]!;
    await dispute(paid, 'dp_rerun');
    await dispute(paid, 'dp_rerun', 'lost');
    expect((await refundRows())[0]).toEqual(taken);

    // The refund.process job runs again (a repeated event or a stalled job): the gateway already holds this refund.
    expect(await sender.send(refund.id, false)).toBe('skipped');
    expect((await refundRows())[0]).toEqual(taken);
    // A failure without a definite answer does not close it either: the gateway's own answer settles it.
    const settlement = t.app.get(RefundSettlement, { strict: false });
    expect(
      await settlement.settle(refund.id, {
        kind: 'failed',
        note: 'The payment gateway answered 503.',
        attempt: 1,
        unanswered: true,
      }),
    ).toBe(false);
    expect((await refundRows())[0]).toEqual(taken);
    expect(fake.calls('/v1/refunds')).toHaveLength(1);

    // The gateway pays the refund: it completes, and the books keep the refund next to the chargeback.
    const succeeded = refundEvent(`evt_${unique()}`, {
      refund: taken.gatewayRefundId!,
      refundId: refund.id,
      sendAttempt: 1,
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, succeeded)).statusCode).toBe(200);
    expect((await refundRows())[0]).toMatchObject({ status: 'completed', gatewayRefundId: taken.gatewayRefundId });
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'refund',
      'chargeback',
    ]);
  });

  it('a job run again for a refund the gateway accepted while the payment is disputed sends nothing, and a loss leaves it to the gateway', async () => {
    const { paid, refund } = await rejected();
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const taken = (await refundRows())[0]!;
    await dispute(paid, 'dp_open');
    expect(await sender.send(refund.id, false)).toBe('skipped');
    expect((await refundRows())[0]).toEqual(taken);
    await dispute(paid, 'dp_open', 'lost');
    expect((await refundRows())[0]).toEqual(taken);

    const succeeded = refundEvent(`evt_${unique()}`, {
      refund: taken.gatewayRefundId!,
      refundId: refund.id,
      sendAttempt: 1,
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, succeeded)).statusCode).toBe(200);
    expect((await refundRows())[0]).toMatchObject({ status: 'completed', gatewayRefundId: taken.gatewayRefundId });
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'refund',
      'chargeback',
    ]);
    expect(fake.calls('/v1/refunds')).toHaveLength(1);
  });
});

describe('a refund the gateway accepted and fails after the loss leaves the books as the chargeback rules say', () => {
  /** The journal that gives back what the sale of the order booked (one per order). */
  const giveBackOf = (orderId: number) =>
    db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `order:${orderId}:chargeback-return`));

  /** The gateway's `refund.failed` for the refund it accepted. */
  const failure = (gatewayRefundId: string, refundId: number) =>
    refundEvent(`evt_${unique()}`, {
      refund: gatewayRefundId,
      refundId,
      sendAttempt: 1,
      type: 'refund.failed',
      failure: 'charge_disputed',
    });

  it('an order that was never delivered: its customer funds and VAT end at zero and only the dispute fee is a loss', async () => {
    const { paid, refund } = await rejected();
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const taken = (await refundRows())[0]!;
    await dispute(paid, 'dp_never_delivered');
    await dispute(paid, 'dp_never_delivered', 'lost');
    const fee = await disputeFeeUsd(paid);
    // The refund is still the gateway's: its journal is in place, so the loss gives nothing back.
    expect((await refundRows())[0]).toMatchObject({ status: 'processing', gatewayRefundId: taken.gatewayRefundId });
    expect(await systemBalance(db, 'chargeback_loss')).toBe(fee.add('4.79').toFixed(4));

    const failed = failure(taken.gatewayRefundId!, refund.id);
    expect((await hook(t, clock, 'payments', world.gateway.code, failed)).statusCode).toBe(200);
    expect((await refundRows())[0]).toMatchObject({ status: 'rejected', note: CHARGEBACK_NOT_SENT_NOTE });
    // The refund's journal is reversed, and the sale was undone by the chargeback: nothing is owed to the buyer and no VAT is due.
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect(await systemBalance(db, 'chargeback_loss')).toBe(fee.toFixed(4));
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await vatTotals()).toEqual({ orders: 1, taxable: '0.0000', vat: '0.0000' });
    // What the sale booked goes back against the loss: Dr customer_funds 3.99, Dr vat_payable 0.80 / Cr chargeback_loss 4.79.
    const [back] = await giveBackOf(paid.orderId);
    expect(back).toMatchObject({ kind: 'chargeback', refType: 'order', refId: paid.orderId });
    expect(await linesOf(back!.id)).toEqual({
      chargeback_loss: '-4.7900',
      customer_funds: '3.9900',
      vat_payable: '0.8000',
    });

    // A repeated delivery of the failure books nothing more.
    expect((await hook(t, clock, 'payments', world.gateway.code, failed)).statusCode).toBe(200);
    expect(await giveBackOf(paid.orderId)).toHaveLength(1);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'chargeback_loss')).toBe(fee.toFixed(4));
  });

  it('a delivered order keeps the plain loss, and its VAT stays owed', async () => {
    const paid = await paidOrder(t, clock, world);
    expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
    const accountId = (await orderRow(db, paid.orderId)).accountId;
    const [requested] = await db
      .insert(s.refunds)
      .values({
        paymentId: paid.paymentId,
        orderId: paid.orderId,
        accountId,
        amount: paid.charged,
        currency: 'GBP',
        reason: 'The code did not work',
        method: 'original',
        status: 'requested',
        requestedByType: 'account',
        requestedById: accountId,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })
      .returning();
    expect((await staff.post(`/admin/refunds/${requested!.id}/approve`, {})).status).toBe(200);
    fake.refund = { status: 'pending' };
    expect(await sender.send(requested!.id, false)).toBe('pending');
    const taken = (await refundRows())[0]!;
    await dispute(paid, 'dp_delivered_late');
    await dispute(paid, 'dp_delivered_late', 'lost');
    const fee = await disputeFeeUsd(paid);

    expect(
      (await hook(t, clock, 'payments', world.gateway.code, failure(taken.gatewayRefundId!, taken.id))).statusCode,
    ).toBe(200);
    expect((await refundRows())[0]).toMatchObject({ status: 'rejected', note: CHARGEBACK_NOT_SENT_NOTE });
    // The refund of the revenue is reversed; nothing goes back from the loss.
    expect(await giveBackOf(paid.orderId)).toEqual([]);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.8000');
    expect(await systemBalance(db, 'chargeback_loss')).toBe(fee.add('4.79').toFixed(4));
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await vatTotals()).toEqual({ orders: 1, taxable: '3.9900', vat: '0.8000' });
  });
});

describe('the gateway answer to a refund and a dispute recorded at the same moment', () => {
  it('keeps the payment disputed when the dispute commits while the refund completes', async () => {
    const { paid, refund } = await rejected();
    const settlement = t.app.get(RefundSettlement, { strict: false });
    let settled: Promise<boolean> | undefined;
    // Another transaction records the dispute and holds the payment's row until it commits.
    await db.transaction(async (tx) => {
      await tx.update(s.payments).set({ status: 'disputed' }).where(eq(s.payments.id, paid.paymentId));
      settled = settlement.settle(refund.id, { kind: 'completed', gatewayRefundId: 're_same_moment' });
      await Bun.sleep(400);
    });
    expect(await settled!).toBe(true);
    expect((await refundRows())[0]).toMatchObject({ status: 'completed', gatewayRefundId: 're_same_moment' });
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
  });
});
