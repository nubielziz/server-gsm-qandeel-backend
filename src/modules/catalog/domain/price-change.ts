// Price protection of user rule 9 (MISMATCHES B117), pure: judges the price an order would be charged against the price the
// merchant was last listed. Feature 5 calls it at placement; Dhru and REST v1 (7a) turn a refusal into their own error.
import { Decimal } from 'decimal.js';
import { Money } from '../../../common/money';

/** The settings key of the tolerance, in percent (platform settings registry; integer 0 to 100). */
export const PRICE_CHANGE_TOLERANCE_KEY = 'pricing.price_change_tolerance_percent';

/** The tolerance when the setting was never saved: an order may cost up to 10 % more than the listed price. */
export const DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT = 10;

/** The accepted range of the tolerance setting, in percent. */
export const PRICE_CHANGE_TOLERANCE_BOUNDS = { min: 0, max: 100 } as const;

/** Why a charged price is above the listed one but accepted. */
export type PriceRaiseReason = 'floor' | 'price_change';

/**
 * What the guard decided.
 *
 * Why: the order is charged (`ok`, `raised`) or refused (`refuse`, `409 PRICE_CHANGED` with the two prices); a raise within
 * the tolerance is recorded in the order's `pricing_snapshot` as `listedPrice`, `raised: true` and the reason.
 */
export type PriceChangeVerdict =
  | { readonly outcome: 'ok'; readonly raised: false }
  | {
      readonly outcome: 'raised';
      readonly raised: true;
      readonly reason: PriceRaiseReason;
      readonly listedPrice: Money;
      readonly currentPrice: Money;
    }
  | { readonly outcome: 'refuse'; readonly listedPrice: Money; readonly currentPrice: Money };

/** What may refine the verdict. */
export interface PriceChangeOptions {
  /** True when the current price is the floor (the resolver clamped it): a raise within the tolerance then says `floor`. */
  readonly floorRaised?: boolean;
}

/**
 * Compares the price to charge with the price the merchant was last listed.
 *
 * Why: user rule 9 / B117 (4): a merchant who saw a price on a list must not pay a lot more than that without noticing. More
 * than `tolerancePercent` above the listed price is refused; a smaller raise is charged and recorded. No listed price on record
 * means no check; a price at or below the listed one is always fine. The comparison is exact: exactly the tolerance still passes.
 *
 * @param listed the last price listed to the merchant for the service, or `null` when none is on record
 * @param current the price the order would be charged now (after the floor clamp)
 * @param tolerancePercent `pricing.price_change_tolerance_percent` (0 to 100)
 * @param options `floorRaised` to name the floor as the reason of a raise
 * @returns `ok`, `raised` (charge it and record the raise) or `refuse` (answer `409 PRICE_CHANGED`)
 * @throws {RangeError} when the tolerance is not a number from 0 to 100
 */
export function checkPriceChange(
  listed: Money | null,
  current: Money,
  tolerancePercent: number,
  options: PriceChangeOptions = {},
): PriceChangeVerdict {
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 100) {
    throw new RangeError('The price change tolerance must be a number from 0 to 100.');
  }
  if (listed === null || current.cmp(listed) <= 0) return { outcome: 'ok', raised: false };
  // (current - listed) x 100 > tolerance x listed, in exact decimals.
  const rise = new Decimal(current.sub(listed).toWire()).mul(100);
  if (rise.gt(new Decimal(listed.toWire()).mul(tolerancePercent))) {
    return { outcome: 'refuse', listedPrice: listed, currentPrice: current };
  }
  return {
    outcome: 'raised',
    raised: true,
    reason: options.floorRaised ? 'floor' : 'price_change',
    listedPrice: listed,
    currentPrice: current,
  };
}
