// Integration tests of paying a storefront checkout (feature 16, scenario b2c-paid): POST /store/v1/checkout-sessions/:token/pay, the signed
// confirmation on POST /webhooks/payments/:gateway that creates the order, the capture journals, the receipt, idempotency and the refusals.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { AppError } from '../../src/common/errors';
import { schema as s, type Database } from '../../src/infra/db';
import { ReceiptRenderModule } from '../../src/modules/money';
import { PdfRenderer, StoredFiles } from '../../src/modules/platform';
import { UnrecoverableError } from '../../src/infra/queues';
import { ReceiptRenderProcessor } from '../../src/modules/money';
import { GatewayTestModule } from '../support/billing';
import { type TestApp, createTestApp } from '../support/app';
import {
  type B2cWorld,
  B2cGateway,
  b2cWorld,
  hook,
  json,
  openCheckout,
  paidOrder,
  pay,
  renderReceipts,
  storefrontEvent,
} from '../support/b2c';
import { MINUTE, SECOND, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { eventsOf, ledgerOf, orderRow, outboxOf, systemBalance } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { expectRejection } from '../support/rejection';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, ReceiptRenderModule] });
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
  world = await b2cWorld(t, db, fake);
});

const payments = () => db.select().from(s.payments);
const orders = () => db.select().from(s.orders);
const eventId = () => `evt_${crypto.randomUUID()}`;

describe('POST /store/v1/checkout-sessions/:token/pay', () => {
  it('opens a pending payment and the gateway page; no order exists yet', async () => {
    const { token } = await openCheckout(t, world);
    const res = await pay(t, token, undefined, 'key-1');
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const [payment] = await payments();
    expect(json(res)).toEqual({
      payment: {
        id: payment!.id,
        reference: `PAY-${payment!.id}`,
        status: 'pending',
        method: 'card',
        currency: 'GBP',
        amount: '3.8400',
      },
      gateway: { code: 'card-b2c', name: 'Card gateway', supports3ds: true },
      paymentUrl: 'https://pay.example/cs_1',
    });
    expect(payment).toMatchObject({
      purpose: 'order',
      status: 'pending',
      methodType: 'card',
      amount: '3.8400',
      currency: 'GBP',
      idempotencyKey: 'key-1',
      checkoutUrl: 'https://pay.example/cs_1',
    });
    expect(await orders()).toHaveLength(0);
    const form = new URLSearchParams(fake.calls('/v1/checkout/sessions')[0]!.body);
    expect(form.get('client_reference_id')).toBe(`PAY-${payment!.id}`);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('384');
    expect(form.get('line_items[0][price_data][currency]')).toBe('gbp');
    expect(form.get('payment_method_options[card][request_three_d_secure]')).toBe('any');
    expect((await ledgerTotals(db)).transactions).toBe(0);
  });

  it('needs the Idempotency-Key header and every required consent, and a method the shop offers', async () => {
    const { token } = await openCheckout(t, world);
    const noKey = await pay(t, token, undefined, null);
    expect(noKey.statusCode).toBe(422);
    expect(json(noKey).errors[0]).toMatchObject({ field: 'idempotency-key' });

    const unconsented = (await openCheckout(t, world, { consent: false })).token;
    const refused = await pay(t, unconsented, undefined);
    expect(refused.statusCode).toBe(422);
    expect(json(refused).errors).toEqual([expect.objectContaining({ field: 'consent' })]);

    const unknown = await pay(t, token, { gateway: 'nope', returnUrl: 'https://shop.example/return' });
    expect(unknown.statusCode).toBe(422);
    expect(json(unknown).errors).toEqual([expect.objectContaining({ field: 'gateway' })]);
    await db.update(s.paymentGateways).set({ audience: 'b2b' });
    const b2bOnly = await pay(t, token, undefined);
    expect(b2bOnly.statusCode).toBe(422);
    expect(await payments()).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a gateway whose limits do not take the amount', async () => {
    await db.update(s.paymentGateways).set({ minAmount: '10.0000' });
    const { token } = await openCheckout(t, world);
    const res = await pay(t, token, undefined);
    expect(res.statusCode).toBe(422);
    expect(json(res).errors).toEqual([expect.objectContaining({ field: 'gateway', code: 'out_of_range' })]);
  });

  it('refuses an expired or a paid checkout and a suspended customer', async () => {
    const { token } = await openCheckout(t, world);
    clock.advance(31 * MINUTE);
    const expired = await pay(t, token, undefined);
    expect(expired.statusCode).toBe(409);
    expect(json(expired)).toMatchObject({ code: 'INVALID_TRANSITION' });

    clock.set('2026-11-07T12:00:00.000Z');
    const second = (await openCheckout(t, world, { email: 'ann@mail.example' })).token;
    await db.update(s.customers).set({ status: 'blocked' }).where(eq(s.customers.email, 'ann@mail.example'));
    const blocked = await pay(t, second, undefined);
    expect(blocked.statusCode).toBe(403);
    expect(json(blocked)).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });

    clock.set('2026-11-07T12:00:00.000Z');
    const paid = await paidOrder(t, clock, world, { email: 'bob@mail.example' });
    const again = await pay(t, paid.token, undefined);
    expect(again.statusCode).toBe(409);
    expect(json(again).detail).toContain('already paid');
  });

  it('replays the same answer for the same key and body, and refuses another body under the key', async () => {
    const { token } = await openCheckout(t, world);
    const first = await pay(t, token, undefined, 'key-replay');
    const second = await pay(t, token, undefined, 'key-replay');
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(json(second)).toEqual(json(first));
    expect(fake.calls('/v1/checkout/sessions')).toHaveLength(1);
    expect(await payments()).toHaveLength(1);

    const other = await pay(t, token, { gateway: 'card-b2c', returnUrl: 'https://shop.example/other' }, 'key-replay');
    expect(other.statusCode).toBe(409);
    expect(json(other)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    // A new key is a new attempt.
    const third = await pay(t, token, undefined, 'key-new');
    expect(third.statusCode).toBe(201);
    expect(await payments()).toHaveLength(2);
  });

  it('two calls with one key at once open one payment', async () => {
    const { token } = await openCheckout(t, world);
    const answers = await Promise.all([pay(t, token, undefined, 'key-race'), pay(t, token, undefined, 'key-race')]);
    const codes = answers.map((res) => res.statusCode).sort();
    expect([
      [201, 201],
      [201, 409],
    ]).toContainEqual(codes);
    expect(await payments()).toHaveLength(1);
    expect(fake.calls('/v1/checkout/sessions')).toHaveLength(1);
  });

  it('a gateway that cannot open its page is a 502, marks the payment failed and frees the key', async () => {
    const { token } = await openCheckout(t, world);
    fake.failCheckout = 500;
    const failed = await pay(t, token, undefined, 'key-down');
    expect(failed.statusCode).toBe(502);
    expect(json(failed)).toMatchObject({ code: 'GATEWAY_ERROR' });
    expect(await payments()).toMatchObject([{ status: 'failed', idempotencyKey: null }]);
    fake.failCheckout = undefined;
    const retried = await pay(t, token, undefined, 'key-down');
    expect(retried.statusCode).toBe(201);
    expect(await payments()).toHaveLength(2);
  });
});

describe('POST /store/v1/checkout-sessions/:token/pay: replays and calls in flight', () => {
  const expiredEvent = (reference: string, amount: string) =>
    storefrontEvent(eventId(), reference, { amount, type: 'checkout.session.expired' });

  it('the same request repeated after the capture answers the same payment, now captured', async () => {
    const { token } = await openCheckout(t, world);
    const first = await pay(t, token, undefined, 'key-after');
    const { payment } = json(first);
    const confirmed = storefrontEvent(eventId(), payment.reference, { amount: payment.amount, intent: 'pi_after' });
    expect((await hook(t, clock, 'payments', 'card-b2c', confirmed)).statusCode).toBe(200);
    expect((await payments())[0]).toMatchObject({ status: 'captured' });

    const again = await pay(t, token, undefined, 'key-after');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json(again)).toEqual({ ...json(first), payment: { ...payment, status: 'captured' } });
    // Another request under the key is still refused after the capture.
    const other = await pay(t, token, { gateway: 'card-b2c', returnUrl: 'https://shop.example/other' }, 'key-after');
    expect(other.statusCode).toBe(409);
    expect(json(other)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(fake.calls('/v1/checkout/sessions')).toHaveLength(1);
    expect(await payments()).toHaveLength(1);
  });

  it('the same request repeated after the payment failed, or after a confirmation was held for staff, still matches', async () => {
    const failing = await openCheckout(t, world);
    const failedFirst = json(await pay(t, failing.token, undefined, 'key-failed')).payment;
    await hook(t, clock, 'payments', 'card-b2c', expiredEvent(failedFirst.reference, failedFirst.amount));
    const failedAgain = await pay(t, failing.token, undefined, 'key-failed');
    expect(failedAgain.statusCode).toBe(201);
    expect(json(failedAgain).payment).toEqual({ ...failedFirst, status: 'failed' });

    const held = await openCheckout(t, world, { email: 'ann@mail.example' });
    const heldFirst = json(await pay(t, held.token, undefined, 'key-held')).payment;
    const wrong = storefrontEvent(eventId(), heldFirst.reference, { amount: '1.00', intent: 'pi_wrong' });
    await hook(t, clock, 'payments', 'card-b2c', wrong);
    expect((await payments()).find((row) => row.id === heldFirst.id)).toMatchObject({ reviewRequired: true });
    const heldAgain = await pay(t, held.token, undefined, 'key-held');
    expect(heldAgain.statusCode).toBe(201);
    expect(heldAgain.headers['idempotency-replayed']).toBe('true');
    expect(json(heldAgain).payment).toEqual(heldFirst);
  });

  it('a call that repeats while the first still opens its page is 409 IDEMPOTENCY_IN_PROGRESS, and the first still succeeds', async () => {
    const { token } = await openCheckout(t, world);
    const slowGateway = fake.holdCheckout();
    const first = pay(t, token, undefined, 'key-slow');
    await slowGateway.arrived;
    const second = await pay(t, token, undefined, 'key-slow');
    expect(second.statusCode).toBe(409);
    expect(json(second)).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect(second.headers['retry-after']).toBe('1');
    slowGateway.release();
    const answered = await first;
    expect(answered.statusCode).toBe(201);
    expect(json(answered).payment.status).toBe('pending');
    expect(fake.calls('/v1/checkout/sessions')).toHaveLength(1);
    expect(await payments()).toHaveLength(1);
    // Once the page is stored the same key replays it.
    const replay = await pay(t, token, undefined, 'key-slow');
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(json(replay)).toEqual(json(answered));
  });

  it('a call that died before the gateway answered starts over after 60 seconds: a new payment under the same key', async () => {
    const { token } = await openCheckout(t, world);
    const stuck = fake.holdCheckout();
    const crashed = pay(t, token, undefined, 'key-crash');
    await stuck.arrived;
    const [dead] = await payments();
    expect(dead).toMatchObject({ status: 'pending', checkoutUrl: null, idempotencyKey: 'key-crash' });

    clock.advance(59 * SECOND);
    expect((await pay(t, token, undefined, 'key-crash')).statusCode).toBe(409);
    clock.advance(2 * SECOND);
    const restarted = await pay(t, token, undefined, 'key-crash');
    expect(restarted.statusCode).toBe(201);
    expect(json(restarted).payment.id).not.toBe(dead!.id);
    expect(json(restarted).payment.status).toBe('pending');
    const rows = await payments();
    expect(rows.find((row) => row.id === dead!.id)).toMatchObject({ status: 'failed', idempotencyKey: null });
    expect(rows.find((row) => row.id === json(restarted).payment.id)).toMatchObject({
      status: 'pending',
      idempotencyKey: 'key-crash',
      checkoutUrl: expect.any(String),
    });

    // The call that was only slow comes back after its payment was written off: it must not hand out its page.
    stuck.release();
    const late = await crashed;
    expect(late.statusCode).toBe(409);
    expect(json(late)).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await payments()).find((row) => row.id === dead!.id)).toMatchObject({
      status: 'failed',
      checkoutUrl: null,
    });
  });

  it('a page that opens after the gateway already said the payment failed is never handed out; the key can start over', async () => {
    const { token } = await openCheckout(t, world);
    const slowGateway = fake.holdCheckout();
    const opening = pay(t, token, undefined, 'key-written-off');
    await slowGateway.arrived;
    const [row] = await payments();
    await hook(t, clock, 'payments', 'card-b2c', expiredEvent(`PAY-${row!.id}`, row!.amount));
    expect((await payments())[0]).toMatchObject({ status: 'failed', idempotencyKey: 'key-written-off' });
    slowGateway.release();
    const answered = await opening;
    expect(answered.statusCode).toBe(409);
    expect(json(answered)).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(answered.body).not.toContain('pay.example');

    // The key is not stuck: a retry frees it and opens a new payment at once, with no 60 second wait.
    const retried = await pay(t, token, undefined, 'key-written-off');
    expect(retried.statusCode).toBe(201);
    const rows = await payments();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'failed', idempotencyKey: null });
    expect(rows[1]).toMatchObject({ status: 'pending', idempotencyKey: 'key-written-off' });
  });
});

describe('the gateway confirmation', () => {
  it('captures the payment: the order, the journals, the receipt invoice and the paid checkout, in one step', async () => {
    const paid = await paidOrder(t, clock, world);
    const [payment] = await payments();
    expect(payment).toMatchObject({
      id: paid.paymentId,
      status: 'captured',
      orderId: paid.orderId,
      gatewayTxnId: paid.intent,
      methodType: 'card',
      brand: 'Visa •••• 4242',
      cardFingerprint: 'fp_1',
      threeDs: true,
      amount: '3.8400',
      reviewRequired: false,
    });
    // 2.9 % of 4.79 plus 0.30, in USD, converted to GBP for the row.
    expect(payment!.feeAmount).toBe('0.3500');
    const order = await orderRow(db, paid.orderId);
    expect(order).toMatchObject({
      customerId: expect.any(Number),
      clientId: null,
      source: 'store',
      status: 'pending',
      dispatchState: 'manual',
      totalPrice: '3.9900',
      unitPrice: '3.9900',
      taxAmount: '0.8000',
      taxCountry: 'GB',
      currency: 'USD',
      imei: expect.stringMatching(/^353890110000004$/),
    });
    expect(order.publicToken).toBe(paid.trackingToken);
    expect((await eventsOf(db, paid.orderId)).map((event) => event.type)).toEqual(['created', 'paid', 'review']);

    expect((await ledgerOf(db, paid.orderId)).map((entry) => [entry.kind, entry.key])).toEqual([
      ['b2c_payment', `payment:${paid.paymentId}:capture`],
      ['gateway_fee', `payment:${paid.paymentId}:fee`],
    ]);
    expect(await systemBalance(db, 'customer_funds')).toBe('3.9900');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.8000');
    // 4.79 received, minus the fee 0.4389 (2.9 % of 4.79 = 0.13891 plus 0.30).
    expect(await systemBalance(db, 'gateway_clearing')).toBe('4.3511');
    expect(await systemBalance(db, 'gateway_fees')).toBe('0.4389');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');

    const [invoice] = await db.select().from(s.invoices);
    expect(invoice).toMatchObject({
      kind: 'receipt',
      status: 'paid',
      customerId: order.customerId,
      orderId: paid.orderId,
      amount: '3.8400',
      netAmount: '3.2000',
      taxAmount: '0.6400',
      taxRate: '20.0000',
      taxCountry: 'GB',
      total: '3.8400',
      currency: 'GBP',
    });
    expect(payment!.invoiceId).toBe(invoice!.id);
    const [session] = await db.select().from(s.checkoutSessions);
    expect(session).toMatchObject({ status: 'paid', orderId: paid.orderId });
    // The manual order is not sent anywhere yet; nothing went to the dispatch queue.
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(0);
  });

  it('a paid session shows the buyer the tracking token, and the tracking page works with it', async () => {
    const paid = await paidOrder(t, clock, world);
    const tracking = await t.app.inject({
      method: 'GET',
      url: `/store/v1/orders/${paid.trackingToken}`,
      remoteAddress: freshClientIp(),
    });
    expect(tracking.statusCode).toBe(200);
    expect(json(tracking).timeline.map((line: { type: string }) => line.type)).toEqual(['created', 'paid']);
  });

  it('the same delivery or a second event for the same payment captures once', async () => {
    const { token } = await openCheckout(t, world);
    const { payment } = json(await pay(t, token, undefined));
    const body = storefrontEvent(eventId(), payment.reference, { amount: payment.amount, intent: 'pi_once' });
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    const again = storefrontEvent(eventId(), payment.reference, { amount: payment.amount, intent: 'pi_once' });
    const res = await hook(t, clock, 'payments', 'card-b2c', again);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ received: true, duplicate: true });
    expect(await orders()).toHaveLength(1);
    expect((await ledgerTotals(db)).transactions).toBe(2);
  });

  it('a confirmation with another amount or currency creates no order and waits for staff', async () => {
    const { token } = await openCheckout(t, world);
    const { payment } = json(await pay(t, token, undefined));
    const body = storefrontEvent(eventId(), payment.reference, { amount: '1.00', intent: 'pi_wrong' });
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    expect(await orders()).toHaveLength(0);
    expect((await ledgerTotals(db)).transactions).toBe(0);
    const [row] = await payments();
    expect(row).toMatchObject({ status: 'pending', reviewRequired: true });
    expect(row!.reviewNote).toContain('opened for 3.8400');
    const [session] = await db.select().from(s.checkoutSessions);
    expect(session!.status).toBe('open');
  });

  it('a failed or expired checkout marks the pending payment failed; a progress event changes nothing', async () => {
    const { token } = await openCheckout(t, world);
    const { payment } = json(await pay(t, token, undefined));
    const progress = storefrontEvent(eventId(), payment.reference, {
      amount: payment.amount,
      paymentStatus: 'unpaid',
    });
    await hook(t, clock, 'payments', 'card-b2c', progress);
    expect((await payments())[0]!.status).toBe('pending');
    const expired = storefrontEvent(eventId(), payment.reference, {
      amount: payment.amount,
      type: 'checkout.session.expired',
    });
    expect((await hook(t, clock, 'payments', 'card-b2c', expired)).statusCode).toBe(200);
    expect((await payments())[0]!.status).toBe('failed');
    expect(await orders()).toHaveLength(0);
  });

  it('honours a confirmation that arrives after the session expired: the buyer paid the locked price', async () => {
    const { token } = await openCheckout(t, world);
    const { payment } = json(await pay(t, token, undefined));
    clock.advance(45 * MINUTE);
    const body = storefrontEvent(eventId(), payment.reference, { amount: payment.amount, intent: 'pi_late' });
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    expect(await orders()).toHaveLength(1);
    expect((await payments())[0]!.status).toBe('captured');
  });

  it('a confirmation for a payment that was marked failed still captures it: the money arrived, so the order exists', async () => {
    const { token } = await openCheckout(t, world);
    const { payment } = json(await pay(t, token, undefined));
    const expired = storefrontEvent(eventId(), payment.reference, {
      amount: payment.amount,
      type: 'checkout.session.expired',
    });
    await hook(t, clock, 'payments', 'card-b2c', expired);
    expect((await payments())[0]!.status).toBe('failed');
    expect(await orders()).toHaveLength(0);

    const paidLate = storefrontEvent(eventId(), payment.reference, {
      amount: payment.amount,
      intent: 'pi_crypto_late',
    });
    const res = await hook(t, clock, 'payments', 'card-b2c', paidLate);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ received: true });
    expect(await orders()).toHaveLength(1);
    const [row] = await payments();
    expect(row).toMatchObject({ status: 'captured', gatewayTxnId: 'pi_crypto_late' });
    expect(row!.orderId).not.toBeNull();
    expect((await ledgerTotals(db)).transactions).toBe(2);
    expect(await systemBalance(db, 'customer_funds')).toBe('3.9900');
    expect((await db.select().from(s.checkoutSessions))[0]).toMatchObject({ status: 'paid' });

    // A late failure never undoes a capture, and the confirmation delivered again is a duplicate.
    await hook(t, clock, 'payments', 'card-b2c', expired);
    expect((await payments())[0]!.status).toBe('captured');
    const again = storefrontEvent(eventId(), payment.reference, { amount: payment.amount, intent: 'pi_crypto_late' });
    expect(json(await hook(t, clock, 'payments', 'card-b2c', again))).toMatchObject({ duplicate: true });
    expect(await orders()).toHaveLength(1);
    expect((await ledgerTotals(db)).transactions).toBe(2);
  });

  it('a wallet payment is a wallet payment; a payment for a gateway of another code is ignored', async () => {
    const paid = await paidOrder(t, clock, world, { card: { brand: 'visa', last4: '1111', wallet: 'apple_pay' } });
    const [payment] = await payments();
    expect(payment).toMatchObject({ id: paid.paymentId, methodType: 'wallet', brand: 'Apple Pay' });
  });

  it('a second payment confirmed for a paid checkout is booked and refunded in full', async () => {
    const { token } = await openCheckout(t, world);
    const first = json(await pay(t, token, undefined, 'k1')).payment;
    const second = json(await pay(t, token, undefined, 'k2')).payment;
    await hook(
      t,
      clock,
      'payments',
      'card-b2c',
      storefrontEvent(eventId(), first.reference, { amount: first.amount, intent: 'pi_a' }),
    );
    await hook(
      t,
      clock,
      'payments',
      'card-b2c',
      storefrontEvent(eventId(), second.reference, { amount: second.amount, intent: 'pi_b' }),
    );
    expect(await orders()).toHaveLength(1);
    const rows = await payments();
    expect(rows.map((row) => row.status)).toEqual(['captured', 'captured']);
    const refunds = await db.select().from(s.refunds);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      paymentId: second.id,
      status: 'processing',
      method: 'original',
      requestedByType: 'system',
      amount: '3.8400',
    });
    // An order has one paid receipt: the duplicate payment issues none, so it has no invoice and only one receipt job was queued.
    const receipts = (await db.select().from(s.invoices)).filter((invoice) => invoice.kind === 'receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ orderId: (await orders())[0]!.id, status: 'paid' });
    expect(rows.map((row) => row.invoiceId)).toEqual([receipts[0]!.id, null]);
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'receipt.render'))).toHaveLength(1);
    // The duplicate has no receipt copy of its own: only the order's receipt is drawn.
    expect(await renderReceipts(t)).toEqual(['stored']);
    expect(await db.select().from(s.files)).toHaveLength(1);
    // The money of the duplicate went in and out: only the first payment stands.
    expect(await systemBalance(db, 'customer_funds')).toBe('3.9900');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.8000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

describe('GET /store/v1/orders/:token/receipt', () => {
  const receiptOf = (token: string) =>
    t.app.inject({ method: 'GET', url: `/store/v1/orders/${token}/receipt`, remoteAddress: freshClientIp() });

  it('is not drawn while the webhook answers: the capture queues the render, and the job draws and stores it once', async () => {
    const render = spyOn(PdfRenderer.prototype, 'render');
    try {
      const paid = await paidOrder(t, clock, world);
      // The webhook has answered: the invoice and the queued job exist, but no PDF was drawn or uploaded in the request.
      expect(render).not.toHaveBeenCalled();
      const [queued] = await db.select().from(s.invoices);
      expect(queued!.pdfFileId).toBeNull();
      expect(await db.select().from(s.files)).toHaveLength(0);
      const events = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'receipt.render'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateType: 'invoices',
        aggregateId: queued!.id,
        payload: { invoiceId: queued!.id },
      });

      expect(await renderReceipts(t)).toEqual(['stored']);
      expect(render).toHaveBeenCalledTimes(1);
      const [invoice] = await db.select().from(s.invoices);
      expect(invoice!.pdfFileId).not.toBeNull();
      const files = await db.select().from(s.files);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        id: invoice!.pdfFileId,
        ownerType: 'customer',
        ownerId: (await orderRow(db, paid.orderId)).customerId,
        mime: 'application/pdf',
        filename: `${invoice!.number}.pdf`,
      });

      // The same job again (a stalled job, a retry) finds the copy and draws nothing.
      expect(await renderReceipts(t)).toEqual(['exists']);
      expect(render).toHaveBeenCalledTimes(1);
      expect(await db.select().from(s.files)).toHaveLength(1);
    } finally {
      render.mockRestore();
    }
  });

  it('the job refuses a payload without an invoice id for good, and skips an invoice that is gone', async () => {
    const processor = t.app.get(ReceiptRenderProcessor, { strict: false });
    const job = (payload: Record<string, unknown>) =>
      ({
        name: 'receipt.render',
        data: {
          eventId: 1,
          type: 'receipt.render',
          aggregateType: 'invoices',
          aggregateId: 1,
          payload,
          requestId: 'x',
        },
      }) as never;
    await expectRejection(processor.process(job({})), UnrecoverableError);
    await expectRejection(processor.process(job({ invoiceId: 'one' })), UnrecoverableError);
    expect(await processor.process(job({ invoiceId: 999_999 }))).toBe('skipped');
  });

  it('serves the tax receipt as a PDF, the stored bytes every time', async () => {
    const paid = await paidOrder(t, clock, world);
    await renderReceipts(t);
    const first = await receiptOf(paid.trackingToken);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(first.headers['content-disposition']).toMatch(/^attachment; filename="INV-2026-\d+\.pdf"$/);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const second = await receiptOf(paid.trackingToken);
    expect(Buffer.compare(first.rawPayload, second.rawPayload)).toBe(0);
    const [invoice] = await db.select().from(s.invoices);
    const store = t.app.get(StoredFiles, { strict: false });
    const stored = await store.read(db, invoice!.pdfFileId!);
    expect(Buffer.compare(first.rawPayload, Buffer.from(stored!.bytes))).toBe(0);
    expect(await store.read(db, 999_999)).toBeUndefined();
    expect(await db.select().from(s.files)).toHaveLength(1);
  });

  it('a receipt does not change after it was issued: renaming the service or the customer does not redraw it', async () => {
    const paid = await paidOrder(t, clock, world);
    await renderReceipts(t);
    const before = await receiptOf(paid.trackingToken);
    await db.update(s.services).set({ name: 'A completely different service name' });
    await db.update(s.customers).set({ name: 'Someone Else', email: 'someone.else@mail.example' });
    const after = await receiptOf(paid.trackingToken);
    expect(after.statusCode).toBe(200);
    expect(Buffer.compare(before.rawPayload, after.rawPayload)).toBe(0);
    expect(await db.select().from(s.files)).toHaveLength(1);
  });

  it('a copy the job could not store is made by the first download, once, even for two at the same time', async () => {
    const paid = await paidOrder(t, clock, world);
    // The job meets a storage that is down: it fails (the queue would retry it) and leaves the invoice as it was.
    const down = spyOn(StoredFiles.prototype, 'store').mockRejectedValueOnce(new Error('storage is down'));
    try {
      await expectRejection(renderReceipts(t), /storage is down/);
    } finally {
      down.mockRestore();
    }
    // The capture committed without its document: the order, the journals and the invoice stand.
    expect(await orders()).toHaveLength(1);
    expect((await db.select().from(s.invoices))[0]!.pdfFileId).toBeNull();
    expect(await db.select().from(s.files)).toHaveLength(0);

    const [a, b] = await Promise.all([receiptOf(paid.trackingToken), receiptOf(paid.trackingToken)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(Buffer.compare(a.rawPayload, b.rawPayload)).toBe(0);
    expect(await db.select().from(s.files)).toHaveLength(1);
    const again = await receiptOf(paid.trackingToken);
    expect(Buffer.compare(a.rawPayload, again.rawPayload)).toBe(0);
    expect(await db.select().from(s.files)).toHaveLength(1);
    // The job that runs after the download finds the copy.
    expect(await renderReceipts(t)).toEqual(['exists']);
  });

  it('answers 503 UNAVAILABLE when the copy is missing and the storage is down, and 200 when it is back', async () => {
    const paid = await paidOrder(t, clock, world);
    const down = spyOn(StoredFiles.prototype, 'store').mockRejectedValueOnce(
      new AppError('UNAVAILABLE', { detail: 'The file storage is down.' }),
    );
    try {
      const refused = await receiptOf(paid.trackingToken);
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      down.mockRestore();
    }
    expect((await receiptOf(paid.trackingToken)).statusCode).toBe(200);
  });

  it('is 404 for an unknown token and for an order that has no receipt', async () => {
    const unknown = await t.app.inject({
      method: 'GET',
      url: `/store/v1/orders/${'x'.repeat(22)}/receipt`,
      remoteAddress: freshClientIp(),
    });
    expect(unknown.statusCode).toBe(404);
    const paid = await paidOrder(t, clock, world);
    await db.update(s.payments).set({ invoiceId: null });
    await db.delete(s.invoices);
    const none = await t.app.inject({
      method: 'GET',
      url: `/store/v1/orders/${paid.trackingToken}/receipt`,
      remoteAddress: freshClientIp(),
    });
    expect(none.statusCode).toBe(404);
  });
});
