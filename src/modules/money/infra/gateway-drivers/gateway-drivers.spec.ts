// Unit tests of the card and crypto drivers: the signature scheme, the events they read, and the driver lookup.
import { describe, expect, it } from 'bun:test';
import { signWebhook } from '../../../../infra/crypto';
import { cardDriver } from './card-driver';
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

  it('reads a paid checkout as confirmed, with the reference, amount and currency', () => {
    expect(cardDriver.parse(session('checkout.session.completed'))).toMatchObject({
      kind: 'confirmed',
      invoiceNumber: 'INV-2026-0001',
      reference: 'pi_9',
      amount: '100.5000',
      currency: 'USD',
    });
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
});

describe('card driver refund events', () => {
  const refundEvent = (type: string, metadata?: Record<string, string>) => ({
    id: 'evt_r',
    type,
    data: { object: { id: 're_1', failure_reason: 'expired_or_canceled_card', ...(metadata ? { metadata } : {}) } },
  });

  it('reads the refund id and the send attempt the refund call put in the metadata', () => {
    expect(cardDriver.parseRefund?.(refundEvent('refund.failed', { refund_id: '7', send_attempt: '2' }))).toMatchObject(
      { kind: 'failed', gatewayRefundId: 're_1', refundId: 7, sendAttempt: 2 },
    );
    expect(
      cardDriver.parseRefund?.(refundEvent('refund.succeeded', { refund_id: '7', send_attempt: '1' })),
    ).toMatchObject({ kind: 'succeeded', refundId: 7, sendAttempt: 1 });
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
    expect(cardDriver.parseRefund?.(refundEvent('refund.updated'))).toBeUndefined();
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
