// The `crypto` driver: hosted crypto invoices (USDT and other coins) over a small JSON API, with webhooks signed like the card
// driver's (`t=<unix>,v1=<hmac>`, header `x-gsm-signature`). A payment counts as confirmed only once the gateway reports the
// confirmations it requires (user rule 6). Serves the gateways whose driver is `crypto` or `usdt`.
import { AppError } from '../../../../common/errors';
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

/** The header the gateway signs its webhooks in. */
export const CRYPTO_SIGNATURE_HEADER = 'x-gsm-signature';

function apiBaseOf(credentials: GatewayCredentials): string {
  if (!credentials.apiBase)
    throw new AppError('GATEWAY_ERROR', { detail: 'This payment method has no API address set.' });
  return credentials.apiBase.replace(/\/+$/, '');
}

function authHeaders(credentials: GatewayCredentials, json = false): Record<string, string> {
  if (!credentials.secret) throw new AppError('GATEWAY_ERROR', { detail: 'This payment method has no API key set.' });
  return { authorization: `Bearer ${credentials.secret}`, ...(json ? { 'content-type': 'application/json' } : {}) };
}

/** The confirmation counts of an invoice object: confirmed only when the gateway says so and the required count is reached. */
function isConfirmed(invoice: Record<string, unknown>): boolean {
  const confirmations = typeof invoice['confirmations'] === 'number' ? invoice['confirmations'] : 0;
  const required = typeof invoice['requiredConfirmations'] === 'number' ? invoice['requiredConfirmations'] : 1;
  return invoice['status'] === 'confirmed' && confirmations >= required;
}

/**
 * The crypto driver.
 *
 * Why: the demo's crypto gateway (USDT and BTC invoices with confirmation tracking). Events `invoice.confirmed`,
 * `invoice.pending` and `invoice.expired`; an `invoice.confirmed` below the required confirmations still reads as pending.
 *
 * @see docs/contract/endpoints/money.md (POST /webhooks/payments/:gateway)
 */
export const cryptoDriver: PaymentGatewayDriver = {
  id: 'crypto',
  methodType: 'usdt',
  signingKey: 'webhook_secret',

  verify(delivery, key) {
    const header = delivery.headers[CRYPTO_SIGNATURE_HEADER];
    const timestamp = assertWebhookSignature(key, typeof header === 'string' ? header : '', delivery.rawBody, {
      nowSeconds: delivery.nowSeconds,
    });
    let id: string | undefined;
    try {
      id = textOf(objectOf(JSON.parse(delivery.rawBody.toString('utf8')))?.['id']);
    } catch {
      // not JSON: refused below
    }
    if (!id) throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: 'The webhook body is not an event.' });
    return { eventId: id, timestamp };
  },

  parse(body): PaymentEvent | undefined {
    const event = objectOf(body);
    const type = textOf(event?.['type']);
    const invoice = objectOf(event?.['data']);
    if (!event || !type || !invoice) return undefined;
    const kind =
      type === 'invoice.confirmed'
        ? isConfirmed({ ...invoice, status: 'confirmed' })
          ? 'confirmed'
          : 'pending'
        : type === 'invoice.pending'
          ? 'pending'
          : type === 'invoice.expired' || type === 'invoice.failed'
            ? 'failed'
            : undefined;
    const invoiceNumber = textOf(invoice['reference']);
    const reference = textOf(invoice['id']);
    if (!kind || !invoiceNumber || !reference) return undefined;
    const amount = textOf(invoice['amount']);
    const currency = textOf(invoice['currency']);
    return {
      kind,
      invoiceNumber,
      reference,
      amount: amount && /^\d+(\.\d{1,4})?$/.test(amount) ? amount : null,
      currency: currency ? currency.toUpperCase() : null,
      raw: event as PaymentEvent['raw'],
    };
  },

  async createCheckout(calls: GatewayCalls, credentials: GatewayCredentials, request: CheckoutRequest) {
    const answer = await gatewayCall(calls, {
      url: `${apiBaseOf(credentials)}/v1/invoices`,
      method: 'POST',
      headers: authHeaders(credentials, true),
      body: JSON.stringify({
        reference: request.invoiceNumber,
        amount: request.amount.toWire(),
        currency: request.currency,
        description: request.description,
        returnUrl: request.returnUrl,
      }),
    });
    const paymentUrl = textOf(answer['url']);
    if (!paymentUrl) throw new AppError('GATEWAY_ERROR', { detail: 'The payment gateway gave no checkout address.' });
    return { paymentUrl };
  },

  async checkStatus(calls, credentials, reference) {
    const answer = await gatewayCall(calls, {
      url: `${apiBaseOf(credentials)}/v1/invoices/${encodeURIComponent(reference)}`,
      method: 'GET',
      headers: authHeaders(credentials),
    });
    if (isConfirmed(answer)) return 'confirmed';
    return answer['status'] === 'expired' || answer['status'] === 'failed' ? 'failed' : 'pending';
  },
};
