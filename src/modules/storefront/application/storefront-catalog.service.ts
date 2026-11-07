// StorefrontCatalogService: the use cases of the public storefront catalog (feature 14a): the configuration, the list of service
// pages and one service page. Everything here is read only and public; it never exposes a cost, a supplier or a floor.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { ParsedListQuery, ResultOf } from '../../../common/contract';
import { DbService } from '../../../infra/db';
import { StorefrontServices } from '../../catalog';
import { BASE_CURRENCY, StorefrontMoney } from '../../money';
import type {
  getStoreConfig,
  listStoreServices,
  showStoreService,
  StorefrontPriceSchema,
} from '../contracts/storefront-public.contracts';
import type { ServiceListing } from '../db/schema';
import {
  type ListingSort,
  DEFAULT_LOCALE,
  findListedBySlug,
  findServiceFaqs,
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

/** The buyer's country, region and currency the list query carries beside its filters. */
interface ListExtra {
  readonly buyerCountry?: string | undefined;
  readonly region?: string | undefined;
  readonly currency?: string | undefined;
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
function cardOf(listing: ServiceListing, priced: PricedService, price: Price): CardBody {
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
    type: priced.service.type,
    deliveryTime: priced.service.deliveryTime,
    price,
  };
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
   * @param query the parsed list request (filters, search, sort, range, buyer country and currency)
   * @returns the page and the exact total
   * @throws {AppError} `VALIDATION_FAILED` on `currency` when it is not offered
   */
  async list(query: ParsedListQuery<ListingSort, ListExtra>): Promise<{ rows: CardBody[]; total: number }> {
    const db = this.db.db;
    const retailGroupId = await this.quotes.retailGroupId(db);
    if (retailGroupId === undefined) return { rows: [], total: 0 };
    const context = await this.quotes.context(db, retailGroupId, buyerOf(query.extra));
    const ids = await this.services.priced(db, retailGroupId);
    const { rows, total } = await pageListings(db, ids, query);
    const priced = await this.quotes.priced(
      db,
      context,
      rows.map((row) => row.serviceId),
    );
    const cards = rows.flatMap((row) => {
      const found = priced.get(row.serviceId);
      return found === undefined ? [] : [cardOf(row, found, priceOf(context, found, this.quotes))];
    });
    return { rows: cards, total };
  }

  /**
   * Reads one service page.
   *
   * @param slug the page slug
   * @param locale the language (default `en`)
   * @param buyer the buyer's country, region and currency
   * @returns the page with its fields, quantities, FAQs and price
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
    const [fields, faqs] = await Promise.all([
      this.services.fields(db, listing.serviceId),
      findServiceFaqs(db, listing.serviceId, language),
    ]);
    return {
      ...cardOf(listing, priced, priceOf(context, priced, this.quotes)),
      descriptionMd: listing.descriptionMd,
      etaText: listing.etaText,
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
    };
  }
}

/** The buyer's country, region and currency from the `extra` parameters. */
function buyerOf(extra: ListExtra): QuoteInput {
  return { country: extra.buyerCountry ?? null, region: extra.region, currency: extra.currency };
}
