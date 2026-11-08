// Unit tests of the reading of Open Exchange Rates' `latest.json`.
import { describe, expect, it } from 'bun:test';
import { FxProviderUnavailableError } from '../domain/fx-provider';
import { parseLatest } from './open-exchange-rates.provider';

describe('parseLatest', () => {
  it('reads the rates as upper-case codes with exact text, leaving out unusable values', () => {
    const quote = parseLatest({ base: 'USD', timestamp: 1, rates: { gbp: 0.79, EUR: 0.92, AED: 0, SAR: 'x' } });
    expect([...quote.rates]).toEqual([
      ['GBP', '0.79000000'],
      ['EUR', '0.92000000'],
    ]);
  });

  it('accepts an answer without a base field (the free plan always answers USD)', () => {
    expect(parseLatest({ rates: { GBP: 0.8 } }).rates.get('GBP')).toBe('0.80000000');
  });

  it('refuses an answer that is not a rates object, or is against another base', () => {
    for (const bad of [null, 'text', 42, {}, { rates: null }, { rates: 'x' }, { base: 'EUR', rates: { GBP: 0.8 } }]) {
      expect(() => parseLatest(bad)).toThrow(FxProviderUnavailableError);
    }
  });
});
