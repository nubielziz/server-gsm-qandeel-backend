// Unit tests of the currency rules (resolution money-13): staleness by age, rate formatting and the field checks.
import { describe, expect, it } from 'bun:test';
import {
  FX_STALE_AFTER_MS,
  checkDecimals,
  checkMarkup,
  checkRate,
  formatRate,
  isRateStale,
  normalizeDecimal,
} from './currency-rules';

describe('isRateStale', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);

  it('marks a non-base currency stale only when its rate is older than 24 hours, to the millisecond', () => {
    expect(isRateStale('GBP', now - FX_STALE_AFTER_MS, now)).toBe(false);
    expect(isRateStale('GBP', now - FX_STALE_AFTER_MS - 1, now)).toBe(true);
  });

  it('never marks the base currency stale', () => {
    expect(isRateStale('USD', now - 365 * FX_STALE_AFTER_MS, now)).toBe(false);
  });
});

describe('formatRate', () => {
  it('trims trailing zeros down to four decimals and keeps significant digits', () => {
    expect(formatRate('0.79000000')).toBe('0.7900');
    expect(formatRate('3.67250000')).toBe('3.6725');
    expect(formatRate('150.12345678')).toBe('150.12345678');
    expect(formatRate('1.00000000')).toBe('1.0000');
    expect(formatRate('2')).toBe('2.0000');
  });
});

describe('normalizeDecimal', () => {
  it('makes two spellings of one number equal', () => {
    expect(normalizeDecimal('0.79')).toBe(normalizeDecimal('0.79000000'));
    expect(normalizeDecimal('01.50')).toBe('1.5');
    expect(normalizeDecimal('2.0')).toBe('2');
    expect(normalizeDecimal('0')).toBe('0');
  });
});

describe('checkRate', () => {
  it('accepts a rate above zero typed with any number of places up to eight', () => {
    for (const ok of ['0.79', '1.5', '3.67250000', '150', '0.00000001', '9999999999'])
      expect(checkRate(ok)).toBeUndefined();
  });

  it('refuses zero, negatives, text, more than eight places and a rate too large for the column', () => {
    for (const bad of ['0', '0.0', '-1', 'abc', '', '1e3', '0.123456789', '10000000000']) {
      expect(checkRate(bad)).toMatchObject({ field: 'rateToBase' });
    }
  });
});

describe('checkMarkup', () => {
  it('accepts 0 to 10 with up to four places', () => {
    for (const ok of ['0', '2.5', '10', '10.0000', '0.0001']) expect(checkMarkup(ok)).toBeUndefined();
  });

  it('refuses anything above 10, negatives, text and a fifth decimal', () => {
    for (const bad of ['10.0001', '-1', 'x', '1.23456', ''])
      expect(checkMarkup(bad)).toMatchObject({ field: 'markupPercent' });
  });
});

describe('checkDecimals', () => {
  it('accepts the integers 0 to 4 only', () => {
    for (const ok of [0, 1, 2, 3, 4]) expect(checkDecimals(ok)).toBeUndefined();
    for (const bad of [-1, 5, 1.5, Number.NaN]) expect(checkDecimals(bad)).toMatchObject({ field: 'decimals' });
  });
});
