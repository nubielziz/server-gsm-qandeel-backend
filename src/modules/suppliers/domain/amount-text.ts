// How a supplier's number text becomes the 4-decimal text this backend stores (decision 026) and which amounts it uses (decision 051). Its
// own file so the supplier call contracts and the Dhru protocol both use it without importing each other.
import { Decimal } from 'decimal.js';

/**
 * Turns a supplier's number text into the 4-decimal text this backend stores.
 *
 * Why: suppliers send credits as numbers or as text with currency signs and thousands separators, and money is stored as 4-decimal
 * text (decision 026); one reading keeps the sync, the balance check and the contracts' examples consistent. Decision 051: a JSON number
 * is read exactly (never through its exponent text, which would read `1e21` as 1), and text written with an exponent (white space between
 * its parts included, as in `1 e 5`) is not an amount this backend reads; the check takes time in proportion to the text.
 *
 * @param value a number or text such as `"120.5"`, `"$1,200.50"`
 * @returns the amount rounded half up to four decimals, or `undefined` when no number can be read (also for a number that is not finite
 *   and for text with an exponent)
 */
export function amountText(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Decimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  // An exponent is a digit, e or E, an optional sign and a digit, with white space allowed between them. The white space is removed
  // first so the test takes time in proportion to the text (supplier text is up to 20,000 characters; decision 051).
  if (/\d[eE][+-]?\d/.test(value.replace(/\s+/g, ''))) return undefined;
  const cleaned = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!cleaned) return undefined;
  try {
    return new Decimal(cleaned[0]).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
  } catch {
    return undefined;
  }
}

/** The largest amount (and, negated, the smallest balance) a supplier may report: one billion supplier credits (decision 051). */
export const SUPPLIER_AMOUNT_LIMIT = '1000000000';

/** The range of a service price: 0 to 1,000,000,000, both ends included (decision 051). */
export const SUPPLIER_PRICE_RANGE = { min: '0', max: SUPPLIER_AMOUNT_LIMIT } as const;

/** The range of an account balance: -1,000,000,000 to 1,000,000,000, both ends included (decision 051). */
export const SUPPLIER_BALANCE_RANGE = { min: '-1000000000', max: SUPPLIER_AMOUNT_LIMIT } as const;

/** What {@link supplierAmount} found: a usable amount, text that is not an amount, or an amount outside the range. */
export type SupplierAmount =
  { readonly kind: 'ok'; readonly text: string } | { readonly kind: 'unreadable' } | { readonly kind: 'out_of_range' };

/**
 * Reads a supplier amount and judges it against a range.
 *
 * Why: decision 051: the money columns hold `numeric(18,4)` and a cost is multiplied by a rate, so a price or balance outside a sane range
 * is not used (a broken price would otherwise move costs and floors, or fail the whole sync).
 *
 * @param value the supplier's number or number text
 * @param range the smallest and largest accepted amount, both included
 * @returns `ok` with the 4-decimal text (a zero is always `'0.0000'`, never `'-0.0000'`), `unreadable`, or `out_of_range`
 */
export function supplierAmount(value: unknown, range: { readonly min: string; readonly max: string }): SupplierAmount {
  const text = amountText(value);
  if (text === undefined) return { kind: 'unreadable' };
  const amount = new Decimal(text);
  if (amount.lt(range.min) || amount.gt(range.max)) return { kind: 'out_of_range' };
  return { kind: 'ok', text: amount.isZero() ? '0.0000' : text };
}
