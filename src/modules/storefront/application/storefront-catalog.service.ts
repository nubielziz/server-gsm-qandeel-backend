// StorefrontCatalogService: the use cases of the public storefront catalog (feature 14a): the configuration, the list of service
// pages and one service page. Everything here is read only and public; it never exposes a cost, a supplier or a floor.
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
import type {
  getStoreConfig,
  listStoreCategories,
  listStoreServices,
  showStoreService,
  StorefrontPriceSchema,
} from '../contracts/storefront-public.contracts';
import type { ServiceListing } from '../db/schema';
import { categorySlug } from '../domain/category-slug';
import { type PricedListing, applyPriceSort } from '../domain/price-sort';
import { SearchMatches } from '../search/application/search-matches';
import { SearchResolver } from '../search/application/search-resolver';
import { SearchTermsCounter } from '../search/application/search-terms-counter';
import { NO_FILTERS, type ResultFilters } from '../search/domain/filters';
import {
  type ListingSort,
  DEFAULT_LOCALE,
  allListings,
  findListedBySlug,
  findServiceFaqs,
  findSiblingSlugs,
  listedServiceIdsIn,
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
  /** `typesense` or `fallback` when `q` was set on an English list; `undefined` otherwise. */
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
  const arabic = listing.locale === 'ar' && service.categoryNameAr !== '';
  return {
    id: listing.serviceId,
    slug: listing.slug,
    locale: listing.locale as 'en' | 'ar',
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
      name: arabic ? service.categoryNameAr : service.categoryName,
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
 * Why: the map's `GET /store/v1/config`, `GET /store/v1/services` and `GET /store/v1/services/:slug` (stage 14). A listing is
 * public only when it is switched on and its service is sellable and priced for the retail group (catalog-3, b2c-7); the price
 * is `StorefrontQuotes`' (so the checkout charges what was shown); no cost, supplier, floor or `locked` flag ever leaves.
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
    // Feature 29: with `q` on an English list the order and the match set come from the search engine.
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
        locale: doc.locale,
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
   * the page itself, so `x-total-count` stays exact. With `q` on an English list (feature 29, B223) the match set and the order come
   * from the search engine (typos, synonyms, model codes, pins), every hit re-checked against Postgres and priced here; a price sort or
   * bounds then work over the best 1000 matches. When the engine is off, down or not ready, and for `locale=ar`, the database search
   * above answers as before.
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
    const englishSearch = query.search !== undefined && englishOnly(query.filters);
    if (englishSearch && options.engine !== 'skip') {
      const answered = await this.listFromEngine(query, context, min, max);
      if (answered !== null) {
        await this.countSearch(query, visitor, answered.total);
        return answered;
      }
    }
    const page = await this.listFromDatabase(sqlQuery, context, retailGroupId, min, max);
    if (!englishSearch) return page;
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
      query.filters.some((filter) => filter.field !== 'locale') ||
      query.extra.minPrice !== undefined ||
      query.extra.maxPrice !== undefined;
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
   * services with a switched-on page in the language that the catalog says may be sold and has priced: the same set
   * `GET /store/v1/services` lists, so a category's count equals the list total filtered by it.
   *
   * @param locale the language
   * @returns the categories in category order, at most 500
   */
  async categories(locale: string): Promise<CategoriesBody> {
    const db = this.db.db;
    const language = locale === 'ar' ? 'ar' : 'en';
    const retailGroupId = await this.quotes.retailGroupId(db);
    if (retailGroupId === undefined) return { locale: language, categories: [] };
    const ids = await this.services.priced(db, retailGroupId);
    const listed = await listedServiceIdsIn(db, ids, language);
    const rows = await this.services.categoriesOf(db, [...listed]);
    return {
      locale: language,
      categories: rows.slice(0, MAX_CATEGORIES).map((row) => ({
        id: row.id,
        slug: categorySlug(row),
        name: language === 'ar' && row.nameAr !== '' ? row.nameAr : row.name,
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
   * @param locale the language (default `en`)
   * @param buyer the buyer's country, region and currency
   * @returns the page with its fields, quantities, FAQs, price and the other languages' pages of the same service
   * @throws {AppError} `NOT_FOUND` when there is no such switched-on page or its service cannot be sold; `VALIDATION_FAILED`
   *   on `currency` when it is not offered
   */
  async page(slug: string, locale: string | undefined, buyer: QuoteInput): Promise<PageBody> {
    const db = this.db.db;
    const notFound = () => new AppError('NOT_FOUND', { detail: 'This service page does not exist.' });
    const retailGroupId = await this.quotes.retailGroupId(db);
    if (retailGroupId === undefined) throw notFound();
    const language = locale ?? DEFAULT_LOCALE;
    const listing = await findListedBySlug(db, language, slug);
    if (!listing) throw notFound();
    const context = await this.quotes.context(db, retailGroupId, buyer);
    const priced = await this.quotes.price(db, context, listing.serviceId);
    if (!priced) throw notFound();
    const [fields, faqs, alternates, inStock, images] = await Promise.all([
      this.services.fields(db, listing.serviceId),
      findServiceFaqs(db, listing.serviceId, language),
      findSiblingSlugs(db, listing.serviceId, language),
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
      fields: fields.map((field) => ({
        key: field.key,
        label: field.label,
        fieldType: field.fieldType,
        options: [...field.options],
        required: field.required,
      })),
      faqs: faqs.map((faq) => ({ question: faq.question, answerMd: faq.answerMd })),
      alternates: alternates.map((alternate) => ({ locale: alternate.locale as 'en' | 'ar', slug: alternate.slug })),
    };
  }
}

/** Whether a list request asks for English pages (the language the search engine holds): no `locale` filter, or `locale=en`. */
function englishOnly(filters: readonly ParsedFilter[]): boolean {
  const locale = filters.find((filter) => filter.field === 'locale');
  return locale === undefined || locale.values.every((value) => value === 'en');
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
