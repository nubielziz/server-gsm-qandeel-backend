// The contract between billing and a payment gateway's code (decision 023): what a driver verifies, reads, asks and answers. The
// drivers live next to this file; `drivers.ts` finds one by the name in `payment_gateways.driver`.
import type { IncomingHttpHeaders } from 'node:http';
import type { JsonObject } from '../../../../common/contract';
import { AppError } from '../../../../common/errors';
import type { Money } from '../../../../common/money';
import { type HostLookup, HttpRequestError, OutboundHttp } from '../../../../infra/http';
import type { VerifiedDelivery } from '../../../identity';
import type { GatewayStatus } from '../../domain/payment-rules';
import type { TopupMethod } from '../../db/schema';

/** The credentials of a gateway, read from `config_enc` and `webhook_secret_enc` (decision 019). */
export interface GatewayCredentials {
  /** The API credential (`config_enc.secret`). */
  readonly secret: string | undefined;
  /** Where the gateway's API is (`config_enc.apiBase`), when it is not the driver's default. */
  readonly apiBase: string | undefined;
  /** The key the gateway signs its webhooks with (`webhook_secret_enc`). */
  readonly webhookSecret: string | undefined;
}

/** What a driver learned from a signed webhook, in the words of billing. */
export interface PaymentEvent {
  /** `confirmed` (paid and, for crypto, enough confirmations), `pending` (not yet) or `failed` (expired, refused). */
  readonly kind: GatewayStatus;
  /** The invoice number billing gave the gateway as its reference. */
  readonly invoiceNumber: string;
  /** The gateway's own id of the payment (`payments.gateway_txn_id`). */
  readonly reference: string;
  /** What the gateway says was paid, as a 4-decimal amount, or `null` when the event does not say. */
  readonly amount: string | null;
  /** The currency the gateway says was paid (ISO code, upper case), or `null`. */
  readonly currency: string | null;
  /** The event as received, kept on the payment for support and disputes. */
  readonly raw: JsonObject;
}

/** What a driver needs to open a checkout. */
export interface CheckoutRequest {
  readonly invoiceNumber: string;
  /** What the merchant pays (gross). */
  readonly amount: Money;
  readonly currency: string;
  /** What the checkout page shows as the thing bought. */
  readonly description: string;
  /** Where the gateway sends the merchant back to (the portal). */
  readonly returnUrl: string;
}

/** The seam that decides how gateway API calls are made (tests point it at a local server). */
export interface GatewayHttpPolicy {
  readonly lookup?: HostLookup;
  readonly allowPrivateNetwork?: boolean;
  readonly httpsOnly?: boolean;
}

/** The injection token of {@link GatewayHttpPolicy}; always injected as optional, nothing in production provides it. */
export const GATEWAY_HTTP_POLICY = Symbol.for('gsm.GATEWAY_HTTP_POLICY');

/** What a driver calls the gateway with. */
export interface GatewayCalls {
  readonly http: OutboundHttp;
  readonly policy: GatewayHttpPolicy | undefined;
}

/**
 * The code that talks to one kind of payment gateway.
 *
 * Why: P2.5c's registry keeps one verifier per gateway because every gateway signs differently; billing also needs to open a
 * checkout and to ask the gateway again before a payment credits itself (user rule 6). A driver answers all three in one place.
 */
export interface PaymentGatewayDriver {
  /** The driver's own name. */
  readonly id: string;
  /** The top-up method of the gateways it serves. */
  readonly methodType: TopupMethod;
  /** Which stored key signs its webhooks: the API secret, or the separate webhook secret (RESOLUTIONS money-14). */
  readonly signingKey: 'api_secret' | 'webhook_secret';
  /**
   * Verifies the signature of a delivery and reads its event id.
   *
   * @param delivery the headers, the raw body and the clock
   * @param key the signing key
   * @returns the event id and the signed time
   * @throws {AppError} `WEBHOOK_SIGNATURE_INVALID` for a missing, malformed or wrong signature
   */
  verify(
    delivery: { headers: IncomingHttpHeaders; rawBody: Buffer; nowSeconds: number },
    key: string,
  ): VerifiedDelivery;
  /**
   * Reads a verified event.
   *
   * @param body the parsed JSON body
   * @returns the payment event, or `undefined` for an event type billing ignores
   */
  parse(body: unknown): PaymentEvent | undefined;
  /**
   * Opens a hosted checkout for an invoice.
   *
   * @param calls the HTTP client and policy
   * @param credentials the gateway's credentials
   * @param request the invoice, the amount and the return address
   * @returns the address the merchant pays at
   * @throws {AppError} `GATEWAY_ERROR` when the gateway cannot be reached or refuses
   */
  createCheckout(
    calls: GatewayCalls,
    credentials: GatewayCredentials,
    request: CheckoutRequest,
  ): Promise<{ paymentUrl: string }>;
  /**
   * Asks the gateway what it says about a payment now.
   *
   * @param calls the HTTP client and policy
   * @param credentials the gateway's credentials
   * @param reference the gateway's id of the payment
   * @returns `confirmed`, `pending` or `failed`
   * @throws {AppError} `GATEWAY_ERROR` when the gateway cannot be reached or refuses
   */
  checkStatus(calls: GatewayCalls, credentials: GatewayCredentials, reference: string): Promise<GatewayStatus>;
}

const TIMEOUT_MS = 10_000;

/**
 * Calls a gateway's API and returns the parsed JSON answer.
 *
 * Why: decision 023: an explicit timeout, no retry, the SSRF guard. Every failure (network, timeout, a 4xx or 5xx answer, a body
 * that is not JSON) is one `502 GATEWAY_ERROR`, so nothing a gateway sends can crash a request.
 *
 * @param calls the HTTP client and policy
 * @param options the address, method, headers and body
 * @returns the JSON object the gateway answered
 * @throws {AppError} `GATEWAY_ERROR`
 */
export async function gatewayCall(
  calls: GatewayCalls,
  options: { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
): Promise<JsonObject> {
  let result;
  try {
    result = await calls.http.request({
      ...options,
      target: 'gateway',
      operation: 'payments',
      timeoutMs: TIMEOUT_MS,
      ...(calls.policy?.allowPrivateNetwork === undefined
        ? {}
        : { allowPrivateNetwork: calls.policy.allowPrivateNetwork }),
      ...(calls.policy?.httpsOnly === undefined ? {} : { httpsOnly: calls.policy.httpsOnly }),
      ...(calls.policy?.lookup === undefined ? {} : { lookup: calls.policy.lookup }),
    });
  } catch (error) {
    const kind = error instanceof HttpRequestError ? error.kind : 'network';
    throw new AppError('GATEWAY_ERROR', {
      detail: `The payment gateway could not be reached (${kind}).`,
      cause: error,
    });
  }
  if (result.status < 200 || result.status >= 300) {
    throw new AppError('GATEWAY_ERROR', { detail: `The payment gateway answered ${result.status}.` });
  }
  try {
    const parsed: unknown = result.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // falls through to the error below
  }
  throw new AppError('GATEWAY_ERROR', { detail: 'The payment gateway answered something that is not JSON.' });
}

/**
 * Reads a string field of untyped JSON.
 *
 * @param value any value from a parsed body
 * @returns the text when it is a non-empty string, otherwise `undefined`
 */
export function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads an object field of untyped JSON.
 *
 * @param value any value from a parsed body
 * @returns the object when it is a plain object, otherwise `undefined`
 */
export function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
