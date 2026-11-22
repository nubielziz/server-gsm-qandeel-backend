// The `card` driver: a hosted card checkout that speaks the Stripe Checkout protocol (form-encoded API calls with a bearer key, and
// webhooks signed `t=<unix>,v1=<hmac>` with the endpoint's own secret). Serves the gateways whose driver is `card` or `stripe`. Amounts
// travel in each currency's minor units (`stripe-amounts.ts`); card details come from the PaymentIntent's latest Charge (feature 24C); the
// record of a storefront payment is read back before its capture (decision 048).
import { Logger } from '@nestjs/common';
import { AppError } from '../../../../common/errors';
import type { Money } from '../../../../common/money';
import { assertWebhookSignature } from '../../../../infra/crypto';
import type { PaymentAftermath } from '../../domain/payment-rules';
import {
  CARD_FUNDINGS,
  type CardFunding,
  type CheckoutRequest,
  DETAILS_TIMEOUT_MS,
  type DisputeEvent,
  type GatewayCalls,
  type GatewayCredentials,
  GatewayRefusalError,
  type PaymentCheck,
  type PaymentDetails,
  type PaymentEvent,
  type PaymentGatewayDriver,
  type RefundAnswer,
  type RefundEvent,
  type RefundRequest,
  gatewayCall,
  httpsUrlOf,
  notHttps,
  objectOf,
  textOf,
  unixSecondsToDate,
} from './driver';
import { chargeableDecimals, fromMinor, toMinor } from './stripe-amounts';

const DEFAULT_API_BASE = 'https://api.stripe.com';
const logger = new Logger('CardDriver');

/** The 3-D Secure results that mean the cardholder was authenticated (or the issuer acknowledged the attempt and took the liability). */
const THREE_DS_PASSED: ReadonlySet<string> = new Set(['authenticated', 'attempt_acknowledged']);

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

/**
 * The minor units of an outgoing amount; a rounded one is logged (never with personal data), and the exact mismatch guards of the
 * confirmation then hold the payment for staff.
 */
function minorOf(amount: Money, currency: string, what: string): string {
  const { minor, exact } = toMinor(amount, currency);
  if (!exact) {
    logger.warn(
      `${what}: ${amount.toWire()} ${currency.toUpperCase()} cannot be charged exactly; the gateway is asked for ${fromMinor(Number(minor), currency)}.`,
    );
  }
  return minor;
}

/** The two-letter issuing country of a card (upper case), or `undefined` when the gateway gave none or something else. */
function issuerCountryOf(value: unknown): string | undefined {
  const code = textOf(value)?.trim().toUpperCase();
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : undefined;
}

/** How a card is funded, when the gateway names one of the known values exactly (it writes them in lower case). */
function fundingOf(value: unknown): CardFunding | undefined {
  const text = textOf(value);
  return CARD_FUNDINGS.find((funding) => funding === text);
}

/**
 * How a payment was made, from the `card` of a Charge's `payment_method_details`: brand (the wallet's name for Apple Pay or Google
 * Pay), last digits, fingerprint, 3-D Secure, wallet, issuing country and funding.
 */
function cardDetailsOf(charge: Record<string, unknown> | undefined): PaymentDetails | undefined {
  const card = objectOf(objectOf(charge?.['payment_method_details'])?.['card']);
  if (!card) return undefined;
  const wallet = textOf(objectOf(card['wallet'])?.['type']);
  const threeDs = textOf(objectOf(card['three_d_secure'])?.['result']);
  return {
    brand: wallet ?? textOf(card['brand']),
    last4: textOf(card['last4']),
    fingerprint: textOf(card['fingerprint']),
    threeDs: threeDs !== undefined && THREE_DS_PASSED.has(threeDs),
    wallet,
    country: issuerCountryOf(card['country']),
    funding: fundingOf(card['funding']),
  };
}

/**
 * What a Charge shows happened to its money after the payment (decision 048): disputed, refunded in full (`refunded`), or refunded in part
 * (`amount_refunded` above zero). A dispute is named first: the money is contested whatever was refunded.
 */
function aftermathOf(charge: Record<string, unknown> | undefined): PaymentAftermath | undefined {
  if (!charge) return undefined;
  if (charge['disputed'] === true) return 'disputed';
  if (charge['refunded'] === true) return 'refunded';
  const refunded = charge['amount_refunded'];
  return typeof refunded === 'number' && refunded > 0 ? 'partially_refunded' : undefined;
}

/** The result a refund event reports, by Stripe's event type and the refund's `status` (plan 24C § 2.3). */
function refundResultOf(type: string | undefined, status: string | undefined): RefundEvent['kind'] | undefined {
  if (type === 'refund.failed') return 'failed';
  // `charge.refund.updated` is the older name of the same object's event.
  if (type !== 'refund.updated' && type !== 'charge.refund.updated') return undefined;
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'canceled') return 'failed';
  return undefined;
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
 * payment intent, which the status check reads again before the wallet is credited (user rule 6). Decision 048: the hosted page closes
 * at the request's `expiresAt` (`expires_at`), the payment intent carries the reference billing gave it (`metadata[reference]`), the
 * checkout address must be https, and `verifyPayment` reads the record of a payment back (status, amount received, currency, charge time,
 * card and reference, whether it ended unpaid, and whether its latest charge was refunded or disputed since).
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
      amount: fromMinor(session['amount_total'], currency),
      currency: currency ? currency.toUpperCase() : null,
      raw: event as PaymentEvent['raw'],
      occurredAt: unixSecondsToDate(event['created']),
    };
  },

  async createCheckout(calls: GatewayCalls, credentials: GatewayCredentials, request: CheckoutRequest) {
    const minor = minorOf(request.amount, request.currency, `Checkout ${request.invoiceNumber}`);
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
    // The payment's own record names the reference it was opened for, so a confirmation can be matched to its checkout (decision 048).
    form.set('payment_intent_data[metadata][reference]', request.invoiceNumber);
    if (request.expiresAt !== undefined) {
      form.set('expires_at', String(Math.floor(request.expiresAt.getTime() / 1000)));
    }
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
    if (textOf(answer['url']) === undefined) {
      throw new AppError('GATEWAY_ERROR', { detail: 'The payment gateway gave no checkout address.' });
    }
    const paymentUrl = httpsUrlOf(answer['url']);
    if (paymentUrl === undefined) throw notHttps();
    return { paymentUrl };
  },

  maxChargeDecimals: chargeableDecimals,

  async verifyPayment(calls, credentials, reference, options): Promise<PaymentCheck> {
    const apiBase = credentials.apiBase ?? DEFAULT_API_BASE;
    const timeoutMs = options?.timeoutMs ?? DETAILS_TIMEOUT_MS;
    try {
      if (reference.startsWith('pi_')) {
        const answer = await gatewayCall(calls, {
          url: `${apiBase}/v1/payment_intents/${encodeURIComponent(reference)}?expand[]=latest_charge`,
          method: 'GET',
          headers: bearer(credentials),
          timeoutMs,
        });
        const charge = objectOf(answer['latest_charge']);
        const currency = textOf(answer['currency']);
        const status = textOf(answer['status']);
        const afterPayment = aftermathOf(charge);
        return {
          status: status === 'succeeded' ? 'confirmed' : 'not_confirmed',
          amount: fromMinor(answer['amount_received'], currency),
          currency: currency?.toUpperCase() ?? null,
          paidAt: unixSecondsToDate(charge?.['created']),
          belongsTo: textOf(objectOf(answer['metadata'])?.['reference']) ?? null,
          details: cardDetailsOf(charge),
          // A canceled intent is never paid any more; one that waits for the buyer or the bank still may be.
          ...(status === 'canceled' ? { ended: true } : {}),
          ...(afterPayment === undefined ? {} : { afterPayment }),
        };
      }
      const answer = await gatewayCall(calls, {
        url: `${apiBase}/v1/checkout/sessions/${encodeURIComponent(reference)}`,
        method: 'GET',
        headers: bearer(credentials),
        timeoutMs,
      });
      const currency = textOf(answer['currency']);
      return {
        // A paid session always has a payment intent, and its confirmation names that intent: a confirmation naming the session of a
        // payment intent is not the record of a payment.
        status:
          answer['payment_status'] === 'paid' && textOf(answer['payment_intent']) === undefined
            ? 'confirmed'
            : 'not_confirmed',
        amount: fromMinor(answer['amount_total'], currency),
        currency: currency?.toUpperCase() ?? null,
        paidAt: null,
        belongsTo: textOf(answer['client_reference_id']) ?? null,
        ...(answer['status'] === 'expired' ? { ended: true } : {}),
      };
    } catch (error) {
      // A payment the gateway does not know is an answer, not a failure: it is not confirmed.
      if (error instanceof GatewayRefusalError && error.gatewayStatus === 404) {
        return { status: 'not_confirmed', amount: null, currency: null, paidAt: null, belongsTo: null };
      }
      throw error;
    }
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

  async paymentDetails(calls, credentials, reference) {
    // Only a PaymentIntent has a latest Charge; a checkout without one (`cs_…`) has no card to read.
    if (!reference.startsWith('pi_')) return undefined;
    const answer = await gatewayCall(calls, {
      url: `${credentials.apiBase ?? DEFAULT_API_BASE}/v1/payment_intents/${encodeURIComponent(reference)}?expand[]=latest_charge`,
      method: 'GET',
      headers: bearer(credentials),
      timeoutMs: DETAILS_TIMEOUT_MS,
    });
    return cardDetailsOf(objectOf(answer['latest_charge']));
  },

  async refund(calls: GatewayCalls, credentials: GatewayCredentials, request: RefundRequest): Promise<RefundAnswer> {
    const form = new URLSearchParams({
      payment_intent: request.paymentReference,
      amount: minorOf(request.amount, request.currency, `Refund ${request.refundId}`),
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
    // Stripe sends no `refund.succeeded`: a result is `refund.updated` with a final status, or `refund.failed`. `refund.created` and
    // `charge.refunded` are covered by the refund call's own answer.
    const kind = refundResultOf(type, textOf(refund['status']));
    if (!kind) return undefined;
    const metadata = objectOf(refund['metadata']);
    const echoed = Number(textOf(metadata?.['refund_id']));
    const attempt = Number(textOf(metadata?.['send_attempt']));
    return {
      kind,
      gatewayRefundId,
      refundId: Number.isSafeInteger(echoed) && echoed > 0 ? echoed : null,
      sendAttempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null,
      failure: textOf(refund['failure_reason']) ?? (refund['status'] === 'canceled' ? 'canceled' : null),
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
    const status = textOf(dispute['status']);
    // A card network inquiry (`warning_needs_response`, `warning_under_review`, `warning_closed`) takes no money: nothing is recorded
    // for it. An update of a dispute that is open at the gateway opens it once (like its creation), so an inquiry that becomes a dispute is
    // recorded then.
    if (status?.startsWith('warning_')) return undefined;
    let kind: DisputeEvent['kind'] | undefined;
    if (type === 'charge.dispute.created') kind = 'created';
    else if (type === 'charge.dispute.updated' || type === 'charge.dispute.funds_withdrawn')
      kind = status === 'needs_response' || status === 'under_review' ? 'created' : undefined;
    else if (type === 'charge.dispute.closed') kind = status === 'won' ? 'won' : status === 'lost' ? 'lost' : undefined;
    if (!kind) return undefined;
    const currency = textOf(dispute['currency']);
    return {
      kind,
      reference,
      paymentReference,
      amount: fromMinor(dispute['amount'], currency),
      currency: currency ? currency.toUpperCase() : null,
      fee: fromMinor(dispute['fee'], currency),
      reasonCode: textOf(dispute['reason']) ?? 'general',
      evidenceDueAt: unixSecondsToDate(objectOf(dispute['evidence_details'])?.['due_by']),
      occurredAt: unixSecondsToDate(event['created']),
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
