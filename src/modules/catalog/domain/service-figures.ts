// The worked-out figures of a service: the default minimum profit, the price floor, the margin and "below floor".
// Pure functions of exact decimals (decision 011); `infra/service-figures.sql.ts` writes the same rules in SQL for the list.
import { Decimal } from 'decimal.js';
import { Money } from '../../../common/money';

/** The share of the effective cost the default minimum profit asks for: 6 %. */
const DEFAULT_PROFIT_PERCENT = 6n;
/** The least minimum profit the default policy ever asks for, in cents. */
const DEFAULT_PROFIT_FLOOR_CENTS = 2n;
/** A `Money` has 4 fraction digits; 10^4 turns the integer behind it into whole units. */
const MONEY_UNIT = 10_000n;

/**
 * The minimum profit a service has when it sets none: `max(round(6 % of the effective cost, 2), 0.02)`.
 *
 * Why: RULES services 1 (demo 10-data.js:215): a service with `min_profit` null follows this policy, and the floor of every
 * price is the effective cost plus it. The percent is taken exactly and rounded half-up to cents once; rounding to four
 * digits first would round some costs the other way (cost 0.4159 gives 0.024954, which is 0.02, not 0.03).
 *
 * @param effectiveCost the effective cost of the service (`services.effective_cost`)
 * @returns the default minimum profit, at least 0.02
 * @throws {RangeError} when the cost is negative
 */
export function defaultMinProfit(effectiveCost: Money): Money {
  if (effectiveCost.isNegative()) throw new RangeError('A cost cannot be negative.');
  const units = BigInt(effectiveCost.toWire().replace('.', ''));
  // cost (in 1/10^4) x 6 % is in 1/10^6; 10^4 of those make a cent; add half a cent before the integer division.
  const cents = (units * DEFAULT_PROFIT_PERCENT + MONEY_UNIT / 2n) / MONEY_UNIT;
  const chosen = cents > DEFAULT_PROFIT_FLOOR_CENTS ? cents : DEFAULT_PROFIT_FLOOR_CENTS;
  return Money.of(`${chosen / 100n}.${(chosen % 100n).toString().padStart(2, '0')}`);
}

/**
 * The minimum profit that counts for a service: its own when set, else the default policy.
 *
 * Why: `minProfit` on the wire is the effective one (RESOLUTIONS catalog-1); the per-group rule selection of catalog-4 joins
 * in with feature 4b.
 *
 * @param own the service's own `min_profit`, or `null` for the default policy
 * @param effectiveCost the effective cost of the service
 * @returns the minimum profit
 */
export function effectiveMinProfit(own: Money | null, effectiveCost: Money): Money {
  return own ?? defaultMinProfit(effectiveCost);
}

/**
 * The lowest price a service may be sold at: the effective cost plus the minimum profit.
 *
 * Why: the map says selling below the minimum price is blocked; `PATCH /admin/services/:id` refuses a base price under it
 * (RESOLUTIONS catalog-1).
 *
 * @param effectiveCost the effective cost of the service
 * @param minProfit the minimum profit that counts
 * @returns the floor price
 */
export function floorPrice(effectiveCost: Money, minProfit: Money): Money {
  return effectiveCost.add(minProfit);
}

/**
 * The margin of a price over a cost, in percent of the price, with four fraction digits.
 *
 * Why: `marginPct` of a service row is `(basePrice - cost) / basePrice x 100` (RESOLUTIONS catalog-1).
 *
 * @param basePrice the price (above zero)
 * @param cost the effective cost
 * @returns the margin as a decimal string such as `'38.4615'` (negative below cost)
 * @throws {RangeError} when the price is not above zero
 */
export function marginPercent(basePrice: Money, cost: Money): string {
  if (!basePrice.isPositive()) throw new RangeError('A margin needs a price above zero.');
  return new Decimal(basePrice.sub(cost).toWire())
    .mul(100)
    .div(basePrice.toWire())
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
    .toFixed(4);
}

/**
 * Tells whether a price is under the floor.
 *
 * @param basePrice the price
 * @param floor the floor price
 * @returns true when the price is strictly below the floor
 */
export function isBelowFloor(basePrice: Money, floor: Money): boolean {
  return basePrice.cmp(floor) < 0;
}

/**
 * Writes an amount for a message to staff: dollars with at least two and at most four decimals (`$12.50`, `$0.0825`).
 *
 * @param amount the amount
 * @returns the text
 */
export function dollars(amount: Money): string {
  const [whole, fraction = ''] = amount.toWire().split('.');
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${trimmed}`;
}

/**
 * Writes a number of minutes as the delivery time text of a service (`15 min`, `2 hours`, `1 day`).
 *
 * Why: `services.delivery_time` is display text derived from `sla_minutes` by the writer (schema note B21); the storefront and
 * the merchant catalog show it.
 *
 * @param minutes the SLA in minutes (at least 1)
 * @returns the text; a mixed value reads `1 h 30 min` or `1 d 6 h`
 * @throws {RangeError} when the minutes are not a whole number from 1
 */
export function deliveryTimeText(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 1)
    throw new RangeError('The SLA must be a whole number of minutes from 1.');
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? plural(hours, 'hour') : `${hours} h ${rest} min`;
  }
  const days = Math.floor(minutes / 1440);
  const restHours = Math.floor((minutes % 1440) / 60);
  const restMinutes = minutes % 60;
  if (restHours === 0 && restMinutes === 0) return plural(days, 'day');
  return restMinutes === 0 ? `${days} d ${restHours} h` : `${days} d ${restHours} h ${restMinutes} min`;
}
