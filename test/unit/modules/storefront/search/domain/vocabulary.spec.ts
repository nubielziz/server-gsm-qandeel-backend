// Unit tests of the index vocabulary (feature 29, plan section 4.4).
import { describe, expect, it } from 'bun:test';
import { buildVocabulary } from '@src/modules/storefront/search/domain/vocabulary';

describe('buildVocabulary', () => {
  it('holds the words of titles, facts, country names, codes and synonym terms, normalised', () => {
    const words = buildVocabulary(
      [
        {
          title: 'AT&T iPhone 15 Unlock',
          brand: 'Apple',
          carrier: 'AT&T',
          networks: ['Cricket Wireless'],
          categoryName: 'Carrier unlock',
          countryNames: ['united states', 'usa'],
          codes: ['iphone15'],
        },
      ],
      ['network unlock'],
    );
    for (const word of [
      'att',
      'iphone',
      '15',
      'unlock',
      'apple',
      'cricket',
      'wireless',
      'carrier',
      'usa',
      'iphone15',
      'network',
    ]) {
      expect(words.has(word), word).toBe(true);
    }
    expect(words.has('cheap')).toBe(false);
  });
});
