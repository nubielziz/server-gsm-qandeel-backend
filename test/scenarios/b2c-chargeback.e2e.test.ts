// End-to-end walk of the map scenario `b2c-chargeback` (a dispute we lost, docs/slices/money.json steps 1 to 7) on the real application and a stand-in
// card gateway: the signed dispute event, the dispute record with its deadline, the evidence pack and its submission, the bank's decision and the loss
// in the books. The steps share one story, so the tests of this file run in order. Step 3 (the instant alert to staff) is the notifications feature's
// (12a) and marking the customer is the risk feature's (18): both plug in right after the stored dispute (`DisputeWebhookService`).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { GatewayTestModule } from '../support/billing';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, disputeEvent, hook, paidOrder } from '../support/b2c';
import { HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { eventsOf, ledgerOf, orderRow, systemBalance } from '../support/orders';

const gateway = new B2cGateway();
const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let world: B2cWorld;
let staff: AdminApi;
let paid: PaidOrder;
let disputeId = 0;
let ledgerTxId = 0;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, (await testDb()).db, gateway);
  staff = await adminWith(t, ['disputes:*', 'orders:*'], { name: 'Layla Haddad' });
  // The story starts with a delivered, paid order (GBP 3.84 = USD 4.79).
  paid = await paidOrder(t, clock, world, { email: 'jack@mail.example' });
  expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
});
afterAll(async () => {
  await gateway.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});

const dispute = async () => (await world.db.select().from(s.disputes).where(eq(s.disputes.id, disputeId)))[0]!;
const payment = async () => (await world.db.select().from(s.payments).where(eq(s.payments.id, paid.paymentId)))[0]!;

describe('scenario b2c-chargeback: a dispute we lost', () => {
  it('step 1: the cardholder disputes at the bank and the gateway reports it, with a deadline and a dispute fee', async () => {
    const due = Math.floor(clock.nowMs() / 1000) + 7 * 24 * 3600;
    const res = await hook(
      t,
      clock,
      'disputes',
      world.gateway.code,
      disputeEvent('evt_cb_1', {
        dispute: 'dp_cb_1',
        intent: paid.intent,
        dueBy: due,
        amount: 384,
        fee: 1200,
        reason: 'fraudulent',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });

  it('step 2: the dispute is stored as needs_response with its deadline and the payment and the order are marked', async () => {
    const [row] = await world.db.select().from(s.disputes);
    disputeId = row!.id;
    expect(row).toMatchObject({
      status: 'needs_response',
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      amount: '3.8400',
      fee: '12.0000',
      currency: 'GBP',
      reasonCode: 'fraudulent',
      submittedAt: null,
      resolvedAt: null,
    });
    expect(row!.evidenceDueAt.toISOString()).toBe('2026-11-14T12:00:00.000Z');
    expect((await payment()).status).toBe('disputed');
    expect((await eventsOf(world.db, paid.orderId)).at(-1)).toMatchObject({ type: 'dispute', actorType: 'system' });
    // The books do not move yet.
    expect(await systemBalance(world.db, 'chargeback_loss')).toBe('0.0000');
    const listed = await staff.get('/admin/disputes?status=needs_response');
    expect(listed.total).toBe(1);
  });

  it('step 4: staff open the dispute and the server has built the evidence pack from the order, the payment, the consents and the history', async () => {
    const one = await staff.get(`/admin/disputes/${disputeId}`);
    expect(one.status).toBe(200);
    expect(one.body.evidence.map((line: { key: string; ok: boolean }) => [line.key, line.ok])).toEqual([
      ['payment', true],
      ['three_ds', true],
      ['delivery', true],
      ['consents', true],
      ['history', false],
      ['contact', true],
    ]);
    expect(one.body.strength).toBe('strong');
    expect(one.body.evidenceDueAt).toBe('2026-11-14T12:00:00.000Z');
  });

  it('step 5: the pack is uploaded through the gateway API and the dispute is under_review with submitted_at', async () => {
    clock.advance(2 * HOUR);
    staff = await adminWith(t, ['disputes:*', 'orders:*'], { name: 'Layla Haddad' });
    const res = await staff.post(`/admin/disputes/${disputeId}/evidence`, {
      items: ['payment', 'three_ds', 'delivery', 'consents'],
      note: 'Delivered and acknowledged by the cardholder.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'under_review', submittedAt: '2026-11-07T14:00:00.000Z' });
    expect(gateway.calls('/v1/disputes/dp_cb_1')).toHaveLength(1);
    const row = await dispute();
    expect(row).toMatchObject({ status: 'under_review' });
    expect(row.evidenceFileIds).toHaveLength(1);
    const [file] = await world.db.select().from(s.files).where(eq(s.files.id, row.evidenceFileIds[0]!));
    expect(file).toMatchObject({ mime: 'application/pdf' });
    expect((await payment()).status).toBe('disputed');
  });

  it('step 6: the bank decides for the cardholder and the gateway reports that the dispute is lost', async () => {
    clock.advance(2 * 24 * HOUR);
    const res = await hook(
      t,
      clock,
      'disputes',
      world.gateway.code,
      disputeEvent('evt_cb_2', {
        dispute: 'dp_cb_1',
        intent: paid.intent,
        type: 'charge.dispute.closed',
        status: 'lost',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(await dispute()).toMatchObject({ status: 'lost' });
    expect((await dispute()).resolvedAt?.toISOString()).toBe('2026-11-09T14:00:00.000Z');
    expect((await payment()).status).toBe('chargeback');
  });

  it('step 7: the amount returned by the gateway and the dispute fee are booked as one loss, linked to the dispute', async () => {
    const row = await dispute();
    ledgerTxId = row.ledgerTxId!;
    expect(ledgerTxId).toBeGreaterThan(0);
    const [journal] = await world.db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.id, ledgerTxId));
    expect(journal).toMatchObject({
      kind: 'chargeback',
      refType: 'order',
      refId: paid.orderId,
      idempotencyKey: `dispute:${disputeId}:chargeback`,
    });
    // Dr chargeback_loss 4.79 + 12.00 GBP / 0.80185 = 14.9654 -> 19.7554, Cr gateway_clearing the same.
    expect(await systemBalance(world.db, 'chargeback_loss')).toBe('19.7554');
    expect((await ledgerOf(world.db, paid.orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'order_settle',
      'chargeback',
    ]);
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
    // The report and the payments page tell the same story.
    const finance = await adminWith(t, ['reports:finance']);
    const report = await finance.get('/admin/reports/payments');
    expect(report.body.totals.chargebackLoss).toBe('19.7554');
    expect(report.body.payments[0]).toMatchObject({ status: 'chargeback', amount: '4.7900' });
    // A second report of the same decision posts nothing more.
    const again = await hook(
      t,
      clock,
      'disputes',
      world.gateway.code,
      disputeEvent('evt_cb_3', {
        dispute: 'dp_cb_1',
        intent: paid.intent,
        type: 'charge.dispute.closed',
        status: 'lost',
      }),
    );
    expect(again.json()).toEqual({ received: true, duplicate: true });
    expect(await systemBalance(world.db, 'chargeback_loss')).toBe('19.7554');
    expect((await orderRow(world.db, paid.orderId)).status).toBe('completed');
  });
});
