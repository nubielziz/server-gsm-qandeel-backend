// Unit tests of the card and crypto drivers: the signature scheme, the events they read, and the driver lookup.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../common/money';
import { signWebhook } from '../../../../infra/crypto';
import type { HttpResult, OutboundHttp, OutboundRequestOptions } from '../../../../infra/http';
import { cardDriver } from './card-driver';
import type { GatewayCalls, GatewayCredentials } from './driver';
import { CRYPTO_SIGNATURE_HEADER, cryptoDriver } from './crypto-driver';
import { driverFor } from './drivers';

const NOW = 1_800_000_000;
const KEY = 'whsec_unit';
const delivery = (header: string, body: string, signature: string | undefined, now = NOW) => ({
  headers: signature === undefined ? {} : { [header]: signature },
  rawBody: Buffer.from(body),
  nowSeconds: now,
});
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('card driver', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

  it('verifies the t=,v1= signature and reads the event id and the signed time', () => {
    expect(cardDriver.verify(delivery('stripe-signature', body, signWebhook(KEY, NOW, body)), KEY)).toEqual({
      eventId: 'evt_1',
      timestamp: NOW,
    });
  });

  it('refuses a missing, wrong or stale signature and a body that is not an event', () => {
    expect(refusal(() => cardDriver.verify(delivery('stripe-signature', body, undefined), KEY))).toBe(
      'WEBHOOK_SIGNATURE_INVALID',
    );
    expect(
      refusal(() => cardDriver.verify(delivery('stripe-signature', body, signWebhook('other', NOW, body)), KEY)),
    ).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(
      refusal(() => cardDriver.verify(delivery('stripe-signature', body, signWebhook(KEY, NOW - 301, body)), KEY)),
    ).toBe('WEBHOOK_SIGNATURE_INVALID');
    const text = 'not json';
    expect(refusal(() => cardDriver.verify(delivery('stripe-signature', text, signWebhook(KEY, NOW, text)), KEY))).toBe(
      'WEBHOOK_SIGNATURE_INVALID',
    );
  });

  const session = (type: string, extra: Record<string, unknown> = {}) => ({
    id: 'evt',
    type,
    data: {
      object: {
        id: 'cs_1',
        client_reference_id: 'INV-2026-0001',
        payment_intent: 'pi_9',
        payment_status: 'paid',
        amount_total: 10050,
        currency: 'usd',
        ...extra,
      },
    },
  });

  it('reads a paid checkout as confirmed, with the reference, amount and currency, and no card details', () => {
    const parsed = cardDriver.parse(
      session('checkout.session.completed', {
        // A field the session never has: the card is on the Charge, which the details call reads.
        payment_method_details: { card: { brand: 'visa', last4: '4242' } },
      }),
    );
    expect(parsed).toMatchObject({
      kind: 'confirmed',
      invoiceNumber: 'INV-2026-0001',
      reference: 'pi_9',
      amount: '100.5000',
      currency: 'USD',
    });
    expect(parsed?.details).toBeUndefined();
    expect(cardDriver.parse(session('checkout.session.async_payment_succeeded'))?.kind).toBe('confirmed');
    expect(cardDriver.parse(session('checkout.session.completed', { payment_status: 'unpaid' }))?.kind).toBe('pending');
    expect(cardDriver.parse(session('checkout.session.expired'))?.kind).toBe('failed');
    expect(cardDriver.parse(session('checkout.session.async_payment_failed'))?.kind).toBe('failed');
  });

  it('ignores other events and events without an invoice reference', () => {
    expect(cardDriver.parse(session('customer.created'))).toBeUndefined();
    expect(cardDriver.parse(session('checkout.session.completed', { client_reference_id: undefined }))).toBeUndefined();
    expect(cardDriver.parse(session('checkout.session.completed', { amount_total: 'x' }))?.amount).toBeNull();
    for (const junk of [null, 'x', 5, [], {}]) expect(cardDriver.parse(junk)).toBeUndefined();
  });

  it('reads amount_total with the session currency exponent', () => {
    const read = (amount: number, currency: string) =>
      cardDriver.parse(session('checkout.session.completed', { amount_total: amount, currency }))?.amount;
    expect(read(3500, 'jod')).toBe('3.5000');
    expect(read(500, 'jpy')).toBe('500.0000');
    expect(read(500, 'isk')).toBe('5.0000');
    expect(read(1099, 'gbp')).toBe('10.9900');
    expect(cardDriver.parse(session('checkout.session.completed', { currency: undefined }))?.amount).toBeNull();
  });
});

/** A stand-in HTTP client that records the request and answers what the test says. */
function fakeCalls(answer: (options: OutboundRequestOptions) => { status: number; body: unknown } | Error): {
  calls: GatewayCalls;
  seen: OutboundRequestOptions[];
} {
  const seen: OutboundRequestOptions[] = [];
  const http = {
    request: (options: OutboundRequestOptions): Promise<HttpResult> => {
      seen.push(options);
      const result = answer(options);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ status: result.status, json: () => result.body } as unknown as HttpResult);
    },
  } as unknown as OutboundHttp;
  return { calls: { http, policy: undefined }, seen };
}

const credentials: GatewayCredentials = {
  secret: 'sk_unit',
  apiBase: 'https://gateway.example',
  webhookSecret: undefined,
  webhookSecrets: [],
};

describe('card driver amounts on the way out', () => {
  const form = (body: string | undefined) => new URLSearchParams(body ?? '');
  const checkout = (amount: string, currency: string) => {
    const { calls, seen } = fakeCalls(() => ({ status: 200, body: { url: 'https://pay.example/cs_1' } }));
    return cardDriver
      .createCheckout(calls, credentials, {
        invoiceNumber: 'PAY-1',
        amount: Money.of(amount),
        currency,
        description: 'Unlock',
        returnUrl: 'https://shop.example',
      })
      .then(() => form(seen[0]!.body as string).get('line_items[0][price_data][unit_amount]'));
  };

  it('sends a checkout in the currency minor units, rounded half up', async () => {
    expect(await checkout('3.500', 'JOD')).toBe('3500');
    expect(await checkout('3.505', 'JOD')).toBe('3510');
    expect(await checkout('500', 'JPY')).toBe('500');
    expect(await checkout('10.995', 'USD')).toBe('1100');
    expect(await checkout('5', 'ISK')).toBe('500');
  });

  it('sends a refund in the currency minor units', async () => {
    const { calls, seen } = fakeCalls(() => ({ status: 200, body: { id: 're_1', status: 'pending' } }));
    await cardDriver.refund!(calls, credentials, {
      paymentReference: 'pi_1',
      amount: Money.of('1.250'),
      currency: 'KWD',
      refundId: 4,
      idempotencyKey: 'refund-4',
      sendAttempt: 1,
    });
    expect(form(seen[0]!.body as string).get('amount')).toBe('1250');
  });
});

describe('card driver payment details', () => {
  const intent = (card: Record<string, unknown> | undefined) => ({
    id: 'pi_1',
    status: 'succeeded',
    latest_charge: {
      id: 'ch_1',
      payment_method_details: card === undefined ? { type: 'link' } : { type: 'card', card },
    },
  });
  const read = async (body: unknown, reference = 'pi_1') => {
    const { calls, seen } = fakeCalls(() => ({ status: 200, body }));
    const details = await cardDriver.paymentDetails!(calls, credentials, reference);
    return { details, seen };
  };

  it('reads the card of the latest charge through the expanded PaymentIntent, with a short timeout', async () => {
    const { details, seen } = await read(
      intent({ brand: 'visa', last4: '4242', fingerprint: 'fp_9', three_d_secure: { result: 'authenticated' } }),
    );
    expect(details).toEqual({ brand: 'visa', last4: '4242', fingerprint: 'fp_9', threeDs: true, wallet: undefined });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: 'https://gateway.example/v1/payment_intents/pi_1?expand[]=latest_charge',
      timeoutMs: 3000,
    });
    expect(seen[0]!.headers).toMatchObject({ authorization: 'Bearer sk_unit' });
  });

  it('names the wallet as the brand for Apple Pay and Google Pay', async () => {
    const { details } = await read(
      intent({ brand: 'mastercard', last4: '0005', fingerprint: 'fp_w', wallet: { type: 'apple_pay' } }),
    );
    expect(details).toMatchObject({ brand: 'apple_pay', wallet: 'apple_pay', last4: '0005', threeDs: false });
    expect((await read(intent({ brand: 'visa', wallet: { type: 'google_pay' } }))).details?.brand).toBe('google_pay');
  });

  it('counts 3-D Secure only when it authenticated or the attempt was acknowledged', async () => {
    const threeDs = async (result: string) =>
      (await read(intent({ brand: 'visa', three_d_secure: { result } }))).details?.threeDs;
    expect(await threeDs('authenticated')).toBe(true);
    expect(await threeDs('attempt_acknowledged')).toBe(true);
    for (const result of ['failed', 'not_supported', 'processing_error', 'exempted']) {
      expect(await threeDs(result)).toBe(false);
    }
  });

  it('reads nothing for a reference that is not a PaymentIntent, a charge without a card, or no charge', async () => {
    const cs = await read(intent({ brand: 'visa' }), 'cs_1');
    expect(cs.details).toBeUndefined();
    expect(cs.seen).toHaveLength(0);
    expect((await read(intent(undefined))).details).toBeUndefined();
    expect((await read({ id: 'pi_1', latest_charge: null })).details).toBeUndefined();
    expect((await read({ id: 'pi_1', latest_charge: 'ch_1' })).details).toBeUndefined();
  });

  it('throws GATEWAY_ERROR when the gateway fails, so the caller can mark the details unavailable', async () => {
    const failed = fakeCalls(() => ({ status: 500, body: {} }));
    const down = fakeCalls(() => new Error('timeout'));
    for (const { calls } of [failed, down]) {
      const error: unknown = await cardDriver.paymentDetails!(calls, credentials, 'pi_1').catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'GATEWAY_ERROR' });
    }
  });
});

describe('card driver dispute events', () => {
  const dispute = (currency: string, amount: number, fee: number) => ({
    id: 'evt_d',
    type: 'charge.dispute.created',
    data: { object: { id: 'dp_1', payment_intent: 'pi_1', amount, fee, currency, reason: 'fraudulent' } },
  });

  it('reads the amount and fee with the dispute currency exponent', () => {
    expect(cardDriver.parseDispute?.(dispute('jod', 3500, 15000))).toMatchObject({
      amount: '3.5000',
      fee: '15.0000',
      currency: 'JOD',
    });
    expect(cardDriver.parseDispute?.(dispute('jpy', 500, 1500))).toMatchObject({
      amount: '500.0000',
      fee: '1500.0000',
      currency: 'JPY',
    });
  });
});

describe('card driver refund events', () => {
  const refundEvent = (
    type: string,
    metadata?: Record<string, string>,
    status = 'failed',
    failure: unknown = 'expired_or_canceled_card',
  ) => ({
    id: 'evt_r',
    type,
    data: { object: { id: 're_1', status, failure_reason: failure, ...(metadata ? { metadata } : {}) } },
  });

  it('reads the refund id and the send attempt the refund call put in the metadata', () => {
    expect(cardDriver.parseRefund?.(refundEvent('refund.failed', { refund_id: '7', send_attempt: '2' }))).toMatchObject(
      { kind: 'failed', gatewayRefundId: 're_1', refundId: 7, sendAttempt: 2 },
    );
    expect(
      cardDriver.parseRefund?.(refundEvent('refund.updated', { refund_id: '7', send_attempt: '1' }, 'succeeded', null)),
    ).toMatchObject({ kind: 'succeeded', refundId: 7, sendAttempt: 1, failure: null });
  });

  it('maps the event type and the refund status to a result (Stripe sends no refund.succeeded)', () => {
    const kind = (type: string, status: string) => cardDriver.parseRefund?.(refundEvent(type, undefined, status))?.kind;
    for (const type of ['refund.updated', 'charge.refund.updated']) {
      expect(kind(type, 'succeeded')).toBe('succeeded');
      expect(kind(type, 'failed')).toBe('failed');
      expect(kind(type, 'canceled')).toBe('failed');
      for (const status of ['pending', 'requires_action', 'something_new']) expect(kind(type, status)).toBeUndefined();
    }
    for (const status of ['failed', 'succeeded', 'pending']) expect(kind('refund.failed', status)).toBe('failed');
    for (const type of ['refund.created', 'charge.refunded', 'refund.succeeded']) {
      expect(kind(type, 'succeeded')).toBeUndefined();
    }
    expect(cardDriver.parseRefund?.(refundEvent('refund.updated', undefined, 'canceled', null))?.failure).toBe(
      'canceled',
    );
  });

  it('reads no attempt from an event that does not say, or says something that is not one', () => {
    expect(cardDriver.parseRefund?.(refundEvent('refund.failed'))).toMatchObject({ refundId: null, sendAttempt: null });
    for (const junk of ['0', '-1', '1.5', 'two', '']) {
      expect(
        cardDriver.parseRefund?.(refundEvent('refund.failed', { refund_id: '7', send_attempt: junk })),
      ).toMatchObject({
        sendAttempt: null,
      });
    }
    expect(cardDriver.parseRefund?.(refundEvent('refund.updated', undefined, 'pending'))).toBeUndefined();
  });
});

describe('crypto driver', () => {
  const body = JSON.stringify({ id: 'evt_c', type: 'invoice.confirmed', data: {} });

  it('verifies the same scheme from its own header only', () => {
    expect(cryptoDriver.verify(delivery(CRYPTO_SIGNATURE_HEADER, body, signWebhook(KEY, NOW, body)), KEY).eventId).toBe(
      'evt_c',
    );
    expect(
      refusal(() => cryptoDriver.verify(delivery('stripe-signature', body, signWebhook(KEY, NOW, body)), KEY)),
    ).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  const invoice = (type: string, confirmations: number, required = 3) => ({
    id: 'evt',
    type,
    data: {
      id: 'cinv_1',
      reference: 'INV-2026-0002',
      amount: '100.00',
      currency: 'usdt',
      confirmations,
      requiredConfirmations: required,
    },
  });

  it('confirms only at the required confirmations', () => {
    expect(cryptoDriver.parse(invoice('invoice.confirmed', 3))).toMatchObject({
      kind: 'confirmed',
      reference: 'cinv_1',
      invoiceNumber: 'INV-2026-0002',
      amount: '100.00',
      currency: 'USDT',
    });
    expect(cryptoDriver.parse(invoice('invoice.confirmed', 2))?.kind).toBe('pending');
    expect(cryptoDriver.parse(invoice('invoice.pending', 3))?.kind).toBe('pending');
    expect(cryptoDriver.parse(invoice('invoice.expired', 0))?.kind).toBe('failed');
    expect(cryptoDriver.parse(invoice('invoice.refunded', 0))).toBeUndefined();
  });
});

describe('driverFor', () => {
  it('finds the code behind a driver name and nothing for a name that has none', () => {
    expect(driverFor('card')).toBe(cardDriver);
    expect(driverFor('Stripe')).toBe(cardDriver);
    expect(driverFor('crypto')).toBe(cryptoDriver);
    expect(driverFor('usdt')).toBe(cryptoDriver);
    for (const name of ['bank', 'wise', '', '__proto__', 'constructor']) expect(driverFor(name)).toBeUndefined();
  });
});
