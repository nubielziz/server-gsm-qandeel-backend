import { describe, expect, it } from 'bun:test';
import {
  NEARBY_NUM_TYPOS,
  RANKING,
  RELEVANCE_SORT,
  SERVICES_NUM_TYPOS,
  SERVICES_PREFIX,
  SERVICES_QUERY_BY,
  SERVICES_QUERY_BY_WEIGHTS,
  facetsOnlySearch,
  nearbyServicesSearch,
  resultsSearch,
  sortBy,
  sortPiece,
  suggestServicesSearch,
  termsSearch,
  termsTypoSearch,
} from '@src/modules/storefront/search/domain/ranking';

const fields = SERVICES_QUERY_BY.split(',');
const list = (text: string) => text.split(',');

describe('the services field lists', () => {
  it('give every field a weight, a typo count and a prefix flag', () => {
    expect(list(SERVICES_QUERY_BY_WEIGHTS)).toHaveLength(fields.length);
    expect(list(SERVICES_NUM_TYPOS)).toHaveLength(fields.length);
    expect(list(NEARBY_NUM_TYPOS)).toHaveLength(fields.length);
    expect(list(SERVICES_PREFIX)).toHaveLength(fields.length);
  });

  it('allow no typo on the fields that may hold a model code (SM-A525F never finds SM-A526F)', () => {
    for (const lists of [SERVICES_NUM_TYPOS, NEARBY_NUM_TYPOS]) {
      const typos = new Map(fields.map((field, index) => [field, Number(list(lists)[index])]));
      for (const field of ['title', 'codes', 'joins', 'models']) expect(typos.get(field), field).toBe(0);
      expect(typos.get('title_words')).toBe(2);
    }
  });

  it('prefix-match every field but the summary, so a model code matches while it is typed', () => {
    const prefix = new Map(fields.map((field, index) => [field, list(SERVICES_PREFIX)[index]]));
    expect(prefix.get('codes')).toBe('true');
    expect(prefix.get('summary')).toBe('false');
  });
});

describe('the searches', () => {
  it('keeps typos off numbers and asks for ids only; no curation parameter since decision 068', () => {
    for (const search of [
      suggestServicesSearch('c', 'samsung'),
      nearbyServicesSearch('c', 'samsung'),
      resultsSearch('c', 'samsung', { sortBy: RELEVANCE_SORT, offset: 0, limit: 24 }),
      facetsOnlySearch('c', 'samsung', '', 'brand_key'),
    ]) {
      expect(search).not.toHaveProperty('filter_curated_hits');
      expect(search.enable_typos_for_numerical_tokens).toBe(false);
      expect(search.include_fields).toBe('id');
      expect(search.collection).toBe('c');
    }
  });

  it('gives the suggest search no dropped words and the nearby search the widening numbers', () => {
    expect(suggestServicesSearch('c', 'q').drop_tokens_threshold).toBe(0);
    expect(suggestServicesSearch('c', 'q').per_page).toBe(6);
    const nearby = nearbyServicesSearch('c', 'q');
    expect(nearby).toMatchObject({
      drop_tokens_threshold: RANKING.nearbyDropTokens,
      typo_tokens_threshold: RANKING.nearbyTypoTokens,
      num_typos: NEARBY_NUM_TYPOS,
      per_page: 12,
    });
  });

  it('completes phrases with one typo, and none when the typed text holds a digit', () => {
    expect(termsSearch('t', 'samsng')).toMatchObject({ q: 'samsng', query_by: 'q', prefix: true, num_typos: 1 });
    expect(termsSearch('t', 'sm-a525')).toMatchObject({ num_typos: 0 });
    expect(termsSearch('t', 'iphone 15 p').num_typos).toBe(0);
    expect(termsSearch('t', 'x').sort_by).toBe('_text_match:desc,weight:desc,length:asc');
    expect(termsTypoSearch('t', 'zzz')).toMatchObject({ num_typos: 2, prefix: false, per_page: 1 });
  });

  it('puts the window, filters and facets of a results search on the request', () => {
    const search = resultsSearch('c', 'q', {
      sortBy: 'popularity:desc',
      offset: 24,
      limit: 24,
      filterBy: 'type:=[`imei`]',
      facetBy: 'brand_key',
    });
    expect(search).toMatchObject({
      offset: 24,
      limit: 24,
      filter_by: 'type:=[`imei`]',
      facet_by: 'brand_key',
      drop_tokens_threshold: RANKING.resultsDropTokens,
      sort_by: 'popularity:desc',
    });
    const quiet = resultsSearch('c', 'q', { sortBy: RELEVANCE_SORT, offset: 0, limit: 250, highlight: false });
    expect(quiet.highlight_fields).toBe('none');
    expect(quiet.filter_by).toBeUndefined();
    expect(facetsOnlySearch('c', 'q', '', 'brand_key')).toMatchObject({ per_page: 0, highlight_fields: 'none' });
  });
});

describe('sorting', () => {
  it('maps each sort to the engine fields', () => {
    expect(sortPiece('relevance', 'asc')).toBe(RELEVANCE_SORT);
    expect(sortPiece('popular', 'asc')).toBe('popularity:desc,_text_match:desc');
    expect(sortPiece('title', 'desc')).toBe('title_sort:desc,popularity:desc');
    expect(sortPiece('listedAt', 'desc')).toBe('listed_at:desc,popularity:desc');
  });

  it('joins keys into at most three engine fields without repeating one', () => {
    expect(
      sortBy([
        { field: 'relevance', order: 'desc' },
        { field: 'featured', order: 'desc' },
      ]),
    ).toBe(RELEVANCE_SORT);
    expect(
      sortBy([
        { field: 'featured', order: 'desc' },
        { field: 'sort', order: 'asc' },
        { field: 'title', order: 'asc' },
      ]),
    ).toBe('featured:desc,sort:asc,title_sort:asc');
    expect(sortBy([])).toBe(RELEVANCE_SORT);
    expect(
      sortBy([
        { field: 'popular', order: 'desc' },
        { field: 'relevance', order: 'desc' },
      ]).split(',').length,
    ).toBeLessThanOrEqual(3);
  });
});
