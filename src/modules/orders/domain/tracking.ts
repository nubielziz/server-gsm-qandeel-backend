// What a buyer may see of an order on the tracking page (feature 14a, map `GET /store/v1/orders/:token`): the words of the public
// timeline and the mask of the main input. Pure; no database.
import type { OrderEventType } from '../db/schema';

/**
 * The timeline lines a buyer sees, in the shop's words.
 *
 * Why: the staff timeline holds supplier hand-offs, risk reviews, internal notes, the settlement with its cost and the merchant
 * wording ("$3.31 held from Phone Doctor FZE wallet"): none of it is for a buyer (ORDERS RULES: internal notes must never reach
 * `/store/v1`). Only the types below are shown, each with fixed words, so no stored text can leak through `data.message`.
 */
export const TRACKING_EVENT_WORDS = {
  created: 'Order received',
  paid: 'Payment received',
  accepted: 'Your order is being worked on',
  completed: 'Completed',
  rejected: 'We could not complete this order',
  refund: 'Refunded',
  reopened: 'Being checked again',
} as const satisfies Partial<Record<OrderEventType, string>>;

/** The event types shown on the tracking page. */
export const TRACKING_EVENT_TYPES = Object.keys(TRACKING_EVENT_WORDS) as Array<keyof typeof TRACKING_EVENT_WORDS>;

/**
 * Hides the main input of an order except its last four characters.
 *
 * Why: the tracking link can be forwarded or shown on a shared screen; the buyer recognises their own phone by the end of the IMEI.
 *
 * @param input the order's main input (an IMEI, a username, a serial), `null` or empty when it has none
 * @returns the bullets and the last four characters (all bullets when four or fewer), `null` when there is no input
 */
export function maskInput(input: string | null): string | null {
  const text = input?.trim() ?? '';
  if (text === '') return null;
  if (text.length <= 4) return '•'.repeat(text.length);
  return `${'•'.repeat(text.length - 4)}${text.slice(-4)}`;
}
