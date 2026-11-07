// The arithmetic of the bulk price change (POST /admin/services/bulk-price/preview and /apply): read the signed amount,
// work out each new price, and refuse a price that would not be above zero.
import { Decimal } from 'decimal.js';
import { Money } from '../../../common/money';

/** How the change is read: a percentage of the current price, or an amount added to it. */
export type BulkChangeType = 'percent' | 'fixed';

/** A signed decimal with at most four fraction digits: `5`, `-0.25`, `+3.5`. */
const SIGNED_AMOUNT = /^[+-]?\d+(\.\d{1,4})?$/;

/** The most a percent or amount may be, so the arithmetic stays inside `numeric(18,4)`. */
const LIMIT = new Decimal(1_000_000);

/**
 * Reads the amount of a bulk change.
 *
 * Why: the console sends the value as signed decimal text with 0 to 4 decimals (`lib/bulk.ts`); zero, text that is not a number
 * and an absurd size are `422` on `amount`.
 *
 * @param text the value as sent
 * @returns the amount, or the sentence to show under the field
 */
export function readBulkAmount(text: string): { readonly value: Decimal } | { readonly problem: string } {
  if (!SIGNED_AMOUNT.test(text)) return { problem: 'Enter a number with up to 4 decimals, like 5 or -0.25.' };
  const value = new Decimal(text);
  if (value.isZero()) return { problem: 'Enter an amount other than zero.' };
  if (value.abs().gt(LIMIT)) return { problem: 'That amount is too large.' };
  return { value };
}

/**
 * Works out the new price of one service.
 *
 * Why: the preview and the apply must agree to the cent: `percent` is `round(old x (1 + value / 100), 2)` half-up and `fixed`
 * is `round(old + value, 2)` (docs/contract/endpoints/catalog.md, bulk price).
 *
 * @param oldPrice the current base price
 * @param type `percent` or `fixed`
 * @param value the signed amount from {@link readBulkAmount}
 * @returns the new price rounded to cents (it may be zero or negative: the caller refuses those)
 */
export function bulkNewPrice(oldPrice: Money, type: BulkChangeType, value: Decimal): Money {
  const old = new Decimal(oldPrice.toWire());
  const next = type === 'percent' ? old.mul(new Decimal(1).plus(value.div(100))) : old.plus(value);
  return Money.of(next.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
}
