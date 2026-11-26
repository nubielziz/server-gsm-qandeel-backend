// StorefrontCatalogService: the use cases of the public storefront catalog (feature 14a): the configuration, the list of service
// pages, one service page, the category menu and where an old address in another language leads (feature 30). Everything here is
// read only and public; it never exposes a cost, a supplier or a floor.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { ParsedFilter, ParsedListQuery, ResultOf } from '../../../common/contract';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { type SellableFilter, type ServiceType, StorefrontServices } from '../../catalog';
import { BASE_CURRENCY, StorefrontMoney } from '../../money';
import { PublicImages } from '../../platform';
import type { getLegacySlug } from '../contracts/legacy-slugs.contracts';
import type {
  getStoreConfig,
  listStoreCategories,
  listStoreServices,
  showStoreService,
  StorefrontPriceSchema,
} from '../contracts/storefront-public.contracts';
import type { LegacySlugKind, ServiceListing } from '../db/schema';
import { categorySlug } from '../domain/category-slug';
import { helpIdOfSlug } from '../domain/help-slug';
import { type PricedListing, applyPriceSort } from '../domain/price-sort';
import { SearchMatches } from '../search/application/search-matches';
import { SearchResolver } from '../search/application/search-resolver';
import { SearchTermsCounter } from '../search/application/search-terms-counter';
import { NO_FILTERS, type ResultFilters } from '../search/domain/filters';
import { findLegacySlug } from '../infra/legacy-slug.repository';
import {
  type ListingSort,
  allListings,
  findListedBySlug,
  findListedOfService,
  findServiceFaqs,
  listedServiceIds,
  pageListings,
} from '../infra/listing.repository';
import { CurrentLegalDocuments } from './legal-documents';
import { StorefrontPolicies } from './storefront-policies';
import { type PricedService, type QuoteContext, type QuoteInput, StorefrontQuotes } from './storefront-quotes';
import { lockedFxRate, percentWire } from '../domain/retail-quote';

type Price = z.output<typeof StorefrontPriceSchema>;
type ConfigBody = ResultOf<typeof getStoreConfig>;
type PageBody = ResultOf<typeof showStoreService>;
type CardBody = ResultOf<typeof listStoreServices>['rows'][number];
type CategoriesBody = ResultOf<typeof listStoreCategories>;
type LegacyBody = ResultOf<typeof getLegacySlug>;

/** The buyer's country, region and currency the list query carries beside its filters, and the price bounds. */
interface ListExtra {
  readonly buyerCountry?: string | undefined;
  readonly region?: string | undefined;
  readonly currency?: string | undefined;
  readonly minPrice?: string | undefined;
  readonly maxPrice?: string | undefined;
}

/** The sort keys of the public list: the listing columns and `relevance`, which only the search engine knows. */
export type ListSortField = ListingSort | 'relevance';

/** What the list route needs to know about who asks, for the search statistics (never stored as such: see `SearchTermsCounter`). */
export interface ListVisitor {
  readonly ip: string;
  readonly userAgent: string | undefined;
  readonly prefetch: boolean;
}

/** The answer of the list route: the page, the exact total, and what the search engine did when `q` was set. */
export interface ServiceListPage {
  rows: CardBody[];
  total: number;
  /** `typesense` or `fallback` when `q` was set; `undefined` otherwise. */
  engine?: 'typesense' | 'fallback';
  /** More than 1000 matched and a price sort or bound worked over the best 1000. */
  truncated?: boolean;
}

/** The most services a price sort or price bounds read from the search engine. */
const SEARCH_PRICE_READ = 1000;

/** The most categories the menu route returns. */
const MAX_CATEGORIES = 500;

/**
 * Takes the filters that are not listing columns (`type`, `categoryId`, `availability`) out of a list request.
 *
 * Why: they narrow the sellable service ids in the catalog (one query with the stock test), not the listing rows, so
 * `listWhere` must never see them (it would throw for a field with no listing column).
 *
 * @param filters the parsed filters
 * @returns the filters the listing query keeps and the narrowing for the catalog
 */
function splitFilters(filters: readonly ParsedFilter[]): { rest: ParsedFilter[]; narrow: SellableFilter } {
  const rest: ParsedFilter[] = [];
  const types: ServiceType[] = [];
  const categoryIds: number[] = [];
  const availability = new Set<string>();
  for (const filter of filters) {
    if (filter.field === 'type') types.push(...(filter.values as ServiceType[]));
    else if (filter.field === 'categoryId') categoryIds.push(...(filter.values as number[]));
    else if (filter.field === 'availability') for (const value of filter.values) availability.add(String(value));
    else rest.push(filter);
  }
  // Both values (or none) restrict nothing.
  const inStock = availability.size === 1 ? availability.has('in_stock') : undefined;
  return { rest, narrow: { types, categoryIds, inStock } };
}

/** The price block the wire shows: the buyer's currency, tax included in `gross`. */
function priceOf(context: QuoteContext, priced: PricedService, quotes: StorefrontQuotes): Price {
  const { display } = quotes.amounts(context, priced.unitNet, 1);
  return {
    currency: context.currency.code,
    fxRate: context.fxRate,
    net: display.net.toWire(),
    tax: display.tax.toWire(),
    gross: display.gross.toWire(),
    taxRate: context.taxRatePercent,
    taxCountry: context.taxCountry,
  };
}

/** One service page card. */
function cardOf(
  listing: ServiceListing,
  priced: PricedService,
  price: Price,
  inStock: boolean,
  imageUrl: string | null,
): CardBody {
  const { service } = priced;
  return {
    id: listing.serviceId,
    slug: listing.slug,
    title: listing.publicTitle,
    summary: listing.summary,
    brand: listing.brand,
    network: listing.carrier,
    country: listing.country,
    isFeatured: listing.isFeatured,
    type: service.type,
    deliveryTime: service.deliveryTime,
    category: {
      id: service.categoryId,
      slug: categorySlug({ id: service.categoryId, name: service.categoryName }),
      name: service.categoryName,
    },
    availability: inStock ? 'in_stock' : 'on_request',
    deliveryMinutes: service.slaMinutes,
    etaText: listing.etaText,
    listedAt: listing.listedAt?.toISOString() ?? null,
    imageUrl,
    price,
  };
}

/** The public path of a listing's picture, from the paths read for its page. */
function imageOf(listing: ServiceListing, urls: ReadonlyMap<number, string>): string | null {
  return listing.imageFileId === null ? null : (urls.get(listing.imageFileId) ?? null);
}

/**
 * Serves the public catalog.
 *
 * Why: the map's `GET /store/v1/config`, `GET /store/v1/services` and `GET /store/v1/services/:slug` (stage 14), the menu of
 * `GET /store/v1/categories` (feature 22) and `GET /store/v1/legacy-slugs/:kind/:slug` (feature 30, decision 039). A listing is
 * public only when it is switched on and its service is sellable and priced for the retail group (catalog-3, b2c-7); the price
 * is `StorefrontQuotes`' (so the checkout charges what was shown); no cost, supplier, floor or `locked` flag ever leaves. English
 * only (decision 039): a service has one listing, and the list, the page and the menu take no language.
 *
 * Side effects: none (reads only; nothing is cached, the routes send `Cache-Control` for the browser).
 */
@Injectable()
export class StorefrontCatalogService {
  constructor(
    private readonly db: DbService,
    private readonly quotes: StorefrontQuotes,
    private readonly services: StorefrontServices,
    private readonly money: StorefrontMoney,
    private readonly policies: StorefrontPolicies,
    private readonly legal: CurrentLegalDocuments,
    private readonly images: PublicImages,
    // Feature 29: with `q` the order and the match set come from the search engine.
    private readonly matches: SearchMatches,
    private readonly resolver: SearchResolver,
    private readonly terms: SearchTermsCounter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Builds the storefront configuration.
   *
   * @returns the currencies, tax windows, payment methods, policy switches and current legal documents
   */
  async config(): Promise<ConfigBody> {
    const db = this.db.db;
    const at = this.clock.now();
    const [currencies, taxRates, paymentMethods, policies, documents] = await Promise.all([
      this.money.currencies(db),
      this.money.taxRatesInForce(db, at),
      this.money.paymentMethods(db),
      this.policies.switches(db),
      this.legal.listCurrent(db),
    ]);
    return {
      baseCurrency: BASE_CURRENCY,
      currencies: currencies.map((currency) => ({
        code: currency.code,
        name: currency.name,
        decimals: currency.decimals,
        fxRate: lockedFxRate(currency.rateToBase, currency.markupPercent),
      })),
      taxRates: taxRates.map((rate) => ({
        country: rate.country,
        region: rate.region,
        ratePercent: percentWire(rate.ratePercent),
        taxType: rate.taxType,
        label: rate.label,
      })),
      paymentMethods,
      policies,
      legalDocuments: documents.map((doc) => ({
        type: doc.type,
        version: doc.version,
        effectiveFrom: doc.effectiveFrom?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Lists one page of service pages.
   *
   * Why: a request without a price bound or price sort is one SQL page (`pageListings`). One with `minPrice`, `maxPrice` or
   * `_sort=price` cannot be, because the price is worked out in code (`StorefrontQuotes`, so the filtered price is the shown and
   * the charged one): it reads every match (at most 10 000), prices them, keeps those inside the bounds, sorts by price and slices
   * the page itself, so `x-total-count` stays exact. With `q` (feature 29, B223) the match set and the order come from the search
   * engine (typos, synonyms, model codes), every hit re-checked against Postgres and priced here; a price sort or bounds then
   * work over the best 1000 matches. When the engine is off, down or not ready, the database search above answers as before
   * (decision 038's fallback).
   *
   * @param query the parsed list request (filters, search, sort, range, buyer country, currency and price bounds)
   * @param visitor who asks, for the search statistics (absent for internal callers: nothing is counted)
   * @param options `engine: 'skip'` keeps the engine out (the results route already asked it and fell back)
   * @returns the page, the exact total, and which engine answered when `q` was set
   * @throws {AppError} `VALIDATION_FAILED` on `currency` when it is not offered; on `maxPrice` when it is below `minPrice`
   */
  async list(
    query: ParsedListQuery<ListSortField, ListExtra>,
    visitor?: ListVisitor,
    options: { readonly engine?: 'try' | 'skip' } = {},
  ): Promise<ServiceListPage> {
    const db = this.db.db;
    const { minPrice, maxPrice } = query.extra;
    const min = minPrice === undefined ? undefined : Money.of(minPrice);
    const max = maxPrice === undefined ? undefined : Money.of(maxPrice);
    if (min && max && min.cmp(max) > 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'maxPrice', code: 'invalid', message: 'The highest price is below the lowest price.' }],
      });
    }
    const retailGroupId = await this.quotes.retailGroupId(db);
    if (retailGroupId === undefined) return { rows: [], total: 0 };
    const context = await this.quotes.context(db, retailGroupId, buyerOf(query.extra));
    // `relevance` names the search engine's order: the database path has no column for it and keeps the staff's order.
    const sqlQuery: ParsedListQuery<ListingSort, ListExtra> = {
      ...query,
      sort: query.sort.filter((key): key is { field: ListingSort; order: 'asc' | 'desc' } => key.field !== 'relevance'),
    };
    const searched = query.search !== undefined;
    if (searched && options.engine !== 'skip') {
      const answered = await this.listFromEngine(query, context, min, max);
      if (answered !== null) {
        await this.countSearch(query, visitor, answered.total);
        return answered;
      }
    }
    const page = await this.listFromDatabase(sqlQuery, context, retailGroupId, min, max);
    if (!searched) return page;
    await this.countSearch(query, visitor, page.total);
    return { ...page, engine: 'fallback' };
  }

  /** The database list: SQL for the page, or every match priced in code for a price sort or bounds. */
  private async listFromDatabase(
    query: ParsedListQuery<ListingSort, ListExtra>,
    context: QuoteContext,
    retailGroupId: number,
    min: Money | undefined,
    max: Money | undefined,
  ): Promise<ServiceListPage> {
    const db = this.db.db;
    const { rest, narrow } = splitFilters(query.filters);
    const ids = await this.services.priced(db, retailGroupId, narrow);
    const listQuery = { ...query, filters: rest };

    if (!min && !max && !query.sort.some((key) => key.field === 'price')) {
      const { rows, total } = await pageListings(db, ids, listQuery);
      return { rows: await this.cards(context, rows), total };
    }

    const all = await allListings(db, ids, listQuery);
    const priced = await this.quotes.priced(db, context, [...new Set(all.map((row) => row.serviceId))]);
    const items = all.flatMap((listing): PricedListing[] => {
      const found = priced.get(listing.serviceId);
      if (found === undefined) return [];
      const gross = this.quotes.amounts(context, found.unitNet, 1).display.gross;
      return (!min || gross.cmp(min) >= 0) && (!max || gross.cmp(max) <= 0) ? [{ listing, gross }] : [];
    });
    const ordered = applyPriceSort(items, query.sort);
    const page = ordered.slice(query.range.start, query.range.start + query.range.limit);
    return { rows: await this.cards(context, page), total: ordered.length };
  }

  /**
   * The list from the search engine, or `null` when the engine did not answer (the caller falls back to the database).
   *
   * Side effects: engine calls; reads only in Postgres.
   */
  private async listFromEngine(
    query: ParsedListQuery<ListSortField, ListExtra>,
    context: QuoteContext,
    min: Money | undefined,
    max: Money | undefined,
  ): Promise<ServiceListPage | null> {
    const db = this.db.db;
    const priceMode = min !== undefined || max !== undefined || query.sort.some((key) => key.field === 'price');
    const sort = query.sort.flatMap((key) => (key.field === 'price' ? [] : [{ field: key.field, order: key.order }]));
    const outcome = await this.matches.find({
      route: 'services',
      q: query.search!.text,
      filters: resultFiltersOf(query.filters),
      sort: sort.length > 0 ? sort : [{ field: 'relevance', order: 'desc' }],
      offset: query.range.start,
      limit: query.range.limit,
      readAll: priceMode,
      extras: false,
    });
    if (outcome.engine === 'fallback' || outcome.value === null) return null;
    const { found, ids } = outcome.value;
    const hits = await this.resolver.resolve(db, context, ids);
    const pricedById = new Map(hits.map((hit) => [hit.listing.serviceId, hit.priced]));
    if (!priceMode) {
      const dropped = new Set(ids).size - hits.length;
      const rows = await this.cards(
        context,
        hits.map((hit) => hit.listing),
        pricedById,
      );
      return { rows, total: Math.max(rows.length, found - dropped), engine: 'typesense', truncated: false };
    }
    const items = hits.flatMap((hit): PricedListing[] => {
      const gross = this.quotes.amounts(context, hit.priced.unitNet, 1).display.gross;
      return (!min || gross.cmp(min) >= 0) && (!max || gross.cmp(max) <= 0) ? [{ listing: hit.listing, gross }] : [];
    });
    const ordered = applyPriceSort(items, query.sort);
    const page = ordered.slice(query.range.start, query.range.start + query.range.limit);
    return {
      rows: await this.cards(context, page, pricedById),
      total: ordered.length,
      engine: 'typesense',
      truncated: found > SEARCH_PRICE_READ,
    };
  }

  /** Counts a search for the statistics (page 1, no filter but `q`; see `SearchTermsCounter`); never fails the request. */
  private async countSearch(
    query: ParsedListQuery<ListSortField, ListExtra>,
    visitor: ListVisitor | undefined,
    total: number,
  ): Promise<void> {
    if (visitor === undefined || query.search === undefined) return;
    const filtered =
      query.filters.length > 0 || query.extra.minPrice !== undefined || query.extra.maxPrice !== undefined;
    await this.terms.recordSearch({
      text: query.search.text,
      total,
      firstPage: query.range.start === 0,
      filtered,
      ...visitor,
    });
  }

  /**
   * Lists the categories of the storefront menu with their counts.
   *
   * Why: the menu, the tiles and the sidebar need the categories and how many services each holds (feature 22). The count is the
   * services with a switched-on page that the catalog says may be sold and has priced: the same set `GET /store/v1/services` lists,
   * so a category's count equals the list total filtered by it.
   *
   * @returns the categories in category order, at most 500
   */
  async categories(): Promise<CategoriesBody> {
    const db = this.db.db;
    const retailGroupId = await this.quotes.retailGroupId(db);
    if (retailGroupId === undefined) return { categories: [] };
    const ids = await this.services.priced(db, retailGroupId);
    const listed = await listedServiceIds(db, ids);
    const rows = await this.services.categoriesOf(db, [...listed]);
    return {
      categories: rows.slice(0, MAX_CATEGORIES).map((row) => ({
        id: row.id,
        slug: categorySlug(row),
        name: row.name,
        type: row.type,
        serviceCount: row.serviceCount,
      })),
    };
  }

  /**
   * Prices a page of listings and builds the cards (one batched stock query, one batched picture query); a listing that lost its price
   * is left out.
   *
   * @param context the buyer's pricing context
   * @param rows the listings, in the order to show
   * @param prepriced prices the caller already worked out (the search's re-check); read here when absent
   * @returns the cards
   */
  async cards(
    context: QuoteContext,
    rows: readonly ServiceListing[],
    prepriced?: ReadonlyMap<number, PricedService>,
  ): Promise<CardBody[]> {
    const db = this.db.db;
    const serviceIds = rows.map((row) => row.serviceId);
    const [priced, inStock, images] = await Promise.all([
      prepriced ?? this.quotes.priced(db, context, serviceIds),
      this.services.inStockIds(db, serviceIds),
      this.images.urlsOf(
        db,
        rows.map((row) => row.imageFileId),
      ),
    ]);
    return rows.flatMap((row) => {
      const found = priced.get(row.serviceId);
      return found === undefined
        ? []
        : [cardOf(row, found, priceOf(context, found, this.quotes), inStock.has(row.serviceId), imageOf(row, images))];
    });
  }

  /**
   * Reads one service page.
   *
   * @param slug the page slug
   * @param buyer the buyer's country, region and currency
   * @returns the page with its fields, quantities, FAQs and price
   * @throws {AppError} `NOT_FOUND` when there is no such switched-on page or its service cannot be sold; `VALIDATION_FAILED`
   *   on `currency` when it is not offered
   */
  async page(slug: string, buyer: QuoteInput): Promise<PageBody> {
    const db = this.db.db;
    const notFound = () => new AppError('NOT_FOUND', { detail: 'This service page does not exist.' });
    const retailGroupId = await this.quotes.retailGroupId(db);
    if (retailGroupId === undefined) throw notFound();
    const listing = await findListedBySlug(db, slug);
    if (!listing) throw notFound();
    const context = await this.quotes.context(db, retailGroupId, buyer);
    const priced = await this.quotes.price(db, context, listing.serviceId);
    if (!priced) throw notFound();
    const [fields, faqs, inStock, images] = await Promise.all([
      this.services.fields(db, listing.serviceId),
      findServiceFaqs(db, listing.serviceId),
      this.services.inStockIds(db, [listing.serviceId]),
      this.images.urlsOf(db, [listing.imageFileId]),
    ]);
    return {
      ...cardOf(
        listing,
        priced,
        priceOf(context, priced, this.quotes),
        inStock.has(listing.serviceId),
        imageOf(listing, images),
      ),
      descriptionMd: listing.descriptionMd,
      requirementsMd: listing.requirementsMd,
      seoTitle: listing.seoTitle,
      seoDescription: listing.seoDescription,
      quantity: {
        min: priced.service.minQty,
        max: priced.service.maxQty,
        options: [...priced.service.qtyOptions],
      },
      // Decision 070: the order form draws only these fields. On an IMEI service the buyer types the IMEI into the one flagged as the
      // main input (decision 065), so it is listed with the flag, never left out.
      fields: fields.map((field) => ({
        key: field.key,
        label: field.label,
        fieldType: field.fieldType,
        options: [...field.options],
        required: field.required,
        isMainInput: field.isMainInput,
      })),
      faqs: faqs.map((faq) => ({ question: faq.question, answerMd: faq.answerMd })),
    };
  }

  /**
   * Tells where an old address in another language leads now.
   *
   * Why: decision 039 (plan 30 section 4.5): every address of the website under the retired second-language prefix answers 308 to the same path under `/en`; when
   * that path names a service, page or help article that existed only in another language, the English page finds nothing and
   * asks here. A service leads to its page when that page answers now (switched on, sellable and priced: the rule of
   * {@link StorefrontCatalogService.page}), else to the list; an old page has no English twin and leads to the home page; an old
   * help article to the help centre. Paths carry no language prefix, like notification links.
   *
   * @param kind `service`, `page` or `help`
   * @param slug the old slug; for `help` only the id that starts it counts (as `GET /store/v1/help/:slug` reads it)
   * @returns the path to send the reader on to, and the slug of the service page when there is one
   * @throws {AppError} `NOT_FOUND` (404) when the address was never retired, or a help slug does not start with an id
   */
  async legacyAddress(kind: LegacySlugKind, slug: string): Promise<LegacyBody> {
    const db = this.db.db;
    const notFound = () => new AppError('NOT_FOUND', { detail: 'No old address is known by this name.' });
    const key = kind === 'help' ? helpIdOfSlug(slug) : slug;
    if (key === undefined) throw notFound();
    const row = await findLegacySlug(db, kind, String(key));
    if (!row) throw notFound();
    if (kind === 'page') return { path: '/', slug: null };
    if (kind === 'help') return { path: '/help', slug: null };
    const listing = row.serviceId === null ? undefined : await this.listingOnSale(row.serviceId);
    return listing ? { path: `/services/${listing.slug}`, slug: listing.slug } : { path: '/services', slug: null };
  }

  /** The service's switched-on listing when its page answers now (sellable and priced for the retail group); `undefined` otherwise. */
  private async listingOnSale(serviceId: number): Promise<ServiceListing | undefined> {
    const db = this.db.db;
    const retailGroupId = await this.quotes.retailGroupId(db);
    if (retailGroupId === undefined) return undefined;
    const listing = await findListedOfService(db, serviceId);
    if (!listing) return undefined;
    return (await this.quotes.onSale(db, [serviceId], retailGroupId)).has(serviceId) ? listing : undefined;
  }
}

/** The list request's filters as the search engine takes them. */
function resultFiltersOf(filters: readonly ParsedFilter[]): ResultFilters {
  const texts = (field: string) =>
    filters.filter((filter) => filter.field === field).flatMap((filter) => filter.values.map(String));
  const availability = texts('availability').filter(
    (value): value is 'in_stock' | 'on_request' => value === 'in_stock' || value === 'on_request',
  );
  const featured = texts('featured')[0];
  return {
    ...NO_FILTERS,
    brand: texts('brand'),
    network: texts('network'),
    country: texts('country'),
    category: texts('categoryId').map(Number),
    type: texts('type'),
    availability,
    featured: featured === undefined ? undefined : featured === 'true',
  };
}

/** The buyer's country, region and currency from the `extra` parameters. */
function buyerOf(extra: ListExtra): QuoteInput {
  return { country: extra.buyerCountry ?? null, region: extra.region, currency: extra.currency };
}
