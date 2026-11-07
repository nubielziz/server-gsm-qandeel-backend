// The rule of the `wallet.low_balance` event (feature 7b): when a posting takes a wallet under the merchant's alert threshold. Pure
// functions on Money, so the rule is unit-tested.
import { Money } from '../../../common/money';

/** The key of the merchant's threshold inside `clients.notification_prefs`: a money string such as `"50.0000"`. */
export const LOW_BALANCE_THRESHOLD_KEY = 'lowBalanceThreshold';

const THRESHOLD = /^\d{1,14}(\.\d{1,4})?$/;

/**
 * Reads the merchant's threshold from its notification preferences.
 *
 * Why: the map says the event fires when "the available balance fell below the alert threshold" and names no field for it, so the
 * threshold lives in the merchant's own preferences (`notification_prefs.lowBalanceThreshold`, a money string; the portal's
 * notification preferences of feature 12a are where a merchant sets it). A missing, zero or malformed value means no alert.
 *
 * @param prefs the `clients.notification_prefs` object
 * @returns the threshold, or `undefined` when the merchant has none
 */
export function thresholdFrom(prefs: Readonly<Record<string, unknown>> | null | undefined): Money | undefined {
  const raw = prefs?.[LOW_BALANCE_THRESHOLD_KEY];
  if (typeof raw !== 'string' || !THRESHOLD.test(raw.trim())) return undefined;
  const threshold = Money.of(raw.trim());
  return threshold.isPositive() ? threshold : undefined;
}

/**
 * The balance a merchant can still spend: the wallet balance plus its credit limit.
 *
 * Why: ANSWERS money Q2: `available = balance + creditLimit`, the "available balance" of Dhru `accountinfo` and of this event.
 *
 * @param balance the wallet balance in the merchant's sign (negative while credit is used)
 * @param overdraftLimit the credit limit
 * @returns the available balance
 */
export function availableOf(balance: Money, overdraftLimit: Money): Money {
  return balance.add(overdraftLimit);
}

/**
 * Tells whether a posting took the available balance under the threshold: it was at or above the threshold and is now below.
 *
 * Why: the event is sent once per crossing, not once per posting. A wallet that stays under the threshold sends nothing more
 * until a top-up lifts it back to the threshold or above and a later posting takes it under again; the check compares the
 * balance before and after the one posting, so it needs no stored flag.
 *
 * @param before the available balance before the posting
 * @param after the available balance after the posting
 * @param threshold the merchant's threshold
 * @returns true for a crossing from at-or-above to below
 */
export function crossedBelow(before: Money, after: Money, threshold: Money): boolean {
  return before.cmp(threshold) >= 0 && after.cmp(threshold) < 0;
}
