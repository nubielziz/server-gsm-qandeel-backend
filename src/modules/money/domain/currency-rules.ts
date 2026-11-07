// Currency rules without a database (resolution money-13, ANSWERS settings Q7): validation of a currency's fields, the
// stale test and the wire form of a rate.
import type { FieldError } from '../../../common/errors';
import { BASE_CURRENCY } from './accounts';

/** A rate older than this (non-base currency) is stale: the panel and the dashboard's `fx_stale` item agree (M166). */
export const FX_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Tells whether a currency's rate is stale.
 *
 * Why: resolution money-13: `isStale` = a non-base currency whose `rate_updated_at` is older than 24 h (age only; the column
 * is never null).
 *
 * @param code the currency code
 * @param rateUpdatedAtMs when the rate last changed, epoch milliseconds
 * @param nowMs the clock's time, epoch milliseconds
 * @returns true for a non-base currency older than 24 hours
 */
export function isRateStale(code: string, rateUpdatedAtMs: number, nowMs: number): boolean {
  return code !== BASE_CURRENCY && nowMs - rateUpdatedAtMs > FX_STALE_AFTER_MS;
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
