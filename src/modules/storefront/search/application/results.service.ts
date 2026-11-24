// ResultsService: the use case of `GET /store/v1/search` (feature 29, plan section 5.3): the results page of an English search. The engine
// gives the ids, the facet counts and the "did you mean"; Postgres re-checks every hit and prices it with the same code as the list.
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { ParsedFilter, ParsedListQuery, QueryOf } from '../../../../common/contract';
import { AppError } from '../../../../common/errors';
import { Money } from '../../../../common/money';
import { DbService } from '../../../../infra/db';
import { SearchMetrics } from '../../../../infra/search';
import {
  type ListSortField,
  type ListVisitor,
  StorefrontCatalogService,
} from '../../application/storefront-catalog.service';
import { StorefrontQuotes } from '../../application/storefront-quotes';
import { applyPriceSort, type PricedListing } from '../../domain/price-sort';
import type { searchStore } from '../contracts/store-search.contracts';
import type { FacetGroup, FacetValue } from '../domain/filters';
import { imeiIntent } from '../domain/imei-intent';
import { normaliseQuery } from '../domain/normalise';
import type { EngineSort } from '../domain/ranking';
import { SearchFacetLabels, type SearchLabels } from './facet-labels';
import { type Matches, SearchMatches } from './search-matches';
import { SearchResolver } from './search-resolver';
import { SearchTermsCounter } from './search-terms-counter';

type SearchQuery = QueryOf<typeof searchStore>;
type SearchPage = z.output<(typeof searchStore)['success']['schema']>;
type FallbackQuery = ParsedListQuery<ListSortField, FallbackExtra>;

interface FallbackExtra {
  readonly buyerCountry?: string | undefined;
  readonly region?: string | undefined;
  readonly currency?: string | undefined;
  readonly minPrice?: string | undefined;
  readonly maxPrice?: string | undefined;
}

/** The most services a price sort, price bounds or the price span read (the engine's four pages of 250). */
const PRICE_READ = 1000;
const SEARCH_FIELDS = ['title', 'summary', 'brand', 'network'] as const;

function capitalised(text: string): string {
  return text === '' ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * Serves the results page of the search.
 *
 * Why: decision 038: the page shows what Postgres allows (`SearchResolver`), priced by `StorefrontQuotes`, as the exact card of
 * `GET /store/v1/services` (`StorefrontCatalogService.cards`); facet counts and the "did you mean" are the engine's. On any engine failure
 * the answer is today's database search (`StorefrontCatalogService.list`) with `engine: 'fallback'` and no facets. A price sort or
 * price bounds work over the best 1000 matches (`truncated` says more matched).
 *
 * Side effects: reads only; engine calls; counts the search for the statistics when it is page 1 without filters
 * (`SearchTermsCounter`).
 *
 * @see GET /store/v1/search
 */
@Injectable()
export class ResultsService {
  constructor(
    private readonly db: DbService,
    private readonly matches: SearchMatches,
    private readonly resolver: SearchResolver,
    private readonly catalog: StorefrontCatalogService,
    private readonly quotes: StorefrontQuotes,
    private readonly labels: SearchFacetLabels,
    private readonly terms: SearchTermsCounter,
    private readonly metrics: SearchMetrics,
  ) {}

  /**
   * Answers one results request.
   *
   * @param query the validated query (filters, page, sort, buyer, price bounds)
   * @param visitor who asks, for the statistics
   * @returns the page
   * @throws {AppError} `VALIDATION_FAILED` on `maxPrice` below `minPrice` and on `currency` when it is not offered
   */
  async search(query: SearchQuery, visitor: ListVisitor): Promise<SearchPage> {
    const text = normaliseQuery(query.q);
    const base = { q: text, page: query.page, perPage: query.perPage };
    const min = query.minPrice === undefined ? undefined : Money.of(query.minPrice);
    const max = query.maxPrice === undefined ? undefined : Money.of(query.maxPrice);
    if (min && max && min.cmp(max) > 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'maxPrice', code: 'invalid', message: 'The highest price is below the lowest price.' }],
      });
    }
    if (imeiIntent(query.q) !== null) {
      // An IMEI is no search: nothing is counted or recorded (plan section 5.2).
      return {
        ...base,
        engine: this.matches.enabled ? 'typesense' : 'fallback',
        total: 0,
        truncated: false,
        hits: [],
        facets: null,
        priceRange: null,
        didYouMean: null,
        intent: 'imei',
      };
    }
    const priceMode = query.sort === 'price' || min !== undefined || max !== undefined;
    const order = query.order ?? (query.sort === 'listedAt' ? 'desc' : 'asc');
    const sortKey: EngineSort = query.sort === 'price' ? 'relevance' : query.sort;
    const outcome = await this.matches.find({
      route: 'results',
      q: query.q,
      filters: {
        brand: query.brand,
        network: query.network,
        country: query.country,
        category: query.categoryId,
        type: query.type,
        availability: query.availability === undefined ? [] : [query.availability],
        featured: query.featured,
      },
      sort: [{ field: sortKey, order }],
      offset: (query.page - 1) * query.perPage,
      limit: query.perPage,
      readAll: priceMode,
      extras: true,
    });
    let page: SearchPage;
    if (outcome.engine === 'fallback' || outcome.value === null) {
      page = await this.fallbackPage(query, base);
    } else {
      page = await this.enginePage(query, base, outcome.value, { min, max, priceMode, order });
    }
    if (page.total === 0) this.metrics.zeroResults.inc({ route: 'results' });
    const filtered =
      query.brand.length + query.network.length + query.country.length + query.categoryId.length + query.type.length >
        0 ||
      query.availability !== undefined ||
      query.featured !== undefined ||
      min !== undefined ||
      max !== undefined;
    // Never throws (a lost count is a lost statistic); awaited so the count is there when the answer is.
    await this.terms.recordSearch({
      text: query.q,
      total: page.total,
      firstPage: query.page === 1,
      filtered,
      ...visitor,
    });
    return page;
  }

  /** The database search, with the same filters, as the fallback. */
  private async fallbackPage(
    query: SearchQuery,
    base: { q: string; page: number; perPage: number },
  ): Promise<SearchPage> {
    const result = await this.catalog.list(fallbackQueryOf(query), undefined, { engine: 'skip' });
    return {
      ...base,
      engine: 'fallback',
      total: result.total,
      truncated: false,
      hits: result.rows,
      facets: null,
      priceRange: null,
      didYouMean: null,
      intent: null,
    };
  }

  /** The engine's answer, re-checked, priced and turned into cards. */
  private async enginePage(
    query: SearchQuery,
    base: { q: string; page: number; perPage: number },
    matches: Matches,
    options: { min: Money | undefined; max: Money | undefined; priceMode: boolean; order: 'asc' | 'desc' },
  ): Promise<SearchPage> {
    const db = this.db.db;
    const labels = await this.labels.read();
    const facets = matches.facets === null ? null : facetsOf(matches.facets, labels);
    const empty = {
      ...base,
      engine: 'typesense' as const,
      total: 0,
      truncated: false,
      hits: [],
      facets,
      priceRange: null,
      didYouMean: matches.didYouMean,
      intent: null,
    };
    const groupId = await this.quotes.retailGroupId(db);
    if (groupId === undefined) return empty;
    const context = await this.quotes.context(db, groupId, {
      country: query.buyerCountry ?? null,
      region: query.region,
      currency: query.currency,
    });
    // A search with at most 1000 matches knows every id (on any page): they are re-checked once and give the exact total, the
    // window of the page and (page 1) the price span.
    const universe = matches.allIds ?? matches.ids;
    const hits = await this.resolver.resolve(db, context, universe);
    const gross = (hit: (typeof hits)[number]) => this.quotes.amounts(context, hit.priced.unitNet, 1).display.gross;
    const pricedById = new Map(hits.map((hit) => [hit.listing.serviceId, hit.priced]));
    const start = (query.page - 1) * query.perPage;
    let priceRange: SearchPage['priceRange'] = null;
    // The price span is a page-1 field (plan section 5.3); a later page knows the ids too (for its offset) but does not report it.
    if (query.page === 1 && matches.allIds !== null && hits.length > 0) {
      const prices = hits.map(gross);
      priceRange = {
        min: prices.reduce((low, price) => (price.cmp(low) < 0 ? price : low)).toWire(),
        max: prices.reduce((high, price) => (price.cmp(high) > 0 ? price : high)).toWire(),
      };
    }
    if (!options.priceMode) {
      // With every id known (at most 1000 matches) `hits` is the whole result in the engine's order: the page is its window.
      // Otherwise `hits` is already the engine's own page.
      const shown = matches.allIds === null ? hits : hits.slice(start, start + query.perPage);
      const dropped = new Set(matches.ids).size - hits.length;
      const total = matches.allIds === null ? Math.max(shown.length, matches.found - dropped) : hits.length;
      return {
        ...empty,
        total,
        hits: await this.catalog.cards(
          context,
          shown.map((hit) => hit.listing),
          pricedById,
        ),
        priceRange,
      };
    }
    const items = hits.flatMap((hit): PricedListing[] => {
      const price = gross(hit);
      return (!options.min || price.cmp(options.min) >= 0) && (!options.max || price.cmp(options.max) <= 0)
        ? [{ listing: hit.listing, gross: price }]
        : [];
    });
    const sort: Array<{ field: string; order: 'asc' | 'desc' }> =
      query.sort === 'price' ? [{ field: 'price', order: options.order }] : [];
    const ordered = query.sort === 'price' ? applyPriceSort(items, sort) : items.map((item) => item.listing);
    return {
      ...empty,
      total: ordered.length,
      truncated: matches.found > PRICE_READ,
      hits: await this.catalog.cards(context, ordered.slice(start, start + query.perPage), pricedById),
      priceRange,
    };
  }
}

/** The engine's facet counts as the wire shows them: labels for brand and network, names for categories. */
function facetsOf(counts: Record<FacetGroup, FacetValue[]>, labels: SearchLabels): NonNullable<SearchPage['facets']> {
  const named = (values: readonly FacetValue[], map: ReadonlyMap<string, string>) =>
    values.map(({ value, count }) => ({ value: map.get(value) ?? capitalised(value), count }));
  const availability = { in_stock: 0, on_request: 0 };
  for (const { value, count } of counts.availability) {
    if (value === 'true') availability.in_stock = count;
    else if (value === 'false') availability.on_request = count;
  }
  return {
    brand: named(counts.brand, labels.brands),
    network: named(counts.network, labels.networks),
    country: counts.country,
    category: counts.category.flatMap(({ value, count }) => {
      const id = Number(value);
      const name = labels.categories.get(id);
      return name === undefined ? [] : [{ id, name, count }];
    }),
    type: counts.type,
    availability,
  };
}

/** The results query as a list request for the database search (the fallback). */
function fallbackQueryOf(query: SearchQuery): FallbackQuery {
  const filters: ParsedFilter[] = [];
  const add = (field: string, values: readonly (string | number | boolean)[]) => {
    if (values.length > 0) filters.push({ field, op: 'eq', values });
  };
  add('brand', query.brand);
  add('network', query.network);
  add('country', query.country);
  add('categoryId', query.categoryId);
  add('type', query.type);
  if (query.availability !== undefined) add('availability', [query.availability]);
  if (query.featured !== undefined) add('featured', [query.featured]);
  const order = query.order;
  const sort: FallbackQuery['sort'] =
    query.sort === 'relevance'
      ? [
          { field: 'featured', order: 'desc' },
          { field: 'sort', order: 'asc' },
          { field: 'title', order: 'asc' },
        ]
      : [
          {
            field: query.sort,
            order: order ?? (query.sort === 'popular' || query.sort === 'listedAt' ? 'desc' : 'asc'),
          },
        ];
  const start = (query.page - 1) * query.perPage;
  return {
    range: { start, end: start + query.perPage, limit: query.perPage },
    sort,
    filters,
    search: { text: query.q.trim(), fields: SEARCH_FIELDS },
    extra: {
      buyerCountry: query.buyerCountry,
      region: query.region,
      currency: query.currency,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
    },
  };
}
