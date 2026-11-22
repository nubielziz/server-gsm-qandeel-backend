// The contract between billing and a payment gateway's code (decision 023): what a driver verifies, reads, asks and answers. The
// drivers live next to this file; `drivers.ts` finds one by the name in `payment_gateways.driver`.
import type { IncomingHttpHeaders } from 'node:http';
import type { JsonObject } from '../../../../common/contract';
import { AppError } from '../../../../common/errors';
import type { Money } from '../../../../common/money';
import { type HostLookup, HttpRequestError, OutboundHttp } from '../../../../infra/http';
import type { VerifiedDelivery } from '../../../identity';
import type { GatewayStatus, PaymentAftermath } from '../../domain/payment-rules';
import type { TopupMethod } from '../../db/schema';

/** The credentials of a gateway, read from `config_enc` and `webhook_secret_enc` (decision 019). */
export interface GatewayCredentials {
  /** The API credential (`config_enc.secret`). */
  readonly secret: string | undefined;
  /** Where the gateway's API is (`config_enc.apiBase`), when it is not the driver's default. */
  readonly apiBase: string | undefined;
  /** The first key the gateway signs its webhooks with (`webhook_secret_enc`): `webhookSecrets[0]`. */
  readonly webhookSecret: string | undefined;
  /**
   * Every stored webhook signing key, at most two (feature 24C): a second endpoint at the gateway, or the new key while rotating. A
   * delivery is accepted when any of them verifies it.
   */
  readonly webhookSecrets: readonly string[];
}

/** What a driver read about how a storefront payment was made (never card data: a brand, the last digits, a fingerprint). */
export interface PaymentDetails {
  /** The card brand (`visa`), or the wallet's name when `wallet` is set. */
  readonly brand?: string | undefined;
  readonly last4?: string | undefined;
  /** The gateway's card fingerprint, kept for the blocklist (RESOLUTIONS b2c-5). */
  readonly fingerprint?: string | undefined;
  /** True when the cardholder passed 3-D Secure. */
  readonly threeDs?: boolean | undefined;
  /** The wallet's name (`apple_pay`) when the customer paid with one: the payment then counts as `wallet`. */
  readonly wallet?: string | undefined;
  /** The coin and network of a crypto payment (`usdt`, `TRC-20`). */
  readonly coin?: string | undefined;
  readonly network?: string | undefined;
  /**
   * True when the driver could not read the card details from the gateway (the call failed or timed out): a storefront payment then gets a
   * risk signal and a card top-up waits for staff review (plan 24C § 2.4).
   */
  readonly unavailable?: boolean | undefined;
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
  /** How a storefront payment was made, when the event says (feature 16). */
  readonly details?: PaymentDetails | undefined;
  /** When the gateway made the event: its own signed time (decision 048); `null` when the event does not say. */
  readonly occurredAt?: Date | null | undefined;
}

/**
 * What the gateway's own record of a payment says, read back before a storefront capture (decision 048).
 *
 * Why: a signed event names a payment; the record the gateway keeps says whether the money arrived, how much, in which currency and for
 * which checkout. The capture uses the record, never the event alone.
 */
export interface PaymentCheck {
  /**
   * `confirmed`: the gateway holds the money; `not_confirmed`: it answered and does not say paid, or does not know the payment;
   * `unverified`: set by billing only, when the record could not be read for 24 hours (never by a driver).
   */
  readonly status: 'confirmed' | 'not_confirmed' | 'unverified';
  /** What the gateway collected, as a 4-decimal amount, or `null` when the record does not say. */
  readonly amount: string | null;
  /** The currency collected (ISO code, upper case), or `null`. */
  readonly currency: string | null;
  /** When the payment itself was made (the gateway's time), or `null` when the record does not say. */
  readonly paidAt: Date | null;
  /** The reference billing gave the gateway when it opened the page, as the gateway's record states it; `null` when it does not say. */
  readonly belongsTo: string | null;
  /** How the payment was made (the card of a card payment, the coin of a crypto one). */
  readonly details?: PaymentDetails | undefined;
  /**
   * True when the record says the payment ended without being paid (a canceled payment, an expired page): it will not be paid any more.
   * Absent when it may still be paid or the driver does not say.
   */
  readonly ended?: boolean | undefined;
  /**
   * What the record shows happened to the money after the payment (decision 048): refunded in full or in part, or disputed. Absent when
   * nothing did or the driver does not say.
   */
  readonly afterPayment?: PaymentAftermath | undefined;
}

/**
 * How a read of the gateway's record of a payment is made.
 *
 * Why: decision 048: the storefront webhook waits for the read, so it uses the short {@link DETAILS_TIMEOUT_MS}; the automatic credit of a
 * top-up is a job nobody waits on, so it gives the read the time of any other gateway call ({@link GATEWAY_CALL_TIMEOUT_MS}).
 */
export interface VerifyOptions {
  /** The limit of the call in milliseconds; {@link DETAILS_TIMEOUT_MS} when absent. */
  readonly timeoutMs?: number | undefined;
}

/** What a driver needs to open a checkout. */
export interface CheckoutRequest {
  readonly invoiceNumber: string;
  /** What the merchant pays (gross). */
  readonly amount: Money;
  readonly currency: string;
  /** What the checkout page shows as the thing bought. */
  readonly description: string;
  /** Where the gateway sends the buyer back to (the portal for a merchant, the shop for a customer). */
  readonly returnUrl: string;
  /** Ask the cardholder for 3-D Secure (a storefront card payment whose gateway supports it). */
  readonly require3ds?: boolean | undefined;
  /** When the hosted page must close (decision 048); a driver without that notion ignores it. */
  readonly expiresAt?: Date | undefined;
  /** A stable key (the payment's reference): a repeat of the same call never opens a second hosted page (scenario b2c-paid step 4). */
  readonly idempotencyKey?: string | undefined;
}

/** What a driver needs to refund a storefront payment. */
export interface RefundRequest {
  /** The gateway's id of the payment being refunded (`payments.gateway_txn_id`). */
  readonly paymentReference: string;
  /** What goes back, in the payment currency. */
  readonly amount: Money;
  readonly currency: string;
  /** Our refund id, sent as metadata so the gateway's own answer finds the refund again. */
  readonly refundId: number;
  /** A stable key (`refund-<id>`, or `refund-<id>-<n>` after the gateway refused the refund for good): a retry of the same send never refunds twice. */
  readonly idempotencyKey: string;
  /** `refunds.send_attempt` of this send, sent as metadata so a late event of an earlier gateway refund is told from the current one. */
  readonly sendAttempt: number;
}

/** What the gateway answered to a refund. */
export interface RefundAnswer {
  readonly gatewayRefundId: string;
  /** `succeeded` is final; `pending` waits for the gateway's `refund.updated` (with the refund's final status) or `refund.failed` event. */
  readonly status: 'succeeded' | 'pending' | 'failed';
  /** The gateway's reason when it refused. */
  readonly failure: string | null;
}

/** A refund result the gateway sent as an event. */
export interface RefundEvent {
  readonly kind: 'succeeded' | 'failed';
  readonly gatewayRefundId: string;
  /** Our refund id from the metadata, when the gateway echoed it. */
  readonly refundId: number | null;
  /** The send attempt from the metadata, when the gateway echoed it (`null` for an event that does not say). */
  readonly sendAttempt: number | null;
  readonly failure: string | null;
  readonly raw: JsonObject;
}

/** A dispute event the gateway sent. */
export interface DisputeEvent {
  /** `created` opens the dispute; `won` and `lost` close it. */
  readonly kind: 'created' | 'won' | 'lost';
  /** The gateway's id of the dispute. */
  readonly reference: string;
  /** The gateway's id of the payment disputed (`payments.gateway_txn_id`). */
  readonly paymentReference: string;
  /** The disputed amount in the payment's currency (4 decimals), or `null` when the event does not say. */
  readonly amount: string | null;
  readonly currency: string | null;
  /** The dispute fee in the same currency, or `null`. */
  readonly fee: string | null;
  readonly reasonCode: string;
  /** When the evidence must be in, or `null`. */
  readonly evidenceDueAt: Date | null;
  /** When the gateway made the event: its own signed time (decision 048); `null` when the event does not say. */
  readonly occurredAt?: Date | null | undefined;
  readonly raw: JsonObject;
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
  /**
   * Reads how a confirmed payment was made (absent when the event itself says, as for crypto).
   *
   * Why: plan 24C § 2.4: a Stripe checkout event does not carry the card; the payment's latest Charge does. Billing calls this before the
   * capture transaction, with a short timeout.
   *
   * @param calls the HTTP client and policy
   * @param credentials the gateway's credentials
   * @param reference the gateway's id of the payment (`payments.gateway_txn_id`)
   * @returns the card's brand, last digits, fingerprint, 3-D Secure and wallet, or `undefined` when the payment has no card to read
   * @throws {AppError} `GATEWAY_ERROR` when the gateway cannot be reached, refuses or is too slow
   */
  paymentDetails?(
    calls: GatewayCalls,
    credentials: GatewayCredentials,
    reference: string,
  ): Promise<PaymentDetails | undefined>;
  /**
   * Reads the gateway's own record of a payment: whether it was paid, how much, in which currency, when, for which checkout, how, and what
   * happened to the money since.
   *
   * Why: decision 048: a storefront capture is verified with the gateway before the order is created (the webhook calls this before its
   * transaction, with the short {@link DETAILS_TIMEOUT_MS}), and the automatic credit of a card top-up reads the same record before it
   * credits (with {@link GATEWAY_CALL_TIMEOUT_MS}, the time of the status check it replaced).
   *
   * @param calls the HTTP client and policy
   * @param credentials the gateway's credentials
   * @param reference the gateway's id of the payment, as the confirmation names it
   * @param options the limit of the call (default {@link DETAILS_TIMEOUT_MS})
   * @returns what the record says; a payment the gateway does not know (404) is `not_confirmed`
   * @throws {AppError} `GATEWAY_ERROR` when the gateway cannot be asked (network, timeout, any other refusal or error answer)
   */
  verifyPayment?(
    calls: GatewayCalls,
    credentials: GatewayCredentials,
    reference: string,
    options?: VerifyOptions,
  ): Promise<PaymentCheck>;
  /**
   * The most significant decimals an amount may have to be charged exactly in a currency (absent: any).
   *
   * Why: decision 048: an amount the method cannot charge exactly is refused before a page opens, and a currency's decimals may not exceed
   * what an active storefront method charges exactly.
   *
   * @param currency the ISO code, any case
   * @returns the number of decimals
   */
  maxChargeDecimals?(currency: string): number;
  /**
   * Refunds a storefront payment (absent when the gateway cannot: the refund is then paid out by hand).
   *
   * @param calls the HTTP client and policy
   * @param credentials the gateway's credentials
   * @param request the payment, the amount and the idempotency key
   * @returns the gateway's answer
   * @throws {AppError} `GATEWAY_ERROR` when the gateway cannot be reached or answers an error
   */
  refund?(calls: GatewayCalls, credentials: GatewayCredentials, request: RefundRequest): Promise<RefundAnswer>;
  /**
   * Reads a verified refund result event.
   *
   * @param body the parsed JSON body
   * @returns the refund event, or `undefined` for any other event
   */
  parseRefund?(body: unknown): RefundEvent | undefined;
  /**
   * Reads a verified dispute event.
   *
   * @param body the parsed JSON body
   * @returns the dispute event, or `undefined` for any other event
   */
  parseDispute?(body: unknown): DisputeEvent | undefined;
  /**
   * Sends the evidence of a dispute to the gateway.
   *
   * @param calls the HTTP client and policy
   * @param credentials the gateway's credentials
   * @param request the gateway's dispute id and the evidence text
   * @throws {AppError} `GATEWAY_ERROR` when the gateway cannot be reached or refuses
   */
  submitEvidence?(
    calls: GatewayCalls,
    credentials: GatewayCredentials,
    request: { disputeReference: string; text: string },
  ): Promise<void>;
}

/** The timeout of a gateway call nobody waits on (decision 023): a job's read, a refund, a status check, a checkout page. */
export const GATEWAY_CALL_TIMEOUT_MS = 10_000;
/** The timeout of a read the webhook waits for (the card details of a confirmation, plan 24C § 2.4). */
export const DETAILS_TIMEOUT_MS = 3_000;

/** The 4xx answers that say "not now", not "no": a timeout, a conflict with a request in flight, "too early" and a rate limit. */
const TRANSIENT_4XX: ReadonlySet<number> = new Set([408, 409, 425, 429]);

/**
 * A gateway that refused a call for good: it answered 4xx (not a timeout, a conflict or a rate limit).
 *
 * Why: a refund call that is refused for good must not be retried by the queue, and the same idempotency key would only bring the same
 * refusal back, so the refund sender tells this from a timeout or a 5xx (after which the gateway may have acted). It is still the one
 * `502 GATEWAY_ERROR` to everything else that catches an `AppError`.
 */
export class GatewayRefusalError extends AppError {
  /**
   * @param gatewayStatus the HTTP status the gateway answered
   */
  constructor(readonly gatewayStatus: number) {
    super('GATEWAY_ERROR', { detail: `The payment gateway answered ${gatewayStatus}.` });
    this.name = 'GatewayRefusalError';
  }
}

/**
 * Calls a gateway's API and returns the parsed JSON answer.
 *
 * Why: decision 023: an explicit timeout, no retry, the SSRF guard. Every failure (network, timeout, a 4xx or 5xx answer, a body
 * that is not JSON) is one `502 GATEWAY_ERROR`, so nothing a gateway sends can crash a request. A 4xx that is not a timeout, a
 * conflict or a rate limit is the {@link GatewayRefusalError} kind of it, so a caller can tell a refusal from an answer it does not know.
 *
 * @param calls the HTTP client and policy
 * @param options the address, method, headers and body, and a shorter timeout than the default 10 seconds when the caller waits
 * @returns the JSON object the gateway answered
 * @throws {AppError} `GATEWAY_ERROR`; a {@link GatewayRefusalError} for a 4xx refusal
 */
export async function gatewayCall(
  calls: GatewayCalls,
  options: { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<JsonObject> {
  const { timeoutMs, ...request } = options;
  let result;
  try {
    result = await calls.http.request({
      ...request,
      target: 'gateway',
      operation: 'payments',
      timeoutMs: timeoutMs ?? GATEWAY_CALL_TIMEOUT_MS,
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
  if (result.status >= 400 && result.status < 500 && !TRANSIENT_4XX.has(result.status)) {
    throw new GatewayRefusalError(result.status);
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
 * Reads an https address a gateway gave.
 *
 * Why: decision 048: the checkout address a gateway answers is where the buyer is sent; only an absolute https address with a host and
 * without a user name, a password, whitespace or control characters is used.
 *
 * @param value any value from a parsed body
 * @returns the text when it is such an address, otherwise `undefined`
 */
export function httpsUrlOf(value: unknown): string | undefined {
  const text = textOf(value);
  // Whitespace and control characters (U+0000 to U+0020, U+007F) never belong in an address handed to a browser.
  if (text === undefined || [...text].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return undefined;
  return text;
}

/**
 * The refusal of a checkout address that is not an https address.
 *
 * Why: decision 048: every caller of `createCheckout` already marks its payment failed or voids its invoice on a `GATEWAY_ERROR`.
 *
 * @returns the `502 GATEWAY_ERROR` to throw
 */
export function notHttps(): AppError {
  return new AppError('GATEWAY_ERROR', {
    detail: 'The payment gateway gave a checkout address that is not an https address.',
  });
}

/**
 * Reads a time a gateway gave in unix seconds.
 *
 * @param value any value from a parsed body
 * @returns the date for a finite number of seconds, otherwise `null`
 */
export function unixSecondsToDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null;
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
