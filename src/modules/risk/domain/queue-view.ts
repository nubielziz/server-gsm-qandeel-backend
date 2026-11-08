// Small rules of the risk queue's wire (feature 18, GET /admin/risk/queue, RESOLUTIONS b2c-6, b2c-11, b2c-17). Pure, no database.

/** The payment methods the queue shows. */
export type QueueMethod = 'card' | 'wallet' | 'crypto';

/**
 * The method word of the queue and the refunds.
 *
 * Why: RESOLUTIONS b2c-6: `payments.method_type` holds `card`, `wallet` or `crypto` for a storefront payment; the wire helper keeps
 * `usdt` as `crypto` and anything unknown as `card`, so a damaged row never breaks the page.
 *
 * @param method `payments.method_type`, or `null` when the order has no payment row
 * @returns `card`, `wallet` or `crypto`
 */
export function queueMethodOf(method: string | null): QueueMethod {
  if (method === 'card' || method === 'wallet' || method === 'crypto') return method;
  return method === 'usdt' ? 'crypto' : 'card';
}

/**
 * The device name the queue prints for an order's IMEI.
 *
 * Why: RESOLUTIONS b2c-17: from the catalogue entry of the IMEI's first 8 digits: the marketing name and the model in brackets
 * (`Redmi Note 12 (23021RAAEG)`) when the marketing name is not empty, else the brand and the model; `null` when the order has no IMEI
 * or its TAC is not in the catalogue.
 *
 * @param entry the catalogue entry, or `undefined`
 * @returns the name, or `null`
 */
export function deviceName(entry: { brand: string; model: string; marketingName: string } | undefined): string | null {
  if (entry === undefined) return null;
  return entry.marketingName.trim() === ''
    ? `${entry.brand} ${entry.model}`.trim()
    : `${entry.marketingName} (${entry.model})`;
}

/**
 * The TAC of an order's main input, when it is an IMEI.
 *
 * @param input `orders.imei`
 * @returns the first 8 digits, or `null` when the input does not start with 8 digits
 */
export function tacOfInput(input: string | null): string | null {
  const digits = (input ?? '').replace(/[\s-]/g, '');
  return /^\d{8}/.test(digits) ? digits.slice(0, 8) : null;
}

/**
 * The share of storefront orders the rules held, in percent with one decimal.
 *
 * @param held the orders whose newest assessment says review
 * @param total the storefront orders of the same window
 * @returns for example `5.8`; `0` when there were no orders
 */
export function heldShare(held: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((held / total) * 1000) / 10;
}

/**
 * The reason a refund carries when the reviewer wrote none.
 *
 * Why: `POST /admin/risk/orders/:id/refund`: `Refunded after risk review: <first signal>` (the demo's `refundAndBlock`), or the
 * demo's `high risk score` when the assessment has no signal.
 *
 * @param signals the assessment's signals
 * @param typed the reason the reviewer typed, if any
 * @returns the reason to store
 */
export function refundReason(signals: readonly string[], typed: string | undefined): string {
  const own = typed?.trim();
  if (own) return own;
  return `Refunded after risk review: ${signals[0] ?? 'high risk score'}`;
}

/**
 * Reads an assessment's signals as plain sentences.
 *
 * @param stored the jsonb value (an array of strings by RESOLUTIONS b2c-11)
 * @returns only the string items
 */
export function signalsOf(stored: unknown): string[] {
  return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [];
}
