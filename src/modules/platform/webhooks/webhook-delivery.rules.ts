// Pure rules of the outgoing merchant webhooks (decisions 019, 020, 023; ALIGNMENT § 7): the events, the retry schedule, how
// the envelope and the event id are made, and how a delivery answer is kept. No I/O, so the rules are unit-tested.
import type { OutboxPayload } from '../outbox/outbox.types';

/**
 * The events a merchant can subscribe an endpoint to.
 *
 * Why: B156 and the map's events (`order.status_changed`, `wallet.low_balance`, `invoice.paid`) plus `service.price_changed`
 * (user rule 9, MISMATCHES B117): the four documented in the public OpenAPI `webhooks`.
 */
export const WEBHOOK_EVENT_NAMES = [
  'order.status_changed',
  'wallet.low_balance',
  'invoice.paid',
  'service.price_changed',
] as const;

/** One value of {@link WEBHOOK_EVENT_NAMES}. */
export type WebhookEventName = (typeof WEBHOOK_EVENT_NAMES)[number];

/**
 * The event of the test delivery (`POST /client/webhooks/:id/test`).
 *
 * Why: B156: a merchant checks its receiver and its signature check with a signed event that is not one of the four, so it
 * cannot be mistaken for real data. It is not subscribable and not part of the public event list.
 */
export const PING_EVENT = 'ping';

/** A merchant may register at most this many endpoints (B156). */
export const MAX_ENDPOINTS_PER_MERCHANT = 5;
/** Attempts per delivery, the first one included: 8 over about 21 hours (ALIGNMENT § 7, docs/queues.md). */
export const WEBHOOK_MAX_ATTEMPTS = 8;
/** The wait after the first failed attempt; each next wait doubles (10 min, 20, 40, 80, 160, 320, 640). */
export const WEBHOOK_RETRY_BASE_MS = 10 * 60_000;
/** Each wait is shortened by up to this share at random, so the retries of many deliveries do not arrive together. */
export const WEBHOOK_RETRY_JITTER = 0.2;
/** How long the merchant's server has to answer. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** The merchant's answer is read up to this many bytes; the rest is dropped. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
/** `webhook_deliveries.response_body` keeps this many characters (B75: a few kilobytes). */
export const WEBHOOK_RESPONSE_BODY_LIMIT = 4096;
/** `webhook_deliveries.error` keeps this many characters. */
export const WEBHOOK_ERROR_LIMIT = 500;

/**
 * Tells whether text is one of the four subscribable events.
 *
 * @param value the text to check
 * @returns true for `order.status_changed`, `wallet.low_balance`, `invoice.paid` and `service.price_changed`
 */
export function isWebhookEvent(value: string): value is WebhookEventName {
  return (WEBHOOK_EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * The wait before the next attempt, after attempt `failedAttempt` failed.
 *
 * Why: exponential backoff with jitter (decision 020): `10 min x 2^(attempt - 1)`, shortened by up to 20 %. The seven waits add
 * up to about 21 hours without the jitter, matching the public rule "8 attempts over about 24 h".
 *
 * @param failedAttempt the number of the attempt that failed (1 for the first)
 * @param random a number from 0 up to but not including 1 (`Math.random()`); tests pass fixed values
 * @returns the wait in milliseconds
 * @throws {RangeError} when `failedAttempt` is not a whole number from 1
 */
export function retryDelayMs(failedAttempt: number, random: number): number {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) {
    throw new RangeError(`An attempt number is a whole number from 1, got ${failedAttempt}.`);
  }
  const longest = WEBHOOK_RETRY_BASE_MS * 2 ** (failedAttempt - 1);
  return Math.round(longest * (1 - WEBHOOK_RETRY_JITTER * random));
}

/** What to do after an attempt failed. */
export type NextStep =
  { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number } | { readonly kind: 'give_up' };

/**
 * Decides what follows a failed attempt.
 *
 * Why: attempts 1 to 7 are followed by a retry; the eighth is the last, and so is any attempt past it (a manual retry is one
 * more try, not a new ladder). A refusal that cannot change (the address is blocked by the SSRF guard) is not retried.
 *
 * @param failedAttempt the number of the attempt that failed
 * @param permanent true when retrying cannot help
 * @param random a number from 0 up to but not including 1 for the jitter
 * @returns the next attempt and its wait, or `give_up`
 */
export function nextStep(failedAttempt: number, permanent: boolean, random: number): NextStep {
  if (permanent || failedAttempt >= WEBHOOK_MAX_ATTEMPTS) return { kind: 'give_up' };
  return { kind: 'retry', attempt: failedAttempt + 1, delayMs: retryDelayMs(failedAttempt, random) };
}

/**
 * Cuts text to a number of characters.
 *
 * @param text the text
 * @param limit the most characters to keep (at least 2)
 * @returns the text, or its start with a closing ellipsis when it is longer
 */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Turns the merchant's answer body into text that can be stored.
 *
 * Why: B75 keeps the body for support. The body comes from a stranger's server: Postgres refuses `\u0000` in text and a body can
 * be binary, so the bytes are decoded leniently, NUL characters are dropped and the text is cut to a few kilobytes.
 *
 * @param bytes the body as read (at most {@link WEBHOOK_MAX_RESPONSE_BYTES})
 * @returns the text to store; `null` for an empty body
 */
export function storableBody(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;
  const text = new TextDecoder().decode(bytes.subarray(0, WEBHOOK_RESPONSE_BODY_LIMIT * 4)).replaceAll('\u0000', '');
  return truncate(text, WEBHOOK_RESPONSE_BODY_LIMIT);
}

/** The body of a delivery as the merchant receives it (ALIGNMENT § 7). */
export interface WebhookEnvelope {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly data: Record<string, unknown>;
}

/**
 * Builds the envelope of an event.
 *
 * @param id the event id (`evt_...`)
 * @param type the event type
 * @param createdAt when the event happened
 * @param data the public fields of the event
 * @returns `{ id, type, createdAt, data }`
 */
export function buildEnvelope(
  id: string,
  type: string,
  createdAt: Date,
  data: Record<string, unknown>,
): WebhookEnvelope {
  return { id, type, createdAt: createdAt.toISOString(), data };
}

/**
 * The text an event is identified by, before it is hashed into its id.
 *
 * Why: one occurrence reaches an endpoint once, whatever repeats the work (a retried fan-out job, a second scan): the unique
 * `(endpoint_id, event_id)` turns a repeat into a no-op. Most events are one outbox row. A price change is detected by a scan that
 * can see the same change again, so it is identified by what changed.
 *
 * @param type the event type
 * @param outboxEventId the id of the outbox row
 * @param payload the ids the outbox row carries
 * @returns the key to hash
 */
export function eventKeyOf(type: string, outboxEventId: number, payload: OutboxPayload): string {
  if (type === 'service.price_changed') {
    return [type, payload['clientId'], payload['serviceId'], payload['previousPrice'], payload['price']].join(':');
  }
  return `${type}:${outboxEventId}`;
}

/**
 * Makes the event id from a keyed hash.
 *
 * Why: an id built from the outbox row number would tell a merchant how many events the whole system has produced; the keyed
 * hash is stable (the same event always has the same id) and says nothing.
 *
 * @param hash a keyed hash in hex (`TokenService.hash`)
 * @returns `evt_` and the first 24 characters of the hash
 */
export function eventIdOf(hash: string): string {
  return `evt_${hash.slice(0, 24)}`;
}

/**
 * The status of a delivery as the merchant portal names it.
 *
 * Why: B156 words the portal's list `pending`, `succeeded`, `failed`; the console's log and the table say `delivered`.
 *
 * @param status the stored status
 * @returns the portal's word
 */
export function portalStatusOf(status: 'pending' | 'delivered' | 'failed'): 'pending' | 'succeeded' | 'failed' {
  return status === 'delivered' ? 'succeeded' : status;
}
