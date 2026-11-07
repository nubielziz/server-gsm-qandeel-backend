// The `card` driver: a hosted card checkout that speaks the Stripe Checkout protocol (form-encoded API calls with a bearer key, and
// webhooks signed `t=<unix>,v1=<hmac>` with the endpoint's own secret). Serves the gateways whose driver is `card` or `stripe`.
import { AppError } from '../../../../common/errors';
import { Money } from '../../../../common/money';
import { assertWebhookSignature } from '../../../../infra/crypto';
import {
  type CheckoutRequest,
  type GatewayCalls,
  type GatewayCredentials,
  type PaymentEvent,
  type PaymentGatewayDriver,
  gatewayCall,
  objectOf,
  textOf,
} from './driver';

const DEFAULT_API_BASE = 'https://api.stripe.com';

/** The id of a JSON event body, or a refusal when the signed body is not an event. */
function eventIdOf(rawBody: Buffer): string {
  try {
    const event = objectOf(JSON.parse(rawBody.toString('utf8')));
    const id = textOf(event?.['id']);
    if (id) return id;
  } catch {
    // not JSON: refused below
  }
  throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: 'The webhook body is not an event.' });
}

/** Stripe counts money in the currency's smallest unit; billing works in 4-decimal amounts (every currency billed here has 2 digits). */
function fromMinorUnits(minor: unknown): string | null {
  return typeof minor === 'number' && Number.isSafeInteger(minor) && minor >= 0
    ? Money.of(minor).mul('0.01').toWire()
    : null;
}

function bearer(credentials: GatewayCredentials): Record<string, string> {
  if (!credentials.secret) throw new AppError('GATEWAY_ERROR', { detail: 'This payment method has no API key set.' });
  return { authorization: `Bearer ${credentials.secret}` };
}

/**
 * The card driver.
 *
 * Why: the demo's card gateway (hosted checkout page, 3D Secure). A confirmation is the `checkout.session.completed` event with
 * `payment_status` paid (or the later async success); an expired or failed session is `failed`. The payment's reference is the
 * payment intent, which the status check reads again before the wallet is credited (user rule 6).
 *
 * @see docs/contract/endpoints/money.md (POST /webhooks/payments/:gateway)
 */
export const cardDriver: PaymentGatewayDriver = {
  id: 'card',
  methodType: 'card',
  signingKey: 'webhook_secret',

  verify(delivery, key) {
    const header = delivery.headers['stripe-signature'];
    const timestamp = assertWebhookSignature(key, typeof header === 'string' ? header : '', delivery.rawBody, {
      nowSeconds: delivery.nowSeconds,
    });
    return { eventId: eventIdOf(delivery.rawBody), timestamp };
  },

  parse(body): PaymentEvent | undefined {
    const event = objectOf(body);
    const type = textOf(event?.['type']);
    const session = objectOf(objectOf(event?.['data'])?.['object']);
    if (!event || !type || !session) return undefined;
    const kind =
      type === 'checkout.session.completed'
        ? session['payment_status'] === 'paid'
          ? 'confirmed'
          : 'pending'
        : type === 'checkout.session.async_payment_succeeded'
          ? 'confirmed'
          : type === 'checkout.session.async_payment_failed' || type === 'checkout.session.expired'
            ? 'failed'
            : undefined;
    const invoiceNumber = textOf(session['client_reference_id']);
    const reference = textOf(session['payment_intent']) ?? textOf(session['id']);
    if (!kind || !invoiceNumber || !reference) return undefined;
    const currency = textOf(session['currency']);
    return {
      kind,
      invoiceNumber,
      reference,
      amount: fromMinorUnits(session['amount_total']),
      currency: currency ? currency.toUpperCase() : null,
      raw: event as PaymentEvent['raw'],
    };
  },

  async createCheckout(calls: GatewayCalls, credentials: GatewayCredentials, request: CheckoutRequest) {
    const minor = request.amount.mul(100).toWire().split('.')[0]!;
    const form = new URLSearchParams({
      mode: 'payment',
      client_reference_id: request.invoiceNumber,
      success_url: request.returnUrl,
      cancel_url: request.returnUrl,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': request.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': minor,
      'line_items[0][price_data][product_data][name]': request.description,
    });
    const answer = await gatewayCall(calls, {
      url: `${credentials.apiBase ?? DEFAULT_API_BASE}/v1/checkout/sessions`,
      method: 'POST',
      headers: { ...bearer(credentials), 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const paymentUrl = textOf(answer['url']);
    if (!paymentUrl) throw new AppError('GATEWAY_ERROR', { detail: 'The payment gateway gave no checkout address.' });
    return { paymentUrl };
  },

  async checkStatus(calls, credentials, reference) {
    const answer = await gatewayCall(calls, {
      url: `${credentials.apiBase ?? DEFAULT_API_BASE}/v1/payment_intents/${encodeURIComponent(reference)}`,
      method: 'GET',
      headers: bearer(credentials),
    });
    const status = textOf(answer['status']);
    if (status === 'succeeded') return 'confirmed';
    return status === 'canceled' ? 'failed' : 'pending';
  },
};
