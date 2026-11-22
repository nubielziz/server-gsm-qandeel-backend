// Minor units of the Stripe protocol (feature 24C, decision 011): the integer the gateway's API takes and sends for an amount, per
// currency, in both directions. Source: https://docs.stripe.com/currencies (zero-decimal list, special cases ISK and UGX) and the
// three-decimal currencies there (BHD, JOD, KWD, OMR, TND: three digits, and a charge's last digit must be 0).
import { Money } from '../../../../common/money';

/** Currencies the gateway counts in whole units: 500 JPY is `500`. */
export const STRIPE_ZERO_DECIMAL = [
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
] as const;

/** Currencies with three digits: 3.500 JOD is `3500`; a charge must end in 0 (the gateway's partners charge in steps of 0.010). */
export const STRIPE_THREE_DECIMAL = ['BHD', 'JOD', 'KWD', 'OMR', 'TND'] as const;

/** Two-decimal on the wire but only whole units may be charged (Stripe "special cases"): 5 ISK is `500`, never `540`. */
export const STRIPE_WHOLE_UNITS = ['ISK', 'UGX'] as const;

const ZERO: ReadonlySet<string> = new Set(STRIPE_ZERO_DECIMAL);
const THREE: ReadonlySet<string> = new Set(STRIPE_THREE_DECIMAL);
const WHOLE: ReadonlySet<string> = new Set(STRIPE_WHOLE_UNITS);

/** One ten-thousandth of a unit: the scale of {@link Money}'s wire form. */
const E4 = 10_000n;
/** What one minor unit is in major units, by exponent (a factor {@link Money.mul} takes). */
const MINOR_FACTOR = { 0: '1', 2: '0.01', 3: '0.001' } as const;

/**
 * The number of digits the gateway's minor unit has for a currency.
 *
 * Why: Stripe counts every amount in the currency's minor unit; billing works in 4-decimal amounts. A fixed 100 charged a JOD customer a
 * tenth of the price and a JPY customer a hundred times it (plan 24C § 2.2).
 *
 * @param currency an ISO code, any case
 * @returns 0 (zero-decimal), 3 (three-decimal) or 2 (every other currency, ISK and UGX included: they travel as two digits)
 */
export function exponentOf(currency: string): 0 | 2 | 3 {
  const code = currency.toUpperCase();
  if (ZERO.has(code)) return 0;
  if (THREE.has(code)) return 3;
  return 2;
}

/**
 * The most significant decimals an amount may have to be charged exactly in a currency.
 *
 * Why: decision 048: the gateway charges zero-decimal and whole-unit currencies (JPY, ISK, UGX) in whole units and every other one in steps
 * of 0.01 (a three-decimal currency's last digit must be 0); an amount with this many significant decimals or fewer is charged exactly
 * (`toMinor(...).exact`), any other is refused before a page opens.
 *
 * @param currency an ISO code, any case
 * @returns 0 for the zero-decimal and whole-unit currencies, else 2
 */
export function chargeableDecimals(currency: string): 0 | 2 {
  const code = currency.toUpperCase();
  return ZERO.has(code) || WHOLE.has(code) ? 0 : 2;
}

/** The smallest step the gateway can charge, in ten-thousandths of a unit. */
function stepOf(currency: string): bigint {
  const code = currency.toUpperCase();
  if (ZERO.has(code) || WHOLE.has(code)) return E4;
  // Two-decimal: 0.01; three-decimal: 0.010 (the last of the three digits must be 0), the same step.
  return 100n;
}

/**
 * The integer amount the gateway's API takes for an amount.
 *
 * Why: plan 24C § 2.2: an outgoing amount is rounded half up to what the gateway can charge, never truncated; when rounding changed it the
 * caller logs it, and the exact mismatch guards hold the confirmation for staff (a difference is never hidden).
 *
 * @param amount what is charged or refunded (not negative)
 * @param currency the ISO code of the amount
 * @returns the minor units as an integer string, and whether they are exactly the amount
 * @throws {RangeError} for a negative amount
 */
export function toMinor(amount: Money, currency: string): { minor: string; exact: boolean } {
  if (amount.isNegative()) throw new RangeError('A gateway amount cannot be negative.');
  const [whole, fraction] = amount.toWire().split('.');
  const tenThousandths = BigInt(`${whole}${fraction}`);
  const step = stepOf(currency);
  // Half up for a non-negative value: add half a step, then drop the remainder.
  const rounded = ((tenThousandths + step / 2n) / step) * step;
  const minor = (rounded * 10n ** BigInt(exponentOf(currency))) / E4;
  return { minor: minor.toString(), exact: rounded === tenThousandths };
}

/**
 * The 4-decimal amount of an integer in the gateway's minor units.
 *
 * Why: what the gateway reports (a checkout's `amount_total`, a dispute's `amount` and `fee`) is compared exactly with what billing asked
 * for, so it must be read with the currency's own exponent.
 *
 * @param minor the value from the event
 * @param currency the event's currency, any case
 * @returns the amount in wire form, or `null` for anything that is not a safe non-negative integer, or when the currency is missing
 */
export function fromMinor(minor: unknown, currency: string | null | undefined): string | null {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 0) return null;
  if (typeof currency !== 'string' || currency === '') return null;
  try {
    return Money.of(minor).mul(MINOR_FACTOR[exponentOf(currency)]).toWire();
  } catch {
    // Larger than numeric(18,4) can hold: not an amount billing can compare.
    return null;
  }
}
