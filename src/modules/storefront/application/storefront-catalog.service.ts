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
   * the page itself, so `x-total-count` stays exact.
   *
   * @param query the parsed list request (filters, search, sort, range, buyer country, currency and price bounds)
   * @returns the page and the exact total
   * @throws {AppError} `VALIDATION_FAILED` on `currency` when it is not offered; on `maxPrice` when it is below `minPrice`
   */
  async list(query: ParsedListQuery<ListingSort, ListExtra>): Promise<{ rows: CardBody[]; total: number }> {
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
   */
  private async cards(context: QuoteContext, rows: readonly ServiceListing[]): Promise<CardBody[]> {
    const db = this.db.db;
    const serviceIds = rows.map((row) => row.serviceId);
    const [priced, inStock, images] = await Promise.all([
      this.quotes.priced(db, context, serviceIds),
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

/** The buyer's country, region and currency from the `extra` parameters. */
function buyerOf(extra: ListExtra): QuoteInput {
  return { country: extra.buyerCountry ?? null, region: extra.region, currency: extra.currency };
}
