// The arithmetic of a storefront price (feature 14a): the retail net price, the tax on it, the locked exchange rate and the
// amounts in the buyer's currency. Pure functions on exact decimals (decision 011); no database.
import { Decimal } from 'decimal.js';
import { Money } from '../../../common/money';
import { storefrontFloor } from '../../catalog';

/** Exact decimals with half-up rounding, whatever the global Decimal settings are. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Net, tax and gross of one purchase. */
export interface Amounts {
  readonly net: Money;
  readonly tax: Money;
  /** `net + tax`. */
  readonly gross: Money;
}

/**
 * The retail price the shop charges for one unit: the larger of the resolver's price and the storefront floor.
 *
 * Why: RESOLUTIONS b2c-7 and catalog-12: a retail price is never under the floor, and the floor of the storefront group is
 * `max(round(base price x 1.10, 2), effective cost + minimum profit)`. The resolver already clamps to the second part; the
 * 10 % over the base price is the storefront's own rule, so a cost rise or a later edit can never sell under it.
 *
 * @param resolved the resolver's price for the retail group (net, USD)
 * @param basePrice the service's base price
 * @param floor the resolver's floor for the retail group
 * @returns the unit net price
 */
export function retailNet(resolved: Money, basePrice: Money, floor: Money): Money {
  const minimum = storefrontFloor(basePrice, floor);
  return resolved.cmp(minimum) >= 0 ? resolved : minimum;
}

/**
 * The tax on a net amount, rounded half up to cents.
 *
 * Why: the demo's `taxFor` rounds the tax to cents and the buyer is charged cents, so the stored tax is a whole number of
 * cents; the ledger still holds four decimals.
 *
 * @param net the net amount (USD)
 * @param ratePercent the tax rate in percent as text (`'20.0000'`)
 * @returns the tax (USD)
 */
export function taxOn(net: Money, ratePercent: string): Money {
  const tax = new D(net.toWire()).times(new D(ratePercent)).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return Money.of(tax.toFixed(2));
}

/**
 * The amounts of a purchase in USD.
 *
 * @param unitNet the unit net price
 * @param quantity the quantity (a whole number from 1)
 * @param ratePercent the tax rate in percent as text
 * @returns net (unit x quantity), tax and gross
 */
export function amountsOf(unitNet: Money, quantity: number, ratePercent: string): Amounts {
  const net = unitNet.mul(quantity);
  const tax = taxOn(net, ratePercent);
  return { net, tax, gross: net.add(tax) };
}

/**
 * The exchange rate a session locks: the market rate with the currency's markup on top.
 *
 * Why: `currencies.rate_to_base` is units of the currency per 1 USD and `markup_percent` is added on top of the market rate to
 * cover exchange fees (the console's wording), so the buyer is quoted `rate x (1 + markup / 100)`.
 *
 * @param rateToBase units of the currency per 1 USD, as text
 * @param markupPercent the markup in percent, as text
 * @returns the rate with 8 decimals (the `fx_rate` column)
 */
export function lockedFxRate(rateToBase: string, markupPercent: string): string {
  return new D(rateToBase)
    .times(new D(100).plus(new D(markupPercent)))
    .div(100)
    .toDecimalPlaces(8)
    .toFixed(8);
}

/**
 * Converts USD amounts into the buyer's currency.
 *
 * Why: the gross is converted and rounded to the currency's decimals first and the tax second; the net is what is left, so the
 * three always add up in the currency the buyer sees.
 *
 * @param usd the amounts in USD
 * @param fxRate the locked rate (units per USD)
 * @param decimals the currency's fraction digits (0 to 4)
 * @returns the amounts in the currency (written with four decimals like every money value)
 */
export function inCurrency(usd: Amounts, fxRate: string, decimals: number): Amounts {
  const convert = (amount: Money): Decimal =>
    new D(amount.toWire()).times(new D(fxRate)).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  const gross = convert(usd.gross);
  const tax = convert(usd.tax);
  const net = gross.minus(tax);
  const money = (value: Decimal): Money => Money.of(value.toFixed(4));
  return { net: money(net), tax: money(tax), gross: money(gross) };
}

/**
 * Writes a tax rate as the wire does: four decimals.
 *
 * @param ratePercent a percent as the database prints it
 * @returns the percent with four decimals
 */
export function percentWire(ratePercent: string): string {
  return new D(ratePercent).toFixed(4);
}
