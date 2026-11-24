// Unit tests of the visitor-country header reader (decision 050).
import { describe, expect, it } from 'bun:test';
import { countryFromHeader } from '@src/modules/risk/domain/visitor-country';

describe('countryFromHeader', () => {
  it('accepts a two-letter country and upper-cases it', () => {
    expect(countryFromHeader('gb')).toBe('GB');
    expect(countryFromHeader(' US ')).toBe('US');
    expect(countryFromHeader(['de', 'fr'])).toBe('DE');
  });

  it('refuses anything else, including the proxy placeholders for unknown and Tor', () => {
    for (const bad of [undefined, '', 'GBR', 'G', '1A', 'XX', 'T1', 'g b'])
      expect(countryFromHeader(bad), String(bad)).toBeNull();
  });
});
