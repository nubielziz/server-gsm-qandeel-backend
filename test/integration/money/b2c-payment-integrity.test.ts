// Integration tests of the integrity of storefront payments (decision 048): the order is created only once the gateway's own record says
// the payment succeeded for this checkout, amount and currency; a record that cannot be read is retried by the gateway; a confirmation
// that cannot pay its checkout is held and sent back when the gateway can refund; the hosted page closes with the price lock; the return
// address, the cap of live pages, exact amounts and https checkout addresses are checked at /pay.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { ErrorReporter } from '@src/infra/observability';
import { paymentsWithoutEntry } from '@src/modules/health/infra/integrity-reads.repository';
import { RefundProcessModule, RefundSender, StorefrontPayments, aftermathNote } from '@src/modules/money';
import { holdMarkOf } from '@src/modules/money/domain/b2c-money';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  type B2cWorld,
  B2cGateway,
  STORE_RETURN_URL,
  b2cWorld,
  hook,
  intents,
  json,
  minorOf,
  openCheckout,
  pay,
  recordIntent,
  refundEvent,
  sessions,
  storefrontEvent,
} from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { HOUR, MINUTE, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { notificationRows, seedDefaultTemplates } from '../../support/notifications';
import { insertCurrency } from '../../support/storefront';

const clock = new TestClock('2026-11-21T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let sender: RefundSender;
let staff: AdminApi;
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
  staff = await adminWith(t, ['refunds:*', 'orders:*'], { name: 'Layla Haddad' });
});

const unique = () => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const paymentRows = () => db.select().from(s.payments);
const orders = () => db.select().from(s.orders);
const refundRows = () => db.select().from(s.refunds);
const refundEvents = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'));
const confirm = (body: string) => hook(t, clock, 'payments', world.gateway.code, body);

type Opened = { id: number; reference: string; amount: string; currency: string };

/** Opens a checkout (of the iCloud service unless another is named) in GBP and its payment page. */
async function opened(currency = 'GBP', serviceId?: number): Promise<{ token: string; payment: Opened }> {
  const { token } = await openCheckout(t, world, { currency, ...(serviceId === undefined ? {} : { serviceId }) });
  const started = await pay(t, token, undefined);
  expect(started.statusCode).toBe(201);
  return { token, payment: json(started).payment as Opened };
}

/** A signed confirmation of a payment, the intent's record written as the options say. */
function confirmation(payment: Opened, options: Partial<Parameters<typeof storefrontEvent>[2]> = {}) {
  const intent = options.intent ?? `pi_${unique()}`;
  return {
    intent,
    body: storefrontEvent(`evt_${unique()}`, payment.reference, { amount: payment.amount, ...options, intent }),
  };
}

describe('the gateway record decides the capture', () => {
  it("a confirmation naming another checkout's paid record is held and creates no order; that checkout's own confirmation still does", async () => {
    const a = (await opened()).payment;
    const b = (await opened()).payment;
    // B's confirmation names A's payment intent; the record says it was opened for A.
    const { intent, body } = confirmation(b);
    recordIntent(intent, { reference: a.reference });
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await orders()).toHaveLength(0);
    expect(await paymentRow(b.id)).toMatchObject({
      status: 'pending',
      reviewRequired: true,
      reviewNote: "The gateway's record of this payment belongs to another checkout.",
      gatewayTxnId: null,
    });
    expect(await refundRows()).toHaveLength(0);
    // One GET of the record was made before anything was written.
    expect(fake.calls(`/v1/payment_intents/${intent}`)).toHaveLength(1);
    // A's own confirmation of the same intent captures.
    const own = storefrontEvent(`evt_${unique()}`, a.reference, { amount: a.amount, intent });
    expect((await confirm(own)).statusCode).toBe(200);
    expect(await paymentRow(a.id)).toMatchObject({ status: 'captured', gatewayTxnId: intent });
    expect(await orders()).toHaveLength(1);
  });

  it('a record of another checkout for another amount is held before the amount check: nothing is sent back and that checkout still captures', async () => {
    const a = (await opened('GBP', world.att.serviceId)).payment;
    const b = (await opened()).payment;
    expect(a.amount).not.toBe(b.amount);
    // B's confirmation names A's paid intent, whose record states A's amount; A's own confirmation is not recorded yet.
    const { intent, body } = confirmation(b);
    recordIntent(intent, { reference: a.reference, minor: minorOf(a.amount), currency: 'GBP', status: 'succeeded' });
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await paymentRow(b.id)).toMatchObject({
      status: 'pending',
      reviewRequired: true,
      reviewNote: "The gateway's record of this payment belongs to another checkout.",
      gatewayTxnId: null,
    });
    // A's money is not sent back under B's payment.
    expect(await refundRows()).toHaveLength(0);
    expect(await refundEvents()).toHaveLength(0);
    expect(await orders()).toHaveLength(0);
    const own = storefrontEvent(`evt_${unique()}`, a.reference, { amount: a.amount, intent });
    expect((await confirm(own)).statusCode).toBe(200);
    expect(await paymentRow(a.id)).toMatchObject({ status: 'captured', gatewayTxnId: intent, reviewRequired: false });
    expect(await orders()).toHaveLength(1);
    expect(await paymentRow(b.id)).toMatchObject({ status: 'pending', reviewRequired: true, gatewayTxnId: null });
    expect(await refundRows()).toHaveLength(0);
  });

  it('a record of another checkout that is not paid yet holds without taking its reference, and that checkout captures once paid', async () => {
    const a = (await opened('GBP', world.att.serviceId)).payment;
    const b = (await opened()).payment;
    // B's confirmation names A's intent before A has paid it.
    const { intent, body } = confirmation(b, { intentStatus: 'requires_payment_method' });
    recordIntent(intent, { reference: a.reference, minor: minorOf(a.amount), currency: 'GBP' });
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await paymentRow(b.id)).toMatchObject({
      status: 'pending',
      reviewRequired: true,
      reviewNote: "The gateway's record of this payment belongs to another checkout.",
      gatewayTxnId: null,
    });
    expect(await refundRows()).toHaveLength(0);
    expect(await orders()).toHaveLength(0);
    // A pays: its own confirmation captures, its reference free.
    recordIntent(intent, { status: 'succeeded' });
    const own = storefrontEvent(`evt_${unique()}`, a.reference, { amount: a.amount, intent });
    expect((await confirm(own)).statusCode).toBe(200);
    expect(await paymentRow(a.id)).toMatchObject({ status: 'captured', gatewayTxnId: intent, reviewRequired: false });
    expect(await orders()).toHaveLength(1);
    expect(await refundRows()).toHaveLength(0);
  });

  it("the same holds when the confirmation names another checkout's Checkout Session", async () => {
    const a = (await opened()).payment;
    const b = (await opened()).payment;
    const sessionId = `cs_rec_${unique()}`;
    sessions.set(sessionId, {
      paymentStatus: 'paid',
      minor: minorOf(a.amount),
      currency: 'GBP',
      reference: a.reference,
    });
    const completed = (reference: string) =>
      JSON.stringify({
        id: `evt_${unique()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: sessionId,
            object: 'checkout.session',
            payment_status: 'paid',
            client_reference_id: reference,
            amount_total: minorOf(a.amount),
            currency: 'gbp',
          },
        },
      });
    expect((await confirm(completed(b.reference))).statusCode).toBe(200);
    expect(fake.calls(`/v1/checkout/sessions/${sessionId}`)).toHaveLength(1);
    expect(await paymentRow(b.id)).toMatchObject({
      status: 'pending',
      reviewRequired: true,
      reviewNote: "The gateway's record of this payment belongs to another checkout.",
      gatewayTxnId: null,
    });
    expect(await orders()).toHaveLength(0);
    expect((await confirm(completed(a.reference))).statusCode).toBe(200);
    expect(await paymentRow(a.id)).toMatchObject({ status: 'captured', gatewayTxnId: sessionId });
    expect(await orders()).toHaveLength(1);
  });

  it('a gateway record that cannot be read answers 502, creates nothing, and the next delivery of the same event captures', async () => {
    const { payment } = await opened();
    const { body } = confirmation(payment);
    fake.failDetails = 500;
    const failed = await confirm(body);
    expect(failed.statusCode).toBe(502);
    expect(json(failed)).toMatchObject({ code: 'GATEWAY_ERROR' });
    expect(await orders()).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', reviewRequired: false });
    fake.failDetails = undefined;
    // The 502 released the replay mark: the gateway's next delivery of the same event is processed.
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'captured' });
    expect(await orders()).toHaveLength(1);
  });

  it('a payment the gateway does not know is held and nothing is sent back', async () => {
    const { payment } = await opened();
    const { intent, body } = confirmation(payment);
    intents.delete(intent);
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await orders()).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({
      status: 'pending',
      reviewRequired: true,
      reviewNote: 'The gateway does not report this payment as paid.',
      gatewayTxnId: intent,
    });
    expect(await refundRows()).toHaveLength(0);
  });

  it('a payment the gateway does not report as succeeded is held', async () => {
    const { payment } = await opened();
    const { body } = confirmation(payment, { intentStatus: 'requires_payment_method' });
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await orders()).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({
      status: 'pending',
      reviewRequired: true,
      reviewNote: 'The gateway does not report this payment as paid.',
    });
    expect(await refundRows()).toHaveLength(0);
  });

  it('a confirmation whose record cannot be read for 24 hours is held for staff', async () => {
    const { payment } = await opened();
    clock.advance(25 * HOUR);
    const { body } = confirmation(payment, { created: Math.floor(clock.nowMs() / 1000) - 25 * 3600 });
    fake.failDetails = 500;
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await orders()).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({
      status: 'pending',
      reviewRequired: true,
      reviewNote: 'The gateway could not be asked about this payment for 24 hours.',
    });
    expect(await refundRows()).toHaveLength(0);
  });

  it('a confirmation without its own time is judged by when the payment opened, so it is not retried for ever', async () => {
    const { payment } = await opened();
    const { body } = confirmation(payment);
    fake.failDetails = 500;
    clock.advance(23 * HOUR);
    expect((await confirm(body)).statusCode).toBe(502);
    clock.advance(HOUR);
    expect((await confirm(body)).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).reviewNote).toBe(
      'The gateway could not be asked about this payment for 24 hours.',
    );
  });
});

describe('a confirmation that cannot pay its checkout is held and sent back', () => {
  it('a payment for another amount is held and sent back in full automatically', async () => {
    const { payment } = await opened();
    const { intent, body } = confirmation(payment, { received: '1.00' });
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await orders()).toHaveLength(0);
    const refunds = await refundRows();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      paymentId: payment.id,
      orderId: null,
      customerId: null,
      amount: '1.0000',
      currency: 'GBP',
      method: 'original',
      status: 'processing',
      requestedByType: 'system',
      requestedById: null,
      ledgerTxId: null,
    });
    const events = await refundEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregateId).toBe(refunds[0]!.id);
    const held = await paymentRow(payment.id);
    expect(held).toMatchObject({ status: 'pending', reviewRequired: true });
    expect(held.reviewNote).toBe(
      `The gateway confirmed 1.0000 but the payment was opened for ${payment.amount}. Sent back in full automatically (RF-${refunds[0]!.id}).`,
    );
    expect(await sender.send(refunds[0]!.id, false)).toBe('completed');
    const [call] = fake.calls('/v1/refunds');
    const form = new URLSearchParams(call!.body);
    expect(form.get('payment_intent')).toBe(intent);
    expect(form.get('amount')).toBe('100');
    expect((await refundRows())[0]).toMatchObject({ status: 'completed' });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', reviewRequired: true });
    // No journal: the money never entered the books.
    expect(await db.select().from(s.ledgerTransactions)).toHaveLength(0);
    // The Refunds page lists customer refunds only.
    const list = await staff.get('/admin/refunds');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it('a confirmation whose checkout cannot be found is held, sent back in full automatically, and reported', async () => {
    const { payment } = await opened();
    await db.update(s.payments).set({ checkoutSessionId: null }).where(eq(s.payments.id, payment.id));
    const { body } = confirmation(payment);
    const capture = spyOn(t.app.get(ErrorReporter, { strict: false }), 'capture');
    try {
      expect((await confirm(body)).statusCode).toBe(200);
      const [refund] = await refundRows();
      expect(refund).toMatchObject({
        paymentId: payment.id,
        orderId: null,
        amount: payment.amount,
        currency: 'GBP',
        method: 'original',
        status: 'processing',
        requestedByType: 'system',
      });
      expect(await refundEvents()).toHaveLength(1);
      const held = await paymentRow(payment.id);
      const note = `The checkout of this payment cannot be found. Sent back in full automatically (RF-${refund!.id}).`;
      expect(held).toMatchObject({ status: 'pending', reviewRequired: true, reviewNote: note });
      expect(holdMarkOf(held.raw)).toBe(true);
      expect(await orders()).toHaveLength(0);
      // The hold is reported to the error reporter, not only logged.
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({ message: `A storefront payment is held for staff: ${note}` }),
        { process: 'api', route: 'POST /webhooks/payments/:gateway', code: 'PAYMENT_HELD' },
      );
    } finally {
      capture.mockRestore();
    }
  });

  it('a record whose latest charge was refunded or disputed is held with a note that says which, and nothing is sent back', async () => {
    const cases = [
      { charge: { refunded: true, amountRefunded: 384 }, note: aftermathNote('refunded') },
      { charge: { amountRefunded: 100 }, note: aftermathNote('partially_refunded') },
      { charge: { disputed: true }, note: aftermathNote('disputed') },
    ];
    for (const { charge, note } of cases) {
      const { payment } = await opened();
      const { intent, body } = confirmation(payment);
      recordIntent(intent, { charge });
      expect((await confirm(body)).statusCode).toBe(200);
      const held = await paymentRow(payment.id);
      expect(held).toMatchObject({ status: 'pending', reviewRequired: true, reviewNote: note, gatewayTxnId: intent });
      // The money did arrive: staff close it as paid back.
      expect(holdMarkOf(held.raw)).toBe(true);
    }
    expect(await orders()).toHaveLength(0);
    expect(await refundRows()).toHaveLength(0);
    expect(await refundEvents()).toHaveLength(0);
  });

  it('a return the gateway fails after it completed is failed again, and its payment is a finding again', async () => {
    const { payment } = await opened();
    const { body } = confirmation(payment, { received: '1.00' });
    expect((await confirm(body)).statusCode).toBe(200);
    const [refund] = await refundRows();
    expect(await sender.send(refund!.id, false)).toBe('completed');
    const completed = (await refundRows())[0]!;
    expect(completed).toMatchObject({ status: 'completed', orderId: null });
    expect((await paymentsWithoutEntry(db)).rows.map((row) => row.id)).not.toContain(payment.id);
    const failure = refundEvent(`evt_${unique()}`, {
      refund: completed.gatewayRefundId!,
      refundId: completed.id,
      sendAttempt: 1,
      type: 'refund.failed',
      failure: 'expired_or_canceled_card',
    });
    expect((await confirm(failure)).statusCode).toBe(200);
    const failed = (await refundRows())[0]!;
    expect(failed).toMatchObject({ status: 'failed', completedAt: null });
    expect(failed.note).toContain(`that refund ${completed.gatewayRefundId} failed after it was completed`);
    expect((await paymentsWithoutEntry(db)).rows.map((row) => row.id)).toContain(payment.id);
    // A repeated delivery changes nothing.
    expect((await confirm(failure)).statusCode).toBe(200);
    expect((await refundRows())[0]).toEqual(failed);
  });

  it("a confirmation that does not state its amount is held and sent back by the record's amount", async () => {
    const { payment } = await opened();
    const { body } = confirmation(payment);
    const event = JSON.parse(body);
    delete event.data.object.amount_total;
    expect((await confirm(JSON.stringify(event))).statusCode).toBe(200);
    expect(await orders()).toHaveLength(0);
    const held = await paymentRow(payment.id);
    expect(held.reviewNote).toContain(
      `The gateway's confirmation does not say the amount; the payment was opened for ${payment.amount}.`,
    );
    const [refund] = await refundRows();
    expect(refund).toMatchObject({ amount: payment.amount, currency: 'GBP', orderId: null, status: 'processing' });
  });

  it('the hold never sends back the money or takes the reference of a record that names another checkout, whatever its caller asks', async () => {
    const a = (await opened('GBP', world.att.serviceId)).payment;
    const b = (await opened()).payment;
    const intent = `pi_${unique()}`;
    const [gateway] = await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.id, world.gateway.id));
    const payments = t.app.get(StorefrontPayments, { strict: false });
    const payment = await paymentRow(b.id);
    const held = await db.transaction((tx) =>
      payments.holdConfirmation(tx, {
        payment,
        gateway: gateway!,
        event: {
          kind: 'confirmed',
          invoiceNumber: b.reference,
          reference: intent,
          amount: a.amount,
          currency: 'GBP',
          raw: {},
        },
        check: { status: 'confirmed', amount: a.amount, currency: 'GBP', paidAt: null, belongsTo: a.reference },
        reason: 'Held for the test.',
        sendBack: true,
      }),
    );
    expect(held).toEqual({ returnRefundId: null, note: 'Held for the test.' });
    expect(await paymentRow(b.id)).toMatchObject({
      status: 'pending',
      reviewRequired: true,
      reviewNote: 'Held for the test.',
      gatewayTxnId: null,
    });
    expect(await refundRows()).toHaveLength(0);
    expect(await refundEvents()).toHaveLength(0);
  });

  it('a held payment of a gateway that cannot refund gets no automatic return', async () => {
    await db
      .update(s.paymentGateways)
      .set({ supportsRefunds: false })
      .where(eq(s.paymentGateways.id, world.gateway.id));
    const { payment } = await opened();
    const { body } = confirmation(payment, { received: '1.00' });
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', reviewRequired: true });
    expect((await paymentRow(payment.id)).reviewNote).not.toContain('Sent back');
    expect(await refundRows()).toHaveLength(0);
    expect(await refundEvents()).toHaveLength(0);
  });

  it('once its money is being sent back, a payment is not captured by a later confirmation, and a failure event does not mark it failed', async () => {
    await seedDefaultTemplates(db);
    const { payment } = await opened();
    const { intent, body } = confirmation(payment, { received: '1.00' });
    expect((await confirm(body)).statusCode).toBe(200);
    expect(await refundRows()).toHaveLength(1);
    // The gateway now reports the full amount: the payment still never pays its checkout.
    const again = storefrontEvent(`evt_${unique()}`, payment.reference, { amount: payment.amount, intent });
    const answer = await confirm(again);
    expect(answer.statusCode).toBe(200);
    expect(json(answer)).toEqual({ received: true, duplicate: true });
    expect(await orders()).toHaveLength(0);
    const expired = storefrontEvent(`evt_${unique()}`, payment.reference, {
      amount: payment.amount,
      intent,
      type: 'checkout.session.expired',
    });
    expect((await confirm(expired)).statusCode).toBe(200);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', reviewRequired: true });
    expect((await notificationRows(db)).map((row) => row.event)).not.toContain('payment.failed');
    expect(await refundRows()).toHaveLength(1);
  });

  it('a gateway reference that already belongs to another payment holds the confirmation', async () => {
    const a = (await opened()).payment;
    const b = (await opened()).payment;
    const intent = `pi_shared_${unique()}`;
    expect(
      (await confirm(storefrontEvent(`evt_${unique()}`, a.reference, { amount: a.amount, intent }))).statusCode,
    ).toBe(200);
    const captured = await paymentRow(a.id);
    expect(captured).toMatchObject({ status: 'captured', gatewayTxnId: intent });
    // B's confirmation names the same gateway payment (its record now names B, so only the reference check stops it).
    const res = await confirm(storefrontEvent(`evt_${unique()}`, b.reference, { amount: b.amount, intent }));
    expect(res.statusCode).toBe(200);
    const held = await paymentRow(b.id);
    expect(held).toMatchObject({ status: 'pending', reviewRequired: true, gatewayTxnId: null });
    expect(held.reviewNote).toBe(
      `This confirmation names a gateway reference that another payment already has. Its gateway reference is already recorded on PAY-${a.id}.`,
    );
    expect(await paymentRow(a.id)).toEqual(captured);
    expect(await refundRows()).toHaveLength(0);
    expect(await orders()).toHaveLength(1);
  });
});

describe('POST /store/v1/checkout-sessions/:token/pay (decision 048)', () => {
  it('the hosted card page closes 30 minutes after the price lock ends', async () => {
    const { token: early } = await openCheckout(t, world);
    const openedAt = clock.nowMs();
    clock.advance(5 * MINUTE);
    expect((await pay(t, early, undefined)).statusCode).toBe(201);
    const first = new URLSearchParams(fake.calls('/v1/checkout/sessions')[0]!.body);
    // The lock ends 30 minutes after the checkout opened; the page 30 minutes after that.
    expect(first.get('expires_at')).toBe(String(Math.floor((openedAt + 60 * MINUTE) / 1000)));

    const { token: late } = await openCheckout(t, world);
    const lateOpened = clock.nowMs();
    clock.advance(29 * MINUTE + 30 * SECOND);
    expect((await pay(t, late, undefined)).statusCode).toBe(201);
    const second = new URLSearchParams(fake.calls('/v1/checkout/sessions')[1]!.body);
    // Opened 30 seconds before the lock ends: the page gets the gateway's minimum plus a minute.
    expect(second.get('expires_at')).toBe(String(Math.floor((clock.nowMs() + 31 * MINUTE) / 1000)));
    expect(Number(second.get('expires_at'))).toBeGreaterThan(Math.floor((lateOpened + 60 * MINUTE) / 1000));
  });

  it('the return address must be an address of this shop', async () => {
    expect(t.config.http.storeBaseUrl).toBe(new URL(STORE_RETURN_URL).origin);
    const { token } = await openCheckout(t, world);
    for (const returnUrl of [
      'https://other.example/return',
      `https://${new URL(STORE_RETURN_URL).host}/return`,
      `${new URL(STORE_RETURN_URL).protocol}//buyer@${new URL(STORE_RETURN_URL).host}/return`,
    ]) {
      const res = await pay(t, token, { gateway: 'card-b2c', returnUrl });
      expect(res.statusCode).toBe(422);
      expect(json(res).errors).toEqual([
        { field: 'returnUrl', code: 'not_shop', message: 'Use an address of this shop.' },
      ]);
    }
    expect(await paymentRows()).toHaveLength(0);
    expect(fake.calls('/v1/checkout/sessions')).toHaveLength(0);
    expect((await pay(t, token, { gateway: 'card-b2c', returnUrl: STORE_RETURN_URL })).statusCode).toBe(201);
    const portal = `${t.config.http.portalBaseUrl}/wallet`;
    expect((await pay(t, token, { gateway: 'card-b2c', returnUrl: portal })).statusCode).toBe(201);
  });

  it('a checkout keeps at most three live payment pages', async () => {
    const { token } = await openCheckout(t, world);
    const started: Opened[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await pay(t, token, undefined);
      expect(res.statusCode).toBe(201);
      started.push(json(res).payment as Opened);
    }
    const fourth = await pay(t, token, undefined);
    expect(fourth.statusCode).toBe(429);
    expect(json(fourth)).toMatchObject({
      code: 'RATE_LIMITED',
      detail: 'This checkout already has 3 payment pages open. Pay on one of them, or wait until one closes.',
    });
    expect(fourth.headers['retry-after']).toBe('60');
    // A page that expired frees its place.
    const expired = storefrontEvent(`evt_${unique()}`, started[0]!.reference, {
      amount: started[0]!.amount,
      type: 'checkout.session.expired',
    });
    expect((await confirm(expired)).statusCode).toBe(200);
    expect((await pay(t, token, undefined)).statusCode).toBe(201);
    expect((await pay(t, token, undefined)).statusCode).toBe(429);
    // A page held for staff frees its place too.
    expect((await confirm(confirmation(started[1]!, { received: '1.00' }).body)).statusCode).toBe(200);
    expect((await pay(t, token, undefined)).statusCode).toBe(201);

    const { token: busy } = await openCheckout(t, world);
    const answers = await Promise.all(Array.from({ length: 6 }, () => pay(t, busy, undefined)));
    expect(answers.filter((res) => res.statusCode === 201)).toHaveLength(3);
    expect(answers.filter((res) => res.statusCode === 429)).toHaveLength(3);
    const session = (await db.select().from(s.payments)).filter(
      (row) =>
        row.checkoutSessionId !== null &&
        answers.some((res) => res.statusCode === 201 && json(res).payment.id === row.id),
    );
    expect(session).toHaveLength(3);
  });

  it('an amount the card method cannot charge exactly is refused before any page opens', async () => {
    await insertCurrency(db, { code: 'JOD', name: 'Jordanian dinar', rateToBase: '0.709', decimals: 3 });
    const { token } = await openCheckout(t, world, { currency: 'JOD' });
    const res = await pay(t, token, undefined);
    expect(res.statusCode).toBe(422);
    expect(json(res).errors).toEqual([
      {
        field: 'gateway',
        code: 'not_chargeable',
        message: 'This payment method cannot charge this amount exactly. Choose another one.',
      },
    ]);
    expect(await paymentRows()).toHaveLength(0);
    expect(fake.calls('/v1/checkout/sessions')).toHaveLength(0);
    await insertCurrency(db, { code: 'JOD', decimals: 2 });
    const { token: exact } = await openCheckout(t, world, { currency: 'JOD' });
    expect((await pay(t, exact, undefined)).statusCode).toBe(201);
  });

  it('a checkout address that is not https is a 502 and the payment fails', async () => {
    fake.checkoutUrl = 'http://pay.example/cs_x';
    const { token } = await openCheckout(t, world);
    const res = await pay(t, token, undefined, 'key-http');
    expect(res.statusCode).toBe(502);
    expect(json(res)).toMatchObject({
      code: 'GATEWAY_ERROR',
      detail: 'The payment gateway gave a checkout address that is not an https address.',
    });
    expect(json(res).paymentUrl).toBeUndefined();
    const [payment] = await paymentRows();
    expect(payment).toMatchObject({ status: 'failed', idempotencyKey: null, checkoutUrl: null });
  });
});
