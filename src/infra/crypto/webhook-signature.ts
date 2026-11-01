// Webhook signatures (decision 019): `t=<unix>,v1=<hex>` where v1 = HMAC-SHA256(secret, "<t>.<body>"). Outgoing merchant
// webhooks are signed with it (header X-GSM-Signature); incoming gateway webhooks that use the same scheme are verified
// with a 5-minute window. Pure functions.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../common/errors';

/**
 * Name of the header that carries the signature of an outgoing webhook.
 *
 * Why: the public API document lists it with the delivery envelope (decision 019, map events).
 */
export const WEBHOOK_SIGNATURE_HEADER = 'X-GSM-Signature';

/**
 * How far the signed timestamp may be from the clock of the verifier: 5 minutes.
 *
 * Why: decision 019 rejects old deliveries so a captured request cannot be replayed later.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const MAX_HEADER_LENGTH = 1024;
const SIGNATURE_HEX = /^[0-9a-f]{64}$/i;

/**
 * Why a signature was refused.
 *
 * Why: tests and logs tell the cases apart; the HTTP answer for all of them is the same `WEBHOOK_SIGNATURE_INVALID`.
 */
export type WebhookRefusal = 'malformed' | 'mismatch' | 'outside_window';

/**
 * The result of verifying a signature.
 *
 * Why: callers branch on it (log the reason, answer 400) without a try/catch.
 */
export type WebhookVerification =
  { readonly valid: true; readonly timestamp: number } | { readonly valid: false; readonly reason: WebhookRefusal };

/** Options of {@link verifyWebhookSignature}. */
export interface WebhookVerifyOptions {
  /** Window in seconds; default {@link WEBHOOK_TOLERANCE_SECONDS}. */
  readonly toleranceSeconds?: number;
  /** The current time in unix seconds, from the injected clock (decision 031): the verifier never reads the wall clock itself. */
  readonly nowSeconds: number;
}

function digest(secret: string, timestamp: number, body: string | Uint8Array): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
}

/**
 * Signs a webhook body.
 *
 * Why: a merchant verifies that a delivery really comes from us and was not replayed (decision 019). The timestamp is
 * part of the signed text, so it cannot be changed without invalidating the signature.
 *
 * @param secret the endpoint secret (`webhook_endpoints.secret`)
 * @param timestamp unix time in seconds when the delivery is sent
 * @param body the exact bytes of the request body
 * @returns the header value `t=<unix>,v1=<hex>`
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
export function signWebhook(secret: string, timestamp: number, body: string | Uint8Array): string {
  return `t=${timestamp},v1=${digest(secret, timestamp, body).toString('hex')}`;
}

/**
 * Parses the header into its timestamp and its `v1` signatures (several are allowed while a secret is rotated).
 *
 * @returns `undefined` when the header is not in the scheme
 */
function parseHeader(header: string): { timestamp: number; signatures: Buffer[] } | undefined {
  if (header.length === 0 || header.length > MAX_HEADER_LENGTH) return undefined;
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const raw of header.split(',')) {
    const part = raw.trim();
    const equals = part.indexOf('=');
    if (equals < 1) return undefined;
    const name = part.slice(0, equals);
    const value = part.slice(equals + 1);
    if (name === 't') {
      if (timestamp !== undefined || !/^\d{1,12}$/.test(value)) return undefined;
      timestamp = Number(value);
    } else if (name === 'v1') {
      if (!SIGNATURE_HEX.test(value)) return undefined;
      signatures.push(Buffer.from(value, 'hex'));
    }
    // Other schemes (`v2=`, ...) are ignored so the header can grow without breaking old verifiers.
  }
  return timestamp === undefined || signatures.length === 0 ? undefined : { timestamp, signatures };
}

/**
 * Verifies a signature header against a body.
 *
 * Why: decision 019: incoming webhooks are rejected when the signature does not match or the timestamp is outside the
 * window. The comparison is constant-time; the signature is checked before the window so an attacker learns nothing about
 * timestamps without a valid signature.
 *
 * @param secret the shared secret
 * @param header the `X-GSM-Signature` value
 * @param body the exact bytes of the request body (not a re-serialised object)
 * @param options window and clock
 * @returns `{ valid: true, timestamp }`, or `{ valid: false, reason }`
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string | Uint8Array,
  options: WebhookVerifyOptions,
): WebhookVerification {
  const parsed = parseHeader(header);
  if (!parsed) return { valid: false, reason: 'malformed' };
  const expected = digest(secret, parsed.timestamp, body);
  if (!parsed.signatures.some((signature) => timingSafeEqual(signature, expected))) {
    return { valid: false, reason: 'mismatch' };
  }
  const now = options.nowSeconds;
  if (Math.abs(now - parsed.timestamp) > (options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
    return { valid: false, reason: 'outside_window' };
  }
  return { valid: true, timestamp: parsed.timestamp };
}

const REFUSAL_DETAIL: Record<WebhookRefusal, string> = {
  malformed: 'The signature header is missing or not in the expected format.',
  mismatch: 'The signature does not match the request body.',
  outside_window: 'The signature timestamp is too far from the current time.',
};

/**
 * Verifies a signature and throws `400 WEBHOOK_SIGNATURE_INVALID` when it is refused.
 *
 * Why: the incoming webhook guards (P2.5) refuse in one line with the catalog code.
 *
 * @param secret the shared secret
 * @param header the signature header value
 * @param body the exact request body
 * @param options window and clock
 * @returns the signed timestamp
 * @throws {AppError} `WEBHOOK_SIGNATURE_INVALID`
 */
export function assertWebhookSignature(
  secret: string,
  header: string,
  body: string | Uint8Array,
  options: WebhookVerifyOptions,
): number {
  const result = verifyWebhookSignature(secret, header, body, options);
  if (!result.valid) throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: REFUSAL_DETAIL[result.reason] });
  return result.timestamp;
}
