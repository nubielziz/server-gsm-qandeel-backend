// The ranking parameters of the storefront search (feature 29, plan sections 5.2-5.4): what each Typesense search of a suggest or a results
// page asks for. Pure; every number lives here and nowhere else, so the golden set (`test/search/golden.test.ts`) tunes them in one
// place. The final values are recorded in the storefront README.
import type { MultiSearchRequest, SearchParams } from '../../../../infra/search';
import { hasDigit } from './normalise';

/** The services fields a query is matched against, in weight order (the digit-free copies carry the typo tolerance, step 0). */
export const SERVICES_QUERY_BY =
  'title,title_words,codes,joins,models,brand,carrier,networks,country_names,category,summary';
/** The weight of each field of {@link SERVICES_QUERY_BY}. */
export const SERVICES_QUERY_BY_WEIGHTS = '10,9,10,8,6,6,5,4,5,4,2';
/**
 * Typos per field for the services search: none on `title`, `codes`, `joins` and `models` (SM-A525F never finds SM-A526F), one on the
 * digit-free fields, two on `title_words`.
 */
export const SERVICES_NUM_TYPOS = '0,2,0,0,0,1,1,1,1,1,1';
/** The nearby search widens the digit-free fields to two typos; the fields that may hold a digit stay at none. */
export const NEARBY_NUM_TYPOS = '0,2,0,0,0,2,2,2,2,2,2';
/** Prefix matching per field: every field but the summary matches while typed (`a525`, `sm-g99`). */
export const SERVICES_PREFIX = 'true,true,true,true,true,true,true,true,true,true,false';
/** The fields whose `matched_tokens` the highlight and the did-you-mean read. */
export const HIGHLIGHT_FIELDS = 'title,title_words,brand,carrier,category,codes';
/** The relevance order: text match decides, then in stock, then popularity (plan section 5.2: no bucketing). */
export const RELEVANCE_SORT = '_text_match:desc,_eval(in_stock:true):desc,popularity:desc';
/** The facets of a suggest answer. */
export const SUGGEST_FACETS = 'brand_key,carrier_key,country,category_id';

/** The numbers the golden set may tune (plan section 8). */
export const RANKING = {
  /** Candidate tokens a prefix expands to (`max_candidates`). */
  maxCandidates: 16,
  /** Terms the completion search reads (the site shows at most 6; the rest are for the ghost). */
  termsPerPage: 10,
  /** Services a suggest shows. */
  suggestServices: 6,
  /** Nearby services read (the shown ones are what remains of {@link RANKING.suggestServices} after the services). */
  nearbyServices: 12,
  /** The suggest services search never drops words. */
  suggestDropTokens: 0,
  /** The nearby search drops words until this many results exist. */
  nearbyDropTokens: 6,
  /** The nearby search looks for typo variants until this many results exist. */
  nearbyTypoTokens: 6,
  /**
   * Typos allowed when a query is matched against a synonym phrase. Plan section 5.2 says 1; the golden set (case 44, `uk unlock`)
   * showed that one typo lets the query match the phrases `sim unlock` and `network unlock` through their first word, which drops the
   * `uk` constraint and returns every unlock service. A typo inside a synonym word is still found through the title fields.
   */
  synonymTypos: 0,
  /** The results page drops a word only when nothing matched. */
  resultsDropTokens: 1,
  /** The completion search never drops words (a completion starts with what was typed). */
  termsDropTokens: 0,
  /** How many ids a price sort or a price bound reads (4 pages of 250). */
  priceReadLimit: 1000,
  /** Ids per page of that read. */
  priceReadPage: 250,
} as const;

/** What every services search shares. */
function servicesBase(q: string): SearchParams {
  return {
    q,
    query_by: SERVICES_QUERY_BY,
    query_by_weights: SERVICES_QUERY_BY_WEIGHTS,
    num_typos: SERVICES_NUM_TYPOS,
    prefix: SERVICES_PREFIX,
    enable_typos_for_alpha_numerical_tokens: false,
    enable_typos_for_numerical_tokens: false,
    split_join_tokens: 'fallback',
    synonym_prefix: true,
    synonym_num_typos: RANKING.synonymTypos,
    max_candidates: RANKING.maxCandidates,
    prioritize_exact_match: true,
    // A pin never bypasses a filter (step 0: set on every rule, and passed on every search).
    filter_curated_hits: true,
    include_fields: 'id',
    highlight_fields: HIGHLIGHT_FIELDS,
  };
}

/**
 * The completion search: phrases that start with what was typed, one typo allowed, shorter phrases first on ties.
 *
 * @param collection the terms alias
 * @param p the normalised typed text without its trailing space
 * @returns the search
 */
export function termsSearch(collection: string, p: string): MultiSearchRequest {
  return {
    collection,
    q: p,
    query_by: 'q',
    prefix: true,
    // A phrase with a model code is never completed through a typo (SM-A525F never completes SM-A526F).
    num_typos: hasDigit(p) ? 0 : 1,
    max_candidates: RANKING.maxCandidates,
    drop_tokens_threshold: RANKING.termsDropTokens,
    per_page: RANKING.termsPerPage,
    sort_by: '_text_match:desc,weight:desc,length:asc',
    include_fields: 'q,kind',
  };
}

/**
 * The best phrase for a query nothing matched ("Did you mean"): two typos, no prefix.
 *
 * @param collection the terms alias
 * @param q the normalised query
 * @returns the search
 */
export function termsTypoSearch(collection: string, q: string): MultiSearchRequest {
  return {
    collection,
    q,
    query_by: 'q',
    prefix: false,
    num_typos: 2,
    drop_tokens_threshold: 0,
    per_page: 1,
    sort_by: '_text_match:desc,weight:desc,length:asc',
    include_fields: 'q',
  };
}

/**
 * The suggest services search: every word must match, typos only on the digit-free fields, popular and in-stock break exact ties.
 *
 * @param collection the services alias
 * @param q the normalised query
 * @returns the search (six services, the facets of the filter chips)
 */
export function suggestServicesSearch(collection: string, q: string): MultiSearchRequest {
  return {
    collection,
    ...servicesBase(q),
    drop_tokens_threshold: RANKING.suggestDropTokens,
    sort_by: RELEVANCE_SORT,
    facet_by: SUGGEST_FACETS,
    max_facet_values: 10,
    per_page: RANKING.suggestServices,
  };
}

/**
 * The nearby search: the same, but words are dropped and typo variants are looked for until there are results to show.
 *
 * @param collection the services alias
 * @param q the normalised query
 * @returns the search
 */
export function nearbyServicesSearch(collection: string, q: string): MultiSearchRequest {
  return {
    collection,
    ...servicesBase(q),
    num_typos: NEARBY_NUM_TYPOS,
    drop_tokens_threshold: RANKING.nearbyDropTokens,
    typo_tokens_threshold: RANKING.nearbyTypoTokens,
    sort_by: RELEVANCE_SORT,
    per_page: RANKING.nearbyServices,
  };
}

/** The results page's sorts as the engine knows them. */
export type EngineSort = 'relevance' | 'popular' | 'title' | 'listedAt' | 'featured' | 'sort';

/**
 * The `sort_by` of one sort key.
 *
 * Why: plan section 5.3: `popular` is popularity then text match; `title` and `listedAt` sort on `title_sort` and `listed_at`
 * (`featured` and `sort` are the list's own staff order). The engine takes at most three fields, so the tail is the relevance order
 * where it fits.
 *
 * @param field the sort
 * @param order the direction (relevance and popular ignore it)
 * @returns the piece of `sort_by`
 */
export function sortPiece(field: EngineSort, order: 'asc' | 'desc'): string {
  switch (field) {
    case 'relevance':
      return RELEVANCE_SORT;
    case 'popular':
      return 'popularity:desc,_text_match:desc';
    case 'title':
      return `title_sort:${order},popularity:desc`;
    case 'listedAt':
      return `listed_at:${order},popularity:desc`;
    case 'featured':
      return `featured:${order}`;
    case 'sort':
      return `sort:${order}`;
  }
}

/**
 * Joins the pieces of several sort keys into one `sort_by` of at most three fields.
 *
 * @param keys the sort keys in order
 * @returns the `sort_by` (the relevance order when there are none)
 */
export function sortBy(keys: ReadonlyArray<{ readonly field: EngineSort; readonly order: 'asc' | 'desc' }>): string {
  const fields: string[] = [];
  for (const key of keys) {
    for (const piece of sortPiece(key.field, key.order).split(',')) {
      const name = piece.split(':')[0];
      if (fields.length < 3 && !fields.some((existing) => existing.split(':')[0] === name)) fields.push(piece);
    }
  }
  return fields.length === 0 ? RELEVANCE_SORT : fields.join(',');
}

/** What a results-page search takes besides the query. */
export interface ResultsSearchOptions {
  readonly filterBy?: string;
  readonly sortBy: string;
  /** Hits to skip and to return (the page is `offset / limit + 1` for the results page). */
  readonly offset: number;
  readonly limit: number;
  /** The facets to count (none for a price read or an id read). */
  readonly facetBy?: string;
  /** Whether to read the highlight tokens (the did-you-mean needs them on page 1 only). */
  readonly highlight?: boolean;
}

/**
 * The results-page search over the services: search 2's parameters with the results drop-tokens number, filters, sort and facets.
 *
 * @param collection the services alias
 * @param q the normalised query
 * @param options filters, sort, window and facets
 * @returns the search
 */
export function resultsSearch(collection: string, q: string, options: ResultsSearchOptions): MultiSearchRequest {
  const base = servicesBase(q);
  return {
    collection,
    ...base,
    ...(options.highlight === false ? { highlight_fields: 'none' } : {}),
    drop_tokens_threshold: RANKING.resultsDropTokens,
    sort_by: options.sortBy,
    offset: options.offset,
    limit: options.limit,
    ...(options.filterBy ? { filter_by: options.filterBy } : {}),
    ...(options.facetBy ? { facet_by: options.facetBy, max_facet_values: 20 } : {}),
  };
}

/**
 * A search that only counts facets (no hits): the same query and filters, `per_page: 0`.
 *
 * Why: plan section 5.3: the counts of a facet group ignore that group's own selection, which takes one more search per group that has a
 * selected value; it carries no hits and no highlights.
 *
 * @param collection the services alias
 * @param q the normalised query
 * @param filter the `filter_by` (without the group's own selection)
 * @param facetBy the facet fields to count
 * @returns the search
 */
export function facetsOnlySearch(collection: string, q: string, filter: string, facetBy: string): MultiSearchRequest {
  return {
    collection,
    ...servicesBase(q),
    highlight_fields: 'none',
    drop_tokens_threshold: RANKING.resultsDropTokens,
    per_page: 0,
    ...(filter ? { filter_by: filter } : {}),
    facet_by: facetBy,
    max_facet_values: 20,
  };
}
