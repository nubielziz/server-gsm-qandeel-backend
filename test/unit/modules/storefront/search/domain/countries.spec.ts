// Unit tests of the country names of the search (feature 29, plan section 4.2).
import { describe, expect, it } from 'bun:test';
import { countryName, countryNames } from '@src/modules/storefront/search/domain/countries';

describe('countryNames', () => {
  it('gives the English name and the everyday aliases, normalised', () => {
    expect(countryNames('GB')).toEqual(['united kingdom', 'uk', 'britain', 'great britain', 'england']);
    expect(countryNames('us')).toEqual(['united states', 'usa', 'america']);
    expect(countryNames('AE')).toEqual(['united arab emirates', 'uae', 'emirates']);
    expect(countryNames('DZ')).toEqual(['algeria']);
  });

  it('is empty for no country or a code that names no region', () => {
    expect(countryNames('')).toEqual([]);
    expect(countryNames('ZZ')).toEqual([]);
    expect(countryName('X1')).toBeNull();
  });
});
