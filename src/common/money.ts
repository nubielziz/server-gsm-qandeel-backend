// Money value type (decision 011): exact decimals on decimal.js, scale 4, ROUND_HALF_UP, never a float.
// Every amount in the ledger, orders, wallets and the wire (`"12.4900"`) goes through this class.
import { Decimal } from 'decimal.js';

/** A private Decimal class so the rounding mode and precision never depend on (or change) global state. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -60, toExpPos: 60 });

const SCALE = 4;
/** `numeric(18,4)` holds 14 integer digits; larger values cannot be stored, so they are refused early. */
const LIMIT = new D(10).pow(14);
const TEXT = /^-?\d+(\.\d{1,4})?$/;
const WIRE = /^-?\d+\.\d{4}$/;
const FACTOR = /^-?\d+(\.\d{1,30})?$/;

/** A rate, percent or quantity applied to a {@link Money}: a decimal string, a safe integer or a bigint. */
export type Factor = string | number | bigint;

function toDecimal(input: string | number | bigint, pattern: RegExp, what: string): Decimal {
  if (typeof input === 'string') {
    if (!pattern.test(input))
      throw new TypeError(`${what} must be a plain decimal string (got ${JSON.stringify(input)})`);
    return new D(input);
  }
  if (typeof input === 'bigint') return new D(input.toString());
  if (typeof input === 'number') {
    // A float such as 0.1 is already inexact, so only whole numbers are accepted; decimals travel as strings.
    if (!Number.isSafeInteger(input))
      throw new TypeError(`${what} must not be a float, NaN or Infinity: pass a decimal string`);
    return new D(input);
  }
  throw new TypeError(`${what} must be a string, a safe integer or a bigint`);
}

/**
 * An immutable amount with exactly 4 fraction digits, rounded half away from zero (ROUND_HALF_UP).
 *
 * Why: decision 011 forbids floats for money; one class owns scale and rounding so the ledger, prices, taxes and
 * fees agree to the last digit. Rounding happens only in {@link Money.mul} and {@link Money.pct}, the named
 * points of the decision (price resolution, tax split, FX conversion, gateway fee).
 *
 * @example
 * Money.of('10.00').mul('1.19').toWire() // "11.9000"
 */
export class Money {
  private constructor(private readonly value: Decimal) {}

  /**
   * The zero amount.
   *
   * @returns `0.0000`
   */
  static zero(): Money {
    return new Money(new D(0));
  }

  /**
   * Parses an amount from a decimal string with 0-4 fraction digits, a safe integer or a bigint.
   *
   * Why: floats, NaN and exponent notation are refused so a rounding error can never enter the ledger silently.
   *
   * @param input `"12.49"`, `"12"`, `12` or `12n`; a {@link Money} is returned as is
   * @returns the amount
   * @throws {TypeError} for floats, NaN, Infinity, exponents, spaces or more than 4 fraction digits
   * @throws {RangeError} when the value does not fit `numeric(18,4)`
   */
  static of(input: string | number | bigint | Money): Money {
    if (input instanceof Money) return input;
    return Money.checked(toDecimal(input, TEXT, 'Money'));
  }

  /**
   * Parses the wire form exactly: an optional minus sign, digits, a dot and 4 fraction digits.
   *
   * Why: ALIGNMENT § 1 fixes the wire format; anything else from a client is a validation error, not a guess.
   *
   * @param text e.g. `"12.4900"` or `"-0.5000"`
   * @returns the amount
   * @throws {TypeError} when the text is not in wire form
   * @throws {RangeError} when the value does not fit `numeric(18,4)`
   */
  static fromWire(text: string): Money {
    if (typeof text !== 'string' || !WIRE.test(text)) {
      throw new TypeError(`Money wire value must look like "12.4900" (got ${JSON.stringify(text)})`);
    }
    return Money.checked(new D(text));
  }

  /**
   * Adds amounts.
   *
   * @param values the amounts to add
   * @returns their exact sum (zero for an empty list)
   */
  static sum(values: Iterable<Money>): Money {
    let total = Money.zero();
    for (const value of values) total = total.add(value);
    return total;
  }

  private static checked(value: Decimal): Money {
    if (!value.isFinite() || value.abs().gte(LIMIT)) throw new RangeError('Money is outside numeric(18,4)');
    return new Money(value.toDecimalPlaces(SCALE, Decimal.ROUND_HALF_UP));
  }

  /**
   * @param other the amount to add
   * @returns this plus other (exact)
   * @throws {RangeError} when the result does not fit `numeric(18,4)`
   */
  add(other: Money): Money {
    return Money.checked(this.value.plus(other.value));
  }

  /**
   * @param other the amount to subtract
   * @returns this minus other (exact)
   * @throws {RangeError} when the result does not fit `numeric(18,4)`
   */
  sub(other: Money): Money {
    return Money.checked(this.value.minus(other.value));
  }

  /**
   * Multiplies by a rate or quantity and rounds half up to 4 decimals (a named rounding point).
   *
   * @param factor e.g. `"1.19"`, an FX rate `"3.67250000"` or a quantity `3`
   * @returns the rounded product
   * @throws {TypeError} when the factor is a float, NaN or not a plain decimal
   * @throws {RangeError} when the result does not fit `numeric(18,4)`
   */
  mul(factor: Factor): Money {
    return Money.checked(this.value.times(toDecimal(factor, FACTOR, 'Factor')));
  }

  /**
   * Takes a percentage of this amount (`percent / 100`) and rounds half up to 4 decimals.
   *
   * @param percent e.g. `"19"` or `"2.9000"` (a tax rate or gateway fee percent)
   * @returns the rounded share
   * @throws {TypeError} when the percent is a float, NaN or not a plain decimal
   */
  pct(percent: Factor): Money {
    return Money.checked(this.value.times(toDecimal(percent, FACTOR, 'Percent')).div(100));
  }

  /** @returns the same amount with the opposite sign (zero stays zero) */
  neg(): Money {
    return new Money(this.value.negated());
  }

  /** @returns the amount without its sign */
  abs(): Money {
    return new Money(this.value.abs());
  }

  /**
   * @param other the amount to compare with
   * @returns -1, 0 or 1 when this is less than, equal to or greater than other
   */
  cmp(other: Money): -1 | 0 | 1 {
    return this.value.cmp(other.value) as -1 | 0 | 1;
  }

  /** @returns true when both amounts are equal */
  eq(other: Money): boolean {
    return this.value.eq(other.value);
  }

  /** @returns true for `0.0000` */
  isZero(): boolean {
    return this.value.isZero();
  }

  /** @returns true when below zero */
  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  /** @returns true when above zero */
  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  /**
   * The wire form: always 4 fraction digits, never `-0.0000`.
   *
   * @returns e.g. `"12.4900"`
   */
  toWire(): string {
    return this.value.isZero() ? '0.0000' : this.value.toFixed(SCALE);
  }

  /** @returns the wire form, so `JSON.stringify` of a Money never leaks a float or an object */
  toJSON(): string {
    return this.toWire();
  }

  /** @returns the wire form */
  toString(): string {
    return this.toWire();
  }
}
