// Unit tests of the terms collection (feature 29, plan section 4.4): one document per phrase, the segment split, stop words, kind
// priority, weights, synonym phrases and the popular-query rule.
import { describe, expect, it } from 'bun:test';
import {
  MAX_WEIGHT,
  type PopularCandidate,
  type TermService,
  buildTerms,
  dayKey,
  dayOf,
  isPopularQuery,
  termId,
  termsSchema,
  titlePhrases,
} from '@src/modules/storefront/search/domain/terms';
import { buildVocabulary } from '@src/modules/storefront/search/domain/vocabulary';

const service = (over: Partial<TermService> = {}): TermService => ({
  title: 'Samsung FRP (1-24 hours)',
  popularity: 9,
  brand: 'Samsung',
  carrier: '',
  networks: [],
  categoryName: 'Remove FRP',
  countryName: '',
  ...over,
});

describe('titlePhrases', () => {
  it('cuts the title into segments before normalising, so no phrase crosses a bracket', () => {
    const phrases = titlePhrases('Samsung FRP (1-24 hours)');
    expect(phrases).toContain('samsung frp');
    expect(phrases).toContain('1-24 hours');
    expect(phrases.some((phrase) => phrase.startsWith('frp 1-24'))).toBe(false);
  });

  it('drops phrases that start or end with a stop word, one-character and digit-only phrases', () => {
    const phrases = titlePhrases('Unlock for the iPhone 15 - all models');
    expect(phrases).toContain('unlock');
    expect(phrases).toContain('iphone 15');
    expect(phrases).toContain('models');
    expect(phrases.filter((phrase) => /^(for|the|all) |(for|the|all)$/.test(phrase))).toEqual([]);
    expect(phrases).not.toContain('15');
    expect(phrases.some((phrase) => phrase.includes(' - '))).toBe(false);
  });
});

describe('buildTerms', () => {
  it('makes one document per phrase with the highest kind and weight of its sources', () => {
    const terms = buildTerms({
      services: [service(), service({ title: 'Samsung Network Unlock', popularity: 4, brand: 'SAMSUNG' })],
      synonyms: [],
      queries: [],
    });
    const byQ = new Map(terms.map((term) => [term.q, term]));
    expect(new Set(terms.map((term) => term.q)).size).toBe(terms.length);
    // "samsung" is a title phrase of both (10 + 5 = 15) and a brand of both (2 x 10 = 20): kind brand, weight 20.
    expect(byQ.get('samsung')).toMatchObject({ kind: 'brand', weight: 20, services: 2, length: 7 });
    expect(byQ.get('samsung frp')).toMatchObject({ kind: 'title', weight: 10, services: 1 });
    expect(byQ.get('remove frp')).toMatchObject({ kind: 'category', weight: 20 });
    expect(byQ.get('samsung frp')?.id).toBe(termId('samsung frp'));
  });

  it('gives a synonym phrase the weight of its best known term, or 10', () => {
    const terms = buildTerms({
      services: [service()],
      synonyms: [
        { terms: ['frp', 'google account lock'], root: null },
        { terms: ['knox guard', 'kg lock'], root: null },
      ],
      queries: [],
    });
    const byQ = new Map(terms.map((term) => [term.q, term]));
    expect(byQ.get('google account lock')).toMatchObject({ kind: 'synonym', weight: byQ.get('frp')!.weight });
    expect(byQ.get('frp')?.kind).toBe('title');
    expect(byQ.get('knox guard')).toMatchObject({ kind: 'synonym', weight: 10 });
  });

  it('weighs a popular query by its visitors and caps every weight', () => {
    const terms = buildTerms({
      services: [service({ popularity: MAX_WEIGHT })],
      synonyms: [],
      queries: [{ term: 'Samsung FRP bypass', visitors: 7 }],
    });
    const byQ = new Map(terms.map((term) => [term.q, term]));
    expect(byQ.get('samsung frp bypass')).toMatchObject({ kind: 'query', weight: 70 });
    expect(byQ.get('samsung frp')!.weight).toBe(MAX_WEIGHT);
  });

  it('uses facet values but never a country code', () => {
    const terms = buildTerms({
      services: [service({ countryName: 'United Kingdom', carrier: 'Vodafone', networks: ['EE'] })],
      synonyms: [],
      queries: [],
    });
    const qs = terms.map((term) => term.q);
    expect(qs).toEqual(expect.arrayContaining(['united kingdom', 'vodafone', 'ee']));
    expect(qs).not.toContain('gb');
  });

  it('has the fixed schema sorted by weight', () => {
    expect(termsSchema('p_terms_v1_20261116000000')).toMatchObject({ default_sorting_field: 'weight' });
  });
});

describe('isPopularQuery', () => {
  const vocabulary = buildVocabulary(
    [
      {
        title: 'Samsung FRP Bypass',
        brand: 'Samsung',
        carrier: '',
        networks: [],
        categoryName: 'FRP',
        countryNames: [],
        codes: [],
      },
    ],
    ['google account lock'],
  );
  const candidate = (over: Partial<PopularCandidate> = {}): PopularCandidate => ({
    term: 'samsung frp',
    visitors: 30,
    busyDays: 3,
    searches: 40,
    zeroResults: 0,
    ...over,
  });

  it('keeps a term of catalog words with 5 visitors on 3 days and few empty results', () => {
    expect(isPopularQuery(candidate(), vocabulary, new Set())).toBe(true);
    expect(isPopularQuery(candidate({ term: 'google account lock' }), vocabulary, new Set())).toBe(true);
  });

  it('refuses an injected phrase, too few busy days, mostly empty results, a hidden term and more than 4 words', () => {
    expect(isPopularQuery(candidate({ term: 'cheap unlock scam site' }), vocabulary, new Set())).toBe(false);
    expect(isPopularQuery(candidate({ busyDays: 2 }), vocabulary, new Set())).toBe(false);
    expect(isPopularQuery(candidate({ zeroResults: 20 }), vocabulary, new Set())).toBe(false);
    expect(isPopularQuery(candidate(), vocabulary, new Set(['samsung frp']))).toBe(false);
    expect(isPopularQuery(candidate({ term: 'samsung frp bypass samsung frp' }), vocabulary, new Set())).toBe(false);
  });
});

describe('dayKey and dayOf', () => {
  it('write the UTC day', () => {
    const at = new Date('2026-11-16T23:59:59.000Z');
    expect(dayKey(at)).toBe('20261116');
    expect(dayOf(at)).toBe('2026-11-16');
  });
});
