// Currency rules without a database (resolution money-13, ANSWERS settings Q7): validation of a currency's fields, the
// stale test, the wire form of a rate and the exchange-rate guards of decision 049 (the refresh bound and the age the shop accepts).
import { Decimal } from 'decimal.js';
import type { FieldError } from '../../../common/errors';
import { BASE_CURRENCY } from './accounts';

// Rates keep up to 18 significant digits; multiplied by a percent they need more than the default precision of 20.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** A rate older than this (non-base currency) is stale: the panel and the dashboard's `fx_stale` item agree (M166). */
export const FX_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Tells whether a currency's rate is stale.
 *
 * Why: resolution money-13: `isStale` = a non-base currency whose `rate_updated_at` is older than 24 h (the column is never
 * null); a rate a refresh held is stale until staff confirm one (decision 049).
 *
 * @param code the currency code
 * @param rateUpdatedAtMs when the rate last changed, epoch milliseconds
 * @param nowMs the clock's time, epoch milliseconds
 * @param heldAtMs when a refresh held the provider's rate (`rate_held_at`), epoch milliseconds; `null` while not held
 * @returns true for a non-base currency older than 24 hours or held
 */
export function isRateStale(
  code: string,
  rateUpdatedAtMs: number,
  nowMs: number,
  heldAtMs: number | null = null,
): boolean {
  return code !== BASE_CURRENCY && (heldAtMs !== null || nowMs - rateUpdatedAtMs > FX_STALE_AFTER_MS);
}

/**
 * Writes a stored rate for the wire: trailing zeros trimmed down to four fraction digits.
 *
 * Why: the rate column keeps eight digits (decision 011) but the console's mock and money.md show `0.7900`; a rate with
 * more significant digits keeps them (`150.12345678`).
 *
 * @param stored the numeric text from Postgres (`0.79000000`)
 * @returns the decimal string with at least four and at most eight fraction digits
 */
export function formatRate(stored: string): string {
  const [whole = '0', fraction = ''] = stored.split('.');
  const trimmed = fraction.replace(/0+$/, '').padEnd(4, '0');
  return `${whole}.${trimmed}`;
}

/** Exact bounds the currency fields are validated against. */
export const CURRENCY_LIMITS = {
  markupMax: 10,
  decimalsMin: 0,
  decimalsMax: 4,
  rateFractionDigits: 8,
  rateIntegerDigits: 10,
};

const RATE_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Checks a rate typed as text.
 *
 * Why: money.md: "rateToBase > 0"; the typed text may have any number of places ('0.79', '1.5') but the column keeps eight
 * fraction digits and ten whole digits, so more is refused instead of being rounded silently.
 *
 * @param text the typed rate
 * @returns a field error, or `undefined` when the rate is valid
 */
export function checkRate(text: string): FieldError | undefined {
  const bad = (message: string): FieldError => ({ field: 'rateToBase', code: 'invalid', message });
  if (!RATE_PATTERN.test(text)) return bad('Enter a rate above zero.');
  const [whole = '', fraction = ''] = text.split('.');
  if (/^0*$/.test(whole + fraction)) return bad('Enter a rate above zero.');
  if (whole.replace(/^0+(?=\d)/, '').length > CURRENCY_LIMITS.rateIntegerDigits) return bad('This rate is too large.');
  if (fraction.length > CURRENCY_LIMITS.rateFractionDigits) {
    return bad(`Use at most ${CURRENCY_LIMITS.rateFractionDigits} decimal places.`);
  }
  return undefined;
}

/**
 * Checks a markup percent typed as text.
 *
 * Why: money.md: markup 0 to 10 (a percent with at most four places, the `numeric(9,4)` column).
 *
 * @param text the typed markup
 * @returns a field error, or `undefined` when the markup is valid
 */
export function checkMarkup(text: string): FieldError | undefined {
  const bad = (): FieldError => ({
    field: 'markupPercent',
    code: 'range',
    message: 'Enter a markup between 0 and 10.',
  });
  if (!RATE_PATTERN.test(text)) return bad();
  const [, fraction = ''] = text.split('.');
  if (fraction.length > 4 || Number(text) > CURRENCY_LIMITS.markupMax) return bad();
  return undefined;
}

/**
 * Checks the number of fraction digits a currency shows.
 *
 * Why: resolution money-13: an integer 0 to 4, the same range as the database CHECK.
 *
 * @param decimals the value from the request
 * @returns a field error, or `undefined` when it is valid
 */
export function checkDecimals(decimals: number): FieldError | undefined {
  return Number.isInteger(decimals) &&
    decimals >= CURRENCY_LIMITS.decimalsMin &&
    decimals <= CURRENCY_LIMITS.decimalsMax
    ? undefined
    : { field: 'decimals', code: 'range', message: 'Enter 0 to 4 decimals.' };
}

/**
 * Checks that a currency's decimals can be charged exactly by the storefront card method.
 *
 * Why: decision 048: the buyer's gross is rounded to the currency's decimals, and a card method charges in fixed steps (0.01, or whole
 * units for some currencies); a currency with more decimals would make the gateway charge a rounded amount.
 *
 * @param code the currency code
 * @param decimals the decimals the currency would have
 * @param maxDecimals the most decimals an active storefront card method charges exactly in this currency, `undefined` when none limits it
 * @returns a field error on `decimals` (`not_chargeable`), or `undefined`
 */
export function chargeDecimalsProblem(
  code: string,
  decimals: number,
  maxDecimals: number | undefined,
): FieldError | undefined {
  if (maxDecimals === undefined || decimals <= maxDecimals) return undefined;
  return {
    field: 'decimals',
    code: 'not_chargeable',
    message: `The card payment method charges ${code.toUpperCase()} with at most ${maxDecimals} decimals.`,
  };
}

/**
 * Normalises a decimal text so two spellings of one number compare equal (`0.79`, `0.7900`, `00.79`).
 *
 * Why: the base currency refuses a rate change, and re-sending the stored rate is not a change.
 *
 * @param text a decimal written with digits only
 * @returns the number without leading zeros of the whole part and without trailing zeros of the fraction
 */
export function normalizeDecimal(text: string): string {
  const [whole = '0', fraction = ''] = text.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? integer : `${integer}.${trimmed}`;
}

/**
 * Tells whether the shop may charge in a currency now.
 *
 * Why: decision 049: a checkout locks the rate it is quoted at; a rate a refresh held, or older than `fx.max_rate_age_hours`, is not
 * offered. The base currency always is (its rate is 1).
 *
 * @param code the currency code
 * @param rateUpdatedAtMs when the rate was last set, epoch ms
 * @param heldAtMs when a refresh held the provider's rate (`rate_held_at`), or `null`
 * @param nowMs the clock's time, epoch ms
 * @param maxAgeHours the setting `fx.max_rate_age_hours`
 * @returns true when the currency may be offered
 */
export function isRateOffered(
  code: string,
  rateUpdatedAtMs: number,
  heldAtMs: number | null,
  nowMs: number,
  maxAgeHours: number,
): boolean {
  if (code === BASE_CURRENCY) return true;
  if (heldAtMs !== null) return false;
  return nowMs - rateUpdatedAtMs <= maxAgeHours * 3_600_000;
}

/**
 * Tells whether a refreshed rate moved more than the bound from the stored one, in either direction:
 * `max(stored, offered) x 100 > min(stored, offered) x (100 + bound)`.
 *
 * Why: decision 049: a provider's mistake or a large market move is confirmed by staff before the shop charges at it. The ratio of
 * the larger rate to the smaller one judges a fall like a rise (measured against the stored rate alone, a fall could never pass
 * 100 percent); exactly the bound passes.
 *
 * @param stored the stored rate (`numeric(18,8)` text, above zero)
 * @param offered the provider's rate (decimal text, above zero)
 * @param maxMovePercent the setting `fx.max_refresh_move_percent`
 * @returns true when the rate is held
 */
export function rateMovedTooFar(stored: string, offered: string, maxMovePercent: number): boolean {
  const old = new D(stored);
  const next = new D(offered);
  const high = D.max(old, next);
  const low = D.min(old, next);
  return high.times(100).gt(low.times(100 + maxMovePercent));
}

/**
 * The `failed[]` message of a held rate: both rates, the move the decision judged and the bound it was judged against.
 *
 * Why: decision 049: staff see what the provider sent and why it was held, then confirm a rate on the Currencies page. The figure is the
 * one {@link rateMovedTooFar} compares with the bound, the larger rate over the smaller one, in percent with one decimal, so a rise and a
 * fall of the same ratio read alike and a held rate never reads below its bound (a move a hair beyond the bound that rounds to the bound
 * itself is shown rounded up, so the sentence stays true).
 *
 * @param stored the stored rate
 * @param offered the provider's rate
 * @param maxMovePercent the setting `fx.max_refresh_move_percent` the move was judged against
 * @returns for example `Held: the provider sent 47.1000 against the stored 30.9000, moved by 52.4 %, beyond the 20 % allowed. Confirm a rate to offer the currency again.`
 */
export function heldRateMessage(stored: string, offered: string, maxMovePercent: number): string {
  const old = new D(stored);
  const next = new D(offered);
  const judged = D.max(old, next).div(D.min(old, next)).minus(1).times(100);
  let move = judged.toDecimalPlaces(1, D.ROUND_HALF_UP);
  if (move.lte(maxMovePercent)) move = judged.toDecimalPlaces(1, D.ROUND_UP);
  return `Held: the provider sent ${formatRate(offered)} against the stored ${formatRate(stored)}, moved by ${move.toFixed(1)} %, beyond the ${maxMovePercent} % allowed. Confirm a rate to offer the currency again.`;
}
