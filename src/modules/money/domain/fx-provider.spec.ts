// Unit tests of the exchange-rate provider helpers: the decimal text of a rate a provider sent as a number.
import { describe, expect, it } from 'bun:test';
import { rateText } from './fx-provider';

describe('rateText', () => {
  it('writes a positive rate with eight fraction digits and no exponent', () => {
    expect(rateText(0.79)).toBe('0.79000000');
    expect(rateText(3.6725)).toBe('3.67250000');
    expect(rateText(0.91502345678)).toBe('0.91502346');
    expect(rateText(16250.5)).toBe('16250.50000000');
    expect(rateText(1e-7)).toBe('0.00000010');
  });

  it('refuses what is not a usable rate: zero, negative, tiny, huge, not finite, not a number', () => {
    for (const value of [0, -1, 1e-9, 1e10, Number.NaN, Number.POSITIVE_INFINITY, '0.79', null, undefined, {}]) {
      expect(rateText(value), `${typeof value}`).toBeUndefined();
    }
  });
});
