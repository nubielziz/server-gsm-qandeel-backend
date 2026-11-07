// Integration tests of the incoming payment confirmation (map stage 8, POST /webhooks/payments/:gateway): the signature of each
// driver, the 5-minute window, the event-id replay filter, the payment recorded once (even under a race), the review path for a
// confirmation that does not match its invoice, and the events that are only acknowledged.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  insertInvoiceRow,
  postWebhook,
  signedHeaders,
} from '../support/billing';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant } from '../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
const fake = new FakeGateway();
let t: TestApp;
let db: Database;

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
  clock.set('2026-11-01T10:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
});

const eventId = () => `evt_${crypto.randomUUID()}`;

/** A merchant with an open top-up invoice of 100 (fee 3.2) at a card gateway. */
async function world(gatewayOverrides: Record<string, unknown> = {}) {
  const merchant = await insertWalletMerchant(db, { name: 'Zain' });
  const gatewayId = await insertGateway(t, db, {
    code: 'card',
    name: 'Card gateway',
    driver: 'card',
    apiBase: fake.url,
    ...gatewayOverrides,
  });
  const invoice = await insertInvoiceRow(db, merchant.id, { amount: '100.0000', fee: '3.2000', gatewayId });
  return { merchant, gatewayId, invoice };
}

const send = (body: string, gateway = 'card', secret = WEBHOOK_KEY) =>
  postWebhook(t, gateway, body, signedHeaders(secret, body, clock));
const payments = () => db.select().from(s.payments);

describe('POST /webhooks/payments/:gateway (card driver)', () => {
  it('records a confirmed payment as pending, with the time it credits itself', async () => {
    const { invoice, gatewayId } = await world();
    const res = await send(cardEvent(eventId(), invoice.number, { reference: 'pi_100', amount: 10000 }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    const [payment] = await payments();
    expect(payment).toMatchObject({
      purpose: 'topup',
      invoiceId: invoice.id,
      gatewayId,
      gatewayTxnId: 'pi_100',
      amount: '100.0000',
      feeAmount: '3.2000',
      currency: 'USD',
      status: 'pending',
      methodType: 'card',
      reviewRequired: false,
      reviewedBy: null,
    });
    expect(payment!.capturedAt!.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(payment!.autoCreditAt!.toISOString()).toBe('2026-11-01T10:10:00.000Z');
    expect(payment!.raw).toMatchObject({ type: 'checkout.session.completed' });
    // Nothing is credited yet: the job does it after the delay.
    expect(await db.select().from(s.ledgerTransactions)).toHaveLength(0);
    expect((await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id)))[0]!.status).toBe('open');
  });

  it('waits the longer of the delay setting and the gateway hold hours', async () => {
    const hold = await world({ holdHours: 2 });
    await send(cardEvent(eventId(), hold.invoice.number, { reference: 'pi_hold' }));
    expect((await payments())[0]!.autoCreditAt!.toISOString()).toBe('2026-11-01T12:00:00.000Z');

    await resetDb();
    await db.insert(s.settings).values({ key: 'payments.auto_credit_delay_minutes', value: 30 });
    await clearIdentityCaches(t);
    const delayed = await world();
    await send(cardEvent(eventId(), delayed.invoice.number, { reference: 'pi_delay' }));
    expect((await payments())[0]!.autoCreditAt!.toISOString()).toBe('2026-11-01T10:30:00.000Z');
  });

  it('records one payment when the same event, the same payment under a new event, or a race arrives', async () => {
    const { invoice } = await world();
    const same = eventId();
    const body = cardEvent(same, invoice.number, { reference: 'pi_once' });
    expect((await send(body)).statusCode).toBe(200);
    expect((await send(body)).statusCode).toBe(200);
    expect((await send(cardEvent(eventId(), invoice.number, { reference: 'pi_once' }))).json()).toEqual({
      received: true,
      duplicate: true,
    });
    const racing = await Promise.all(
      Array.from({ length: 5 }, () => send(cardEvent(eventId(), invoice.number, { reference: 'pi_race' }))),
    );
    expect(racing.every((res) => res.statusCode === 200)).toBe(true);
    expect((await payments()).map((payment) => payment.gatewayTxnId).sort()).toEqual(['pi_once', 'pi_race']);
  });

  it('refuses a missing, wrong, malformed or stale signature and an unknown gateway', async () => {
    const { invoice } = await world();
    const body = cardEvent(eventId(), invoice.number);
    const refused = (res: Awaited<ReturnType<typeof postWebhook>>) => {
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBHOOK_SIGNATURE_INVALID');
    };
    refused(await postWebhook(t, 'card', body, { 'content-type': 'application/json' }));
    refused(await send(body, 'card', 'whsec_wrong'));
    refused(await postWebhook(t, 'card', body, { 'content-type': 'application/json', 'stripe-signature': 'garbage' }));
    refused(await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock, 'stripe-signature', -301)));
    refused(await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock, 'stripe-signature', 301)));
    // The body is part of the signature: a changed amount is refused.
    refused(await postWebhook(t, 'card', body.replace('INV', 'INX'), signedHeaders(WEBHOOK_KEY, body, clock)));
    refused(await send(body, 'nope'));
    refused(await send(body, 'Bad Slug'));
    expect(await payments()).toHaveLength(0);
    // Inside the window it is accepted.
    expect(
      (await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock, 'stripe-signature', -290)))
        .statusCode,
    ).toBe(200);
  });

  it('refuses a manual gateway, a gateway without a webhook key and one whose driver has no code', async () => {
    const { invoice } = await world();
    await insertGateway(t, db, { code: 'bank', isManual: true });
    await insertGateway(t, db, { code: 'nokey', driver: 'card', webhookSecret: null });
    await insertGateway(t, db, { code: 'mystery', driver: 'mystery' });
    const body = cardEvent(eventId(), invoice.number);
    for (const gateway of ['bank', 'nokey', 'mystery']) {
      const res = await send(body, gateway);
      expect(res.statusCode, gateway).toBe(400);
      expect(res.json().code).toBe('WEBHOOK_SIGNATURE_INVALID');
    }
  });

  it('acknowledges and ignores events that record nothing: other types, failures, unknown or settled invoices, other gateways', async () => {
    const { invoice, merchant } = await world();
    const other = await insertGateway(t, db, { code: 'other', driver: 'card', apiBase: fake.url });
    const foreign = await insertInvoiceRow(db, merchant.id, { gatewayId: other });
    const paid = await insertInvoiceRow(db, merchant.id, {
      status: 'paid',
      gatewayId: (await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.code, 'card')))[0]!.id,
    });
    const bodies = [
      JSON.stringify({ id: eventId(), type: 'customer.created', data: { object: { id: 'cus_1' } } }),
      cardEvent(eventId(), invoice.number, { type: 'checkout.session.expired' }),
      cardEvent(eventId(), invoice.number, { paymentStatus: 'unpaid' }),
      cardEvent(eventId(), 'INV-2026-9999'),
      cardEvent(eventId(), foreign.number),
      cardEvent(eventId(), paid.number),
    ];
    for (const body of bodies) expect((await send(body)).statusCode).toBe(200);
    expect(await payments()).toHaveLength(0);
  });

  it('sends a confirmation whose amount or currency differs from the invoice to staff review', async () => {
    const { invoice } = await world();
    await send(cardEvent(eventId(), invoice.number, { reference: 'pi_less', amount: 5000 }));
    const [less] = await payments();
    // The row keeps the invoice's quote (amount and fee); what the gateway reported is in the note and the stored event, and
    // crediting refuses the payment from that event (payments-review.test.ts), so nothing here can credit 100.
    expect(less).toMatchObject({ reviewRequired: true, autoCreditAt: null, amount: '100.0000', feeAmount: '3.2000' });
    expect(less!.reviewNote).toBe('The gateway reports 50.0000 paid; the invoice is 100.0000.');
    expect(less!.raw).toMatchObject({ data: { object: { amount_total: 5000 } } });

    await resetDb();
    const second = await world();
    await send(cardEvent(eventId(), second.invoice.number, { reference: 'pi_eur', amount: 10000, currency: 'eur' }));
    expect((await payments())[0]).toMatchObject({ reviewRequired: true });
    expect((await payments())[0]!.reviewNote).toBe('The gateway reports a payment in EUR; the invoice is in USD.');
  });
});

describe('POST /webhooks/payments/:gateway (crypto driver)', () => {
  const cryptoEvent = (id: string, invoiceNumber: string, type: string, confirmations: number, required = 3) =>
    JSON.stringify({
      id,
      type,
      data: {
        id: `cinv_${id}`,
        reference: invoiceNumber,
        amount: '100.00',
        currency: 'USD',
        confirmations,
        requiredConfirmations: required,
      },
    });

  it('records a payment only once the gateway reports the required confirmations', async () => {
    const merchant = await insertWalletMerchant(db);
    const gatewayId = await insertGateway(t, db, {
      code: 'crypto',
      driver: 'crypto',
      name: 'Crypto',
      apiBase: fake.url,
      holdHours: 0,
    });
    const invoice = await insertInvoiceRow(db, merchant.id, { gatewayId, fee: '1.0000' });
    const post = (body: string) =>
      postWebhook(t, 'crypto', body, signedHeaders(WEBHOOK_KEY, body, clock, 'x-gsm-signature'));
    expect((await post(cryptoEvent(eventId(), invoice.number, 'invoice.pending', 1))).statusCode).toBe(200);
    expect((await post(cryptoEvent(eventId(), invoice.number, 'invoice.confirmed', 2))).statusCode).toBe(200);
    expect(await payments()).toHaveLength(0);
    const id = eventId();
    expect((await post(cryptoEvent(id, invoice.number, 'invoice.confirmed', 3))).statusCode).toBe(200);
    const [payment] = await payments();
    expect(payment).toMatchObject({
      gatewayTxnId: `cinv_${id}`,
      methodType: 'usdt',
      status: 'pending',
      feeAmount: '1.0000',
    });
    expect(payment!.autoCreditAt!.getTime()).toBe(clock.nowMs() + 10 * MINUTE);
    // The card header means nothing to the crypto driver.
    const body = cryptoEvent(eventId(), invoice.number, 'invoice.confirmed', 3);
    expect(
      (await postWebhook(t, 'crypto', body, signedHeaders(WEBHOOK_KEY, body, clock, 'stripe-signature'))).statusCode,
    ).toBe(400);
  });
});
