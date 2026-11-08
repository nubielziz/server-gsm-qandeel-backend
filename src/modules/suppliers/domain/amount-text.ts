// How a supplier's number text becomes the 4-decimal text this backend stores (decision 026). Its own file so the supplier call contracts and
// the Dhru protocol both use it without importing each other.
import { Decimal } from 'decimal.js';

/**
 * Turns a supplier's number text into the 4-decimal text this backend stores.
 *
 * Why: suppliers send credits as numbers or as text with currency signs and thousands separators, and money is stored as 4-decimal
 * text (decision 026); one reading keeps the sync, the balance check and the contracts' examples consistent.
 *
 * @param value a number or text such as `"120.5"`, `"$1,200.50"`
 * @returns the amount rounded half up to four decimals, or `undefined` when no number can be read
 */
export function amountText(value: unknown): string | undefined {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  const cleaned = raw.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!cleaned) return undefined;
  try {
    return new Decimal(cleaned[0]).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
  } catch {
    return undefined;
  }
}
