// Unit tests of the Stripe minor units (feature 24C): the exponent of every listed currency, rounding to what the gateway can charge,
// and reading the gateway's integers back.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  STRIPE_THREE_DECIMAL,
  STRIPE_WHOLE_UNITS,
  STRIPE_ZERO_DECIMAL,
  chargeableDecimals,
  exponentOf,
  fromMinor,
  toMinor,
} from '@src/modules/money/infra/gateway-drivers/stripe-amounts';

describe('exponentOf', () => {
  it('knows every listed currency, in any case, and defaults to two digits', () => {
    for (const code of STRIPE_ZERO_DECIMAL) expect(exponentOf(code)).toBe(0);
    for (const code of STRIPE_THREE_DECIMAL) expect(exponentOf(code)).toBe(3);
    for (const code of STRIPE_WHOLE_UNITS) expect(exponentOf(code)).toBe(2);
    expect(exponentOf('jpy')).toBe(0);
    expect(exponentOf('jod')).toBe(3);
    for (const code of ['USD', 'GBP', 'EUR', 'usd', 'XYZ']) expect(exponentOf(code)).toBe(2);
  });
});

describe('toMinor', () => {
  const of = (amount: string, currency: string) => toMinor(Money.of(amount), currency);

  it('takes two-decimal amounts as cents, rounding half up', () => {
    expect(of('10.99', 'USD')).toEqual({ minor: '1099', exact: true });
    expect(of('10.995', 'USD')).toEqual({ minor: '1100', exact: false });
    expect(of('10.9949', 'usd')).toEqual({ minor: '1099', exact: false });
    expect(of('0', 'USD')).toEqual({ minor: '0', exact: true });
  });

  it('takes zero-decimal amounts as they are', () => {
    expect(of('500', 'JPY')).toEqual({ minor: '500', exact: true });
    expect(of('500.5', 'JPY')).toEqual({ minor: '501', exact: false });
    expect(of('500.4999', 'KRW')).toEqual({ minor: '500', exact: false });
  });

  it('takes three-decimal amounts with three digits and a last digit of 0', () => {
    expect(of('3.500', 'JOD')).toEqual({ minor: '3500', exact: true });
    expect(of('3.505', 'JOD')).toEqual({ minor: '3510', exact: false });
    expect(of('3.504', 'JOD')).toEqual({ minor: '3500', exact: false });
    expect(of('12.34', 'KWD')).toEqual({ minor: '12340', exact: true });
    for (const code of STRIPE_THREE_DECIMAL) expect(of('1', code).minor).toBe('1000');
  });

  it('takes ISK and UGX as two digits that are always 00', () => {
    expect(of('5', 'ISK')).toEqual({ minor: '500', exact: true });
    expect(of('5.4', 'ISK')).toEqual({ minor: '500', exact: false });
    expect(of('5.5', 'UGX')).toEqual({ minor: '600', exact: false });
  });

  it('refuses a negative amount', () => {
    expect(() => of('-1', 'USD')).toThrow(RangeError);
  });
});

describe('fromMinor', () => {
  it('reads the gateway integer with the currency exponent', () => {
    expect(fromMinor(1099, 'usd')).toBe('10.9900');
    expect(fromMinor(500, 'JPY')).toBe('500.0000');
    expect(fromMinor(3500, 'jod')).toBe('3.5000');
    expect(fromMinor(500, 'ISK')).toBe('5.0000');
    expect(fromMinor(0, 'USD')).toBe('0.0000');
  });

  it('round-trips every exact amount', () => {
    const cases: [string, string][] = [
      ['10.99', 'USD'],
      ['500', 'JPY'],
      ['3.5', 'JOD'],
      ['7', 'ISK'],
      ['0.01', 'GBP'],
    ];
    for (const [amount, currency] of cases) {
      const { minor, exact } = toMinor(Money.of(amount), currency);
      expect(exact).toBe(true);
      expect(fromMinor(Number(minor), currency)).toBe(Money.of(amount).toWire());
    }
  });

  it('reads nothing from a value that is not a safe non-negative integer, or without a currency', () => {
    for (const junk of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '100', null, undefined, {}]) {
      expect(fromMinor(junk, 'USD')).toBeNull();
    }
    expect(fromMinor(100, null)).toBeNull();
    expect(fromMinor(100, undefined)).toBeNull();
    expect(fromMinor(100, '')).toBeNull();
  });
});

describe('chargeableDecimals (decision 048)', () => {
  it('chargeable decimals per currency group', () => {
    for (const code of ['JPY', 'isk', 'UGX', 'KRW']) expect(chargeableDecimals(code)).toBe(0);
    for (const code of ['JOD', 'KWD', 'USD', 'gbp']) expect(chargeableDecimals(code)).toBe(2);
    // An amount with that many decimals is charged exactly; one more decimal is not.
    const cases: Array<[string, string, string]> = [
      ['JPY', '500', '500.5'],
      ['ISK', '5', '5.4'],
      ['USD', '10.99', '10.995'],
      ['JOD', '3.39', '3.396'],
    ];
    for (const [code, exact, inexact] of cases) {
      expect(toMinor(Money.of(exact), code).exact).toBe(true);
      expect(toMinor(Money.of(inexact), code).exact).toBe(false);
    }
  });
});
