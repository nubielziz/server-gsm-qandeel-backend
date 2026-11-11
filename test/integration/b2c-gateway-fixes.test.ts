// Integration tests of the payment provider fixes on the storefront (feature 24C): minor units per currency both ways, card details read
// from the PaymentIntent's latest Charge before the capture, and dispute events delivered to the payments endpoint.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { type Database, schema as s } from '../../src/infra/db';
import { MetricsService } from '../../src/infra/metrics';
import { toMinor } from '../../src/modules/money/infra/gateway-drivers/stripe-amounts';
import { type TestApp, createTestApp } from '../support/app';
import {
  type B2cWorld,
  B2cGateway,
  b2cWorld,
  disputeEvent,
  hook,
  json,
  minorOf,
  openCheckout,
  paidOrder,
  pay,
  storefrontEvent,
} from '../support/b2c';
import { GatewayTestModule } from '../support/billing';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { assessmentOf } from '../support/risk';
import { insertCurrency } from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

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
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  world = await b2cWorld(t, db, fake);
  await insertCurrency(db, { code: 'JOD', name: 'Jordanian dinar', rateToBase: '0.709', decimals: 3 });
  await insertCurrency(db, { code: 'JPY', name: 'Japanese yen', rateToBase: '150', decimals: 0 });
});

const eventId = () => `evt_${crypto.randomUUID()}`;
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const orders = () => db.select().from(s.orders);

/** Opens a checkout in a currency, pays it and returns the payment and the unit amount the gateway was asked for. */
async function opened(currency: string) {
  const { token } = await openCheckout(t, world, { currency });
  const started = await pay(t, token, undefined);
  expect(started.statusCode).toBe(201);
  const { payment } = json(started);
  const [call] = fake.calls('/v1/checkout/sessions');
  const form = new URLSearchParams(call!.body);
  return {
    payment: payment as { id: number; reference: string; amount: string; currency: string },
    unitAmount: form.get('line_items[0][price_data][unit_amount]'),
    sentCurrency: form.get('line_items[0][price_data][currency]'),
  };
}

describe('amounts in the currency minor units (24C)', () => {
  it('a JOD checkout is sent with three digits and confirmed at the same amount; a tenth of it is held for staff', async () => {
    const { payment, unitAmount, sentCurrency } = await opened('JOD');
    expect(payment.currency).toBe('JOD');
    const expected = toMinor(Money.of(payment.amount), 'JOD');
    expect(sentCurrency).toBe('jod');
    expect(unitAmount).toBe(expected.minor);
    // The old code sent amount × 100 (a tenth of a JOD price): the gateway reporting that is a mismatch, never a capture.
    const tenth = JSON.parse(
      storefrontEvent(eventId(), payment.reference, { amount: payment.amount, currency: 'JOD', intent: 'pi_tenth' }),
    );
    tenth.data.object.amount_total = Math.round(Number(expected.minor) / 10);
    expect((await hook(t, clock, 'payments', 'card-b2c', JSON.stringify(tenth))).statusCode).toBe(200);
    expect(await orders()).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', reviewRequired: true });
    expect((await paymentRow(payment.id)).reviewNote).toContain(`opened for ${payment.amount}`);
  });

  it('a JOD price whose third digit is not 0 is rounded half up at the gateway (3.396 -> 3400) and held for staff', async () => {
    const { payment, unitAmount } = await opened('JOD');
    expect(payment.amount).toBe('3.3960');
    expect(unitAmount).toBe('3400');
    const body = storefrontEvent(eventId(), payment.reference, { amount: '3.400', currency: 'JOD', intent: 'pi_jod' });
    expect(JSON.parse(body).data.object.amount_total).toBe(3400);
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    // The gateway charged 3.400, the payment was opened for 3.396: the exact guard holds it (never hidden).
    expect(await orders()).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', reviewRequired: true });
    expect((await paymentRow(payment.id)).reviewNote).toContain('3.4000');
  });

  it('with two display decimals (plan 24C decision 2) a JOD checkout is charged and captured at its exact amount', async () => {
    await insertCurrency(db, { code: 'JOD', decimals: 2 });
    const { payment, unitAmount } = await opened('JOD');
    expect(payment.amount).toBe('3.4000');
    expect(unitAmount).toBe('3400');
    const body = storefrontEvent(eventId(), payment.reference, {
      amount: payment.amount,
      currency: 'JOD',
      intent: 'pi_jod2',
    });
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'captured', amount: '3.4000', currency: 'JOD' });
    expect(await orders()).toHaveLength(1);
  });

  it('a JPY checkout is sent in whole yen and captured', async () => {
    const { payment, unitAmount } = await opened('JPY');
    expect(payment.amount).toMatch(/^\d+\.0000$/);
    expect(unitAmount).toBe(String(Number(payment.amount)));
    const body = storefrontEvent(eventId(), payment.reference, {
      amount: payment.amount,
      currency: 'JPY',
      intent: 'pi_jpy',
    });
    expect(JSON.parse(body).data.object.amount_total).toBe(minorOf(payment.amount, 'JPY'));
    expect((await hook(t, clock, 'payments', 'card-b2c', body)).statusCode).toBe(200);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'captured', currency: 'JPY' });
  });
});

describe('card details from the PaymentIntent (24C)', () => {
  it('reads brand, last 4, fingerprint and 3-D Secure from the latest charge before the capture', async () => {
    const paid = await paidOrder(t, clock, world, {
      card: { brand: 'mastercard', last4: '5555', fingerprint: 'fp_mc', threeDs: true },
    });
    const [call] = fake.calls(`/v1/payment_intents/${paid.intent}`);
    expect(call).toMatchObject({ method: 'GET' });
    expect(await paymentRow(paid.paymentId)).toMatchObject({
      status: 'captured',
      methodType: 'card',
      brand: 'Mastercard •••• 5555',
      cardFingerprint: 'fp_mc',
      threeDs: true,
    });
  });

  it('an Apple Pay payment is a wallet payment', async () => {
    const paid = await paidOrder(t, clock, world, {
      card: { brand: 'visa', last4: '1111', fingerprint: 'fp_ap', threeDs: false, wallet: 'apple_pay' },
    });
    expect(await paymentRow(paid.paymentId)).toMatchObject({
      methodType: 'wallet',
      brand: 'Apple Pay',
      cardFingerprint: 'fp_ap',
      threeDs: false,
    });
  });

  it('a details call that fails still captures, with the risk signal, and counts it', async () => {
    fake.failDetails = 500;
    const paid = await paidOrder(t, clock, world);
    expect(await paymentRow(paid.paymentId)).toMatchObject({ status: 'captured', brand: '', cardFingerprint: null });
    const assessment = await assessmentOf(db, paid.orderId);
    expect(assessment.signals).toContain('Card details unavailable from the gateway');
    // Alone the signal does not hold the order.
    expect(assessment).toMatchObject({ decision: 'allow' });
    const metrics = await t.app.get(MetricsService).render();
    expect(metrics).toContain('gateway_card_details_unavailable_total{gateway="card-b2c"} 1');
  });

  it('a details call that hangs times out after 3 seconds and still captures', async () => {
    fake.failDetails = 'hang';
    const started = performance.now();
    const paid = await paidOrder(t, clock, world);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await paymentRow(paid.paymentId)).toMatchObject({ status: 'captured', cardFingerprint: null });
    expect((await assessmentOf(db, paid.orderId)).signals).toContain('Card details unavailable from the gateway');
  });
});

describe('dispute events on the payments endpoint (24C)', () => {
  it('a dispute sent to /webhooks/payments is handled as on the disputes URL, and the same dispute on both is recorded once', async () => {
    const paid = await paidOrder(t, clock, world);
    const created = disputeEvent(eventId(), { dispute: 'dp_both', intent: paid.intent });
    const first = await hook(t, clock, 'payments', 'card-b2c', created);
    expect(first.statusCode).toBe(200);
    expect(json(first)).toEqual({ received: true });
    const disputes = () => db.select().from(s.disputes);
    expect(await disputes()).toHaveLength(1);
    expect((await disputes())[0]).toMatchObject({ gatewayDisputeId: 'dp_both', paymentId: paid.paymentId });
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');

    // The provider sends the same dispute to the other endpoint (another delivery id): one dispute stays.
    const again = await hook(
      t,
      clock,
      'disputes',
      'card-b2c',
      disputeEvent(eventId(), { dispute: 'dp_both', intent: paid.intent }),
    );
    expect(again.statusCode).toBe(200);
    expect(json(again)).toMatchObject({ received: true, duplicate: true });
    expect(await disputes()).toHaveLength(1);

    // It closes through the payments endpoint too: a loss posts the chargeback journal once.
    const journals = (await ledgerTotals(db)).transactions;
    const lost = () =>
      disputeEvent(eventId(), {
        dispute: 'dp_both',
        intent: paid.intent,
        type: 'charge.dispute.closed',
        status: 'lost',
      });
    expect((await hook(t, clock, 'payments', 'card-b2c', lost())).statusCode).toBe(200);
    expect((await disputes())[0]!.status).toBe('lost');
    const after = (await ledgerTotals(db)).transactions;
    expect(after).toBeGreaterThan(journals);
    expect((await hook(t, clock, 'disputes', 'card-b2c', lost())).statusCode).toBe(200);
    expect((await ledgerTotals(db)).transactions).toBe(after);
  });
});
