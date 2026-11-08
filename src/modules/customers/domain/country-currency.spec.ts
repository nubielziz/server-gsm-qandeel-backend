// Unit tests of the currency a customer pays in, by country.
import { describe, expect, it } from 'bun:test';
import { COUNTRY_CURRENCY, FALLBACK_CURRENCY, currencyCodeFor } from './country-currency';

describe('currencyCodeFor', () => {
  it('follows the demo’s storefront countries', () => {
    expect(currencyCodeFor('GB')).toBe('GBP');
    for (const country of ['DE', 'FR', 'NL', 'IE', 'ES', 'IT']) expect(currencyCodeFor(country)).toBe('EUR');
    expect(currencyCodeFor('SE')).toBe('SEK');
    expect(currencyCodeFor('CA')).toBe('CAD');
    expect(currencyCodeFor('AE')).toBe('AED');
    expect(currencyCodeFor('SA')).toBe('SAR');
    expect(Object.keys(COUNTRY_CURRENCY)).toHaveLength(12);
  });

  it('falls back to the base currency for a country the storefront has no entry for', () => {
    expect(currencyCodeFor('JO')).toBe(FALLBACK_CURRENCY);
    expect(currencyCodeFor('')).toBe('USD');
  });
});
