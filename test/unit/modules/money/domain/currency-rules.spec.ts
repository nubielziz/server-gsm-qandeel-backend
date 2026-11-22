// Unit tests of the currency rules (resolution money-13): staleness by age, rate formatting and the field checks.
import { describe, expect, it } from 'bun:test';
import {
  chargeDecimalsProblem,
  checkDecimals,
  checkMarkup,
  checkRate,
  formatRate,
  FX_STALE_AFTER_MS,
  heldRateMessage,
  isRateOffered,
  isRateStale,
  normalizeDecimal,
  rateMovedTooFar,
} from '@src/modules/money/domain/currency-rules';

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

describe('chargeDecimalsProblem (decision 048)', () => {
  it('decimals a card method cannot charge', () => {
    expect(chargeDecimalsProblem('jod', 3, 2)).toEqual({
      field: 'decimals',
      code: 'not_chargeable',
      message: 'The card payment method charges JOD with at most 2 decimals.',
    });
    expect(chargeDecimalsProblem('JPY', 2, 0)?.message).toBe(
      'The card payment method charges JPY with at most 0 decimals.',
    );
    expect(chargeDecimalsProblem('JOD', 2, 2)).toBeUndefined();
    expect(chargeDecimalsProblem('JOD', 3, undefined)).toBeUndefined();
  });
});

describe('rateMovedTooFar (decision 049)', () => {
  it('holds a move beyond the bound in either direction; exactly the bound passes', () => {
    // A rise is held above stored x 1.2; a fall below stored / 1.2 (0.92 / 1.2 = 0.7666...).
    expect(rateMovedTooFar('0.92000000', '1.10400000', 20)).toBe(false);
    expect(rateMovedTooFar('0.92000000', '1.10400001', 20)).toBe(true);
    expect(rateMovedTooFar('0.92000000', '0.76666667', 20)).toBe(false);
    expect(rateMovedTooFar('0.92000000', '0.76666666', 20)).toBe(true);
    expect(rateMovedTooFar('0.92000000', '0.92000000', 1)).toBe(false);
  });

  it('judges a fall like a rise at a high bound', () => {
    expect(rateMovedTooFar('0.92000000', '1.84000000', 100)).toBe(false);
    expect(rateMovedTooFar('0.92000000', '1.84000001', 100)).toBe(true);
    expect(rateMovedTooFar('0.92000000', '0.46000000', 100)).toBe(false);
    expect(rateMovedTooFar('0.92000000', '0.45999999', 100)).toBe(true);
    expect(rateMovedTooFar('48.50000000', '0.485', 20)).toBe(true);
    expect(rateMovedTooFar('48.50000000', '0.485', 100)).toBe(true);
  });

  it('keeps precision on large rates', () => {
    expect(rateMovedTooFar('9999999999.99999999', '9999999999.99999999', 1)).toBe(false);
    // 1500.12345678 x 1.2 = 1800.148148136
    expect(rateMovedTooFar('1500.12345678', '1800.14814813', 20)).toBe(false);
    expect(rateMovedTooFar('1500.12345678', '1800.14814814', 20)).toBe(true);
  });
});

describe('heldRateMessage (decision 049)', () => {
  const again = 'Confirm a rate to offer the currency again.';

  it('shows both rates, the move the decision judged and the bound', () => {
    expect(heldRateMessage('30.90000000', '47.10000000', 20)).toBe(
      `Held: the provider sent 47.1000 against the stored 30.9000, moved by 52.4 %, beyond the 20 % allowed. ${again}`,
    );
    expect(heldRateMessage('0.92000000', '1.2', 20)).toBe(
      `Held: the provider sent 1.2000 against the stored 0.9200, moved by 30.4 %, beyond the 20 % allowed. ${again}`,
    );
  });

  it('judges a rise just beyond the bound by the larger rate over the smaller one', () => {
    // 1.12 / 0.92 = 1.2173...: 21.7 %.
    expect(rateMovedTooFar('0.92000000', '1.12', 20)).toBe(true);
    expect(heldRateMessage('0.92000000', '1.12', 20)).toBe(
      `Held: the provider sent 1.1200 against the stored 0.9200, moved by 21.7 %, beyond the 20 % allowed. ${again}`,
    );
  });

  it('judges a fall just beyond the bound by the same ratio, not by the share of the stored rate it lost', () => {
    // 0.79 to 0.65 lost 17.7 % of the stored rate but the ratio 0.79 / 0.65 = 1.2153... is 21.5 %: held at 20, shown as 21.5.
    expect(rateMovedTooFar('0.79000000', '0.65', 20)).toBe(true);
    expect(heldRateMessage('0.79000000', '0.65', 20)).toBe(
      `Held: the provider sent 0.6500 against the stored 0.7900, moved by 21.5 %, beyond the 20 % allowed. ${again}`,
    );
    expect(heldRateMessage('48.50000000', '0.485', 100)).toBe(
      `Held: the provider sent 0.4850 against the stored 48.5000, moved by 9900.0 %, beyond the 100 % allowed. ${again}`,
    );
  });

  it('never reads at or below the bound for a held rate, in either direction', () => {
    const figure = (message: string) => Number(/moved by ([\d.]+) %/.exec(message)![1]);
    // A move a hair beyond the bound rounds to the bound itself; the figure is rounded up instead.
    expect(heldRateMessage('0.92000000', '1.10400001', 20)).toContain('moved by 20.1 %, beyond the 20 % allowed');
    expect(heldRateMessage('0.92000000', '0.76666666', 20)).toContain('moved by 20.1 %, beyond the 20 % allowed');
    const cases: Array<[string, string, number]> = [
      ['0.92000000', '1.10400001', 20],
      ['0.92000000', '0.76666666', 20],
      ['0.79000000', '0.65', 20],
      ['0.92000000', '1.84000001', 100],
      ['0.92000000', '0.45999999', 100],
      ['1500.12345678', '1800.14814814', 20],
      ['0.92000000', '0.9293', 1],
      ['0.92000000', '0.9108', 1],
    ];
    for (const [stored, offered, bound] of cases) {
      expect(rateMovedTooFar(stored, offered, bound)).toBe(true);
      expect(figure(heldRateMessage(stored, offered, bound))).toBeGreaterThan(bound);
    }
  });
});

describe('isRateOffered (decision 049)', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  const hours = (n: number) => n * 3_600_000;

  it('always offers the base currency', () => {
    expect(isRateOffered('USD', now - hours(1000), now - hours(1), now, 48)).toBe(true);
  });

  it('drops a held rate and a rate older than the bound', () => {
    expect(isRateOffered('GBP', now - hours(1), now - hours(1), now, 48)).toBe(false);
    expect(isRateOffered('GBP', now - hours(48), null, now, 48)).toBe(true);
    expect(isRateOffered('GBP', now - hours(48) - 1, null, now, 48)).toBe(false);
    expect(isRateOffered('GBP', now - hours(49), null, now, 72)).toBe(true);
  });
});

describe('isRateStale with a hold (decision 049)', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);

  it('is true while a refresh holds the rate, never for the base currency', () => {
    expect(isRateStale('GBP', now - 60_000, now, now - 30_000)).toBe(true);
    expect(isRateStale('USD', now - 60_000, now, now - 30_000)).toBe(false);
    expect(isRateStale('GBP', now - 60_000, now, null)).toBe(false);
    expect(isRateStale('GBP', now - 60_000, now)).toBe(false);
  });
});
