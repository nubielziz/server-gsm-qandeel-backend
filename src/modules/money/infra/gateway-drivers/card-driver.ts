// The `card` driver: a hosted card checkout that speaks the Stripe Checkout protocol (form-encoded API calls with a bearer key, and
// webhooks signed `t=<unix>,v1=<hmac>` with the endpoint's own secret). Serves the gateways whose driver is `card` or `stripe`.
import { AppError } from '../../../../common/errors';
import { Money } from '../../../../common/money';
import { assertWebhookSignature } from '../../../../infra/crypto';
import {
  type CheckoutRequest,
  type DisputeEvent,
  type GatewayCalls,
  type GatewayCredentials,
  type PaymentDetails,
  type PaymentEvent,
  type PaymentGatewayDriver,
  type RefundAnswer,
  type RefundEvent,
  type RefundRequest,
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

/** What the checkout event says about how the buyer paid: a card (brand, last digits, fingerprint, 3-D Secure) or a wallet. */
function detailsOf(session: Record<string, unknown>): PaymentDetails | undefined {
  const method = objectOf(session['payment_method_details']);
  const card = objectOf(method?.['card']);
  if (!method || !card) return undefined;
  const wallet = textOf(objectOf(card['wallet'])?.['type']);
  return {
    brand: wallet ?? textOf(card['brand']),
    last4: textOf(card['last4']),
    fingerprint: textOf(card['fingerprint']),
    threeDs: objectOf(card['three_d_secure']) !== undefined,
    wallet,
  };
}

/** A timestamp in unix seconds as a date, or `null`. */
function dateOf(seconds: unknown): Date | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
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
      details: detailsOf(session),
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
    if (request.require3ds) form.set('payment_method_options[card][request_three_d_secure]', 'any');
    const answer = await gatewayCall(calls, {
      url: `${credentials.apiBase ?? DEFAULT_API_BASE}/v1/checkout/sessions`,
      method: 'POST',
      headers: {
        ...bearer(credentials),
        'content-type': 'application/x-www-form-urlencoded',
        ...(request.idempotencyKey === undefined ? {} : { 'idempotency-key': request.idempotencyKey }),
      },
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
  async refund(calls: GatewayCalls, credentials: GatewayCredentials, request: RefundRequest): Promise<RefundAnswer> {
    const form = new URLSearchParams({
      payment_intent: request.paymentReference,
      amount: request.amount.mul(100).toWire().split('.')[0]!,
      'metadata[refund_id]': String(request.refundId),
      'metadata[send_attempt]': String(request.sendAttempt),
    });
    const answer = await gatewayCall(calls, {
      url: `${credentials.apiBase ?? DEFAULT_API_BASE}/v1/refunds`,
      method: 'POST',
      headers: {
        ...bearer(credentials),
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': request.idempotencyKey,
      },
      body: form.toString(),
    });
    const gatewayRefundId = textOf(answer['id']);
    if (!gatewayRefundId) throw new AppError('GATEWAY_ERROR', { detail: 'The payment gateway gave no refund id.' });
    const status = textOf(answer['status']);
    return {
      gatewayRefundId,
      status:
        status === 'succeeded' ? 'succeeded' : status === 'failed' || status === 'canceled' ? 'failed' : 'pending',
      failure: textOf(answer['failure_reason']) ?? null,
    };
  },

  parseRefund(body): RefundEvent | undefined {
    const event = objectOf(body);
    const type = textOf(event?.['type']);
    const refund = objectOf(objectOf(event?.['data'])?.['object']);
    const gatewayRefundId = textOf(refund?.['id']);
    if (!event || !refund || !gatewayRefundId) return undefined;
    if (type !== 'refund.succeeded' && type !== 'refund.failed') return undefined;
    const metadata = objectOf(refund['metadata']);
    const echoed = Number(textOf(metadata?.['refund_id']));
    const attempt = Number(textOf(metadata?.['send_attempt']));
    return {
      kind: type === 'refund.succeeded' ? 'succeeded' : 'failed',
      gatewayRefundId,
      refundId: Number.isSafeInteger(echoed) && echoed > 0 ? echoed : null,
      sendAttempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null,
      failure: textOf(refund['failure_reason']) ?? null,
      raw: event as RefundEvent['raw'],
    };
  },

  parseDispute(body): DisputeEvent | undefined {
    const event = objectOf(body);
    const type = textOf(event?.['type']);
    const dispute = objectOf(objectOf(event?.['data'])?.['object']);
    const reference = textOf(dispute?.['id']);
    const paymentReference = textOf(dispute?.['payment_intent']);
    if (!event || !dispute || !reference || !paymentReference) return undefined;
    let kind: DisputeEvent['kind'] | undefined;
    if (type === 'charge.dispute.created') kind = 'created';
    else if (type === 'charge.dispute.closed')
      kind = dispute['status'] === 'won' ? 'won' : dispute['status'] === 'lost' ? 'lost' : undefined;
    if (!kind) return undefined;
    const currency = textOf(dispute['currency']);
    return {
      kind,
      reference,
      paymentReference,
      amount: fromMinorUnits(dispute['amount']),
      currency: currency ? currency.toUpperCase() : null,
      fee: fromMinorUnits(dispute['fee']),
      reasonCode: textOf(dispute['reason']) ?? 'general',
      evidenceDueAt: dateOf(objectOf(dispute['evidence_details'])?.['due_by']),
      raw: event as DisputeEvent['raw'],
    };
  },

  async submitEvidence(calls, credentials, request) {
    await gatewayCall(calls, {
      url: `${credentials.apiBase ?? DEFAULT_API_BASE}/v1/disputes/${encodeURIComponent(request.disputeReference)}`,
      method: 'POST',
      headers: { ...bearer(credentials), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'evidence[uncategorized_text]': request.text, submit: 'true' }).toString(),
    });
  },
};
