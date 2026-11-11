// The quantity rule a Dhru supplier states for a service (feature 25, B213): read from the synced entry (`supplier_services.raw`)
// and normalised to a rule the catalog accepts. Pure.
import { MAX_QTY_OPTIONS, MAX_QUANTITY, type QuantityRule } from '../../catalog';

const WHOLE = /^\d+$/;

/** A string trimmed, a number as text, a boolean or anything else `''`. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/** The whole number a text holds when it is digits only, else `undefined`. */
function whole(value: unknown): number | undefined {
  const t = text(value);
  return WHOLE.test(t) ? Number(t) : undefined;
}

/** Whether the supplier's `QNT` says the service takes a quantity: `1` or `true`; absent or empty falls back to the other fields. */
function quantityFlag(raw: unknown, fallback: boolean): boolean {
  if (raw === true) return true;
  if (raw === false) return false;
  const t = text(raw);
  if (t === '') return fallback;
  return whole(t) === 1;
}

/**
 * Reads the quantity rule of a supplier service from its synced entry.
 *
 * Why: when the import creates a service it starts with the supplier's rule (B213). The rule is always a subset of what the supplier
 * stated (a value that cannot be read, a repeat, a pack over 100000 or beyond the 50 smallest is dropped, a largest above 100000 is
 * capped), so we never sell a quantity the supplier said it refuses; an unreadable rule falls back to one per order. It never fails
 * and always passes `quantityRuleProblems`, so a supplier can never block an import.
 *
 * Reads `QNT` (`1` or `true` = the service takes a quantity; absent or empty = it does when packs or a largest above 1 are
 * given), `MINQNT`, `MAXQNT` and `QNTOPTIONS` (pack sizes separated by commas, semicolons, bars or spaces).
 *
 * @param raw the supplier's service entry as stored in `supplier_services.raw`
 * @returns the rule: `{ 1, 1, [] }` when off, the packs with the smallest and largest pack as bounds, or the range
 */
export function supplierQuantityRule(raw: Record<string, unknown>): QuantityRule {
  const seen = new Set<number>();
  for (const token of text(raw.QNTOPTIONS).split(/[,;|\s]+/)) {
    const value = whole(token);
    if (value !== undefined && value >= 1 && value <= MAX_QUANTITY) seen.add(value);
  }
  const options = [...seen].sort((a, b) => a - b).slice(0, MAX_QTY_OPTIONS);

  const minRead = whole(raw.MINQNT);
  const min = minRead !== undefined && minRead >= 1 && minRead <= MAX_QUANTITY ? minRead : 1;
  const maxRead = whole(raw.MAXQNT);
  const max = maxRead !== undefined && maxRead >= 1 ? Math.max(Math.min(maxRead, MAX_QUANTITY), min) : min;

  if (!quantityFlag(raw.QNT, options.length > 0 || max > 1)) return { minQty: 1, maxQty: 1, qtyOptions: [] };
  if (options.length > 0) return { minQty: options[0]!, maxQty: options[options.length - 1]!, qtyOptions: options };
  return { minQty: min, maxQty: max, qtyOptions: [] };
}
