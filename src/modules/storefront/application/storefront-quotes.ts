// StorefrontQuotes: the one place that prices a service for the storefront (feature 14a). The public list and page show these
// prices and a checkout session locks them, so what the buyer saw is what the session charges.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { ClientGroupDirectory, RetailPrices, type SellableService, StorefrontServices } from '../../catalog';
import { StorefrontMoney, type StorefrontCurrency } from '../../money';
import { type Amounts, amountsOf, inCurrency, lockedFxRate, percentWire, retailNet } from '../domain/retail-quote';
import { listedServiceIds } from '../infra/listing.repository';

/** What a buyer's country and currency decide for every price of one request. */
export interface QuoteContext {
  /** The moment the prices are judged at (the injected clock). */
  readonly at: Date;
  /** The storefront's retail group, whose prices and floors count. */
  readonly retailGroupId: number;
  /** The country the tax is worked out for (ISO-2), or `null` when the buyer gave none (then no tax). */
  readonly taxCountry: string | null;
  /** The tax rate in percent with four decimals; `'0.0000'` when the country has no window in force. */
  readonly taxRatePercent: string;
  /** The label of the tax window (`'UK VAT'`), `''` when there is none. */
  readonly taxLabel: string;
  readonly currency: StorefrontCurrency;
  /** The exchange rate with the currency's markup, 8 decimals (units per USD). */
  readonly fxRate: string;
}

/** A service with its price for one unit. */
export interface PricedService {
  readonly service: SellableService;
  /** The retail net price of one unit in USD (never under the storefront floor). */
  readonly unitNet: Money;
}

/** The amounts of a purchase in USD and in the buyer's currency. */
export interface QuoteAmounts {
  readonly usd: Amounts;
  readonly display: Amounts;
}

/** What the buyer says about where they are and what they pay in. */
export interface QuoteInput {
  /** The buyer's ISO-2 country (upper case). */
  readonly country?: string | null;
  readonly region?: string | undefined;
  /** An ISO currency code; unset means the shop's default. */
  readonly currency?: string | null | undefined;
}

/**
 * Prices services for the storefront.
 *
 * Why: RESOLUTIONS b2c-7 and catalog-3, user rule 9: the price is the retail price staff set for the `b2c_retail` group, never
 * under the storefront floor, and the floor is the one `RetailPrices.quotes` works out (the function the console's listing admin
 * uses, so the console, the public list and the checkout never disagree); only services staff priced for that group, switched a
 * listing on for, and the catalog says may be sold have a price; tax is the window of the buyer's country at the moment; the
 * exchange rate is the currency's with its markup, locked on the session.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class StorefrontQuotes {
  constructor(
    private readonly groups: ClientGroupDirectory,
    private readonly retail: RetailPrices,
    private readonly services: StorefrontServices,
    private readonly money: StorefrontMoney,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Finds the retail group.
   *
   * @param db the database or a transaction
   * @returns its id, or `undefined` when the shop has no retail group (nothing can be priced)
   */
  async retailGroupId(db: DbExecutor): Promise<number | undefined> {
    return (await this.groups.findRetail(db))?.id;
  }

  /**
   * Loads what a buyer's country and currency decide.
   *
   * @param db the database or a transaction
   * @param retailGroupId the retail group (from {@link StorefrontQuotes.retailGroupId})
   * @param input the buyer's country, region and currency
   * @returns the context to price with
   * @throws {AppError} `VALIDATION_FAILED` on `currency` when the code is not offered, or when the shop offers no currency at all
   */
  async context(db: DbExecutor, retailGroupId: number, input: QuoteInput): Promise<QuoteContext> {
    const at = this.clock.now();
    const currency =
      input.currency === undefined || input.currency === null
        ? await this.money.defaultCurrency(db)
        : await this.money.offered(db, input.currency);
    if (!currency) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          {
            field: 'currency',
            code: 'not_offered',
            message: input.currency ? 'This currency is not offered.' : 'No currency is set up for the shop yet.',
          },
        ],
      });
    }
    const country = input.country?.toUpperCase() ?? null;
    const tax = country === null ? undefined : await this.money.taxInForce(db, country, at, input.region ?? '');
    return {
      at,
      retailGroupId,
      taxCountry: country,
      taxRatePercent: tax === undefined ? '0.0000' : percentWire(tax.ratePercent),
      taxLabel: tax?.label ?? '',
      currency,
      fxRate: lockedFxRate(currency.rateToBase, currency.markupPercent),
    };
  }

  /**
   * Finds the services the shop may sell to the public: sellable for the retail group and with a switched-on listing.
   *
   * Why: catalog-3 and the brief of feature 14a ("only listed ... with their `service_listings` row"): the public list, the
   * service page, the checkout and the pre-order IMEI check share this one rule, so a service staff switched off (or never
   * listed) cannot be bought by guessing its id.
   *
   * @param db the database or a transaction
   * @param serviceIds the services to look at
   * @param retailGroupId the retail group (from {@link StorefrontQuotes.retailGroupId})
   * @returns the services that are sellable and listed, by id (the others are absent)
   */
  async listedSellable(
    db: DbExecutor,
    serviceIds: readonly number[],
    retailGroupId: number,
  ): Promise<Map<number, SellableService>> {
    const sellable = await this.services.sellable(db, serviceIds, retailGroupId);
    const listed = await listedServiceIds(db, [...sellable.keys()]);
    return new Map([...sellable].filter(([id]) => listed.has(id)));
  }

  /**
   * Prices some services.
   *
   * @param db the database or a transaction
   * @param context the buyer's context
   * @param serviceIds the services to price
   * @returns the services that can be sold, are listed and have a retail price, by id (the others are absent)
   */
  async priced(
    db: DbExecutor,
    context: QuoteContext,
    serviceIds: readonly number[],
  ): Promise<Map<number, PricedService>> {
    const sellable = await this.listedSellable(db, serviceIds, context.retailGroupId);
    const quotes = await this.retail.quotes(db, [...sellable.keys()], context.at);
    const out = new Map<number, PricedService>();
    for (const [id, service] of sellable) {
      const quote = quotes.get(id);
      // Only a price staff set for the retail group is a retail price: without the row the shop would fall back to the B2B
      // base price, which is not something to sell to the public. A service archived since the sellable read has no quote.
      if (quote === undefined || quote.retailPrice === null) continue;
      out.set(id, { service, unitNet: retailNet(quote.retailPrice, quote.floor) });
    }
    return out;
  }

  /**
   * Prices one service.
   *
   * @param db the database or a transaction
   * @param context the buyer's context
   * @param serviceId the service
   * @returns the priced service, or `undefined` when it cannot be sold, is not listed or has no retail price
   */
  async price(db: DbExecutor, context: QuoteContext, serviceId: number): Promise<PricedService | undefined> {
    return (await this.priced(db, context, [serviceId])).get(serviceId);
  }

  /**
   * Works out the amounts of a purchase.
   *
   * @param context the buyer's context
   * @param unitNet the unit net price in USD
   * @param quantity the quantity
   * @returns the amounts in USD (what the session stores) and in the buyer's currency (what the buyer sees)
   */
  amounts(context: QuoteContext, unitNet: Money, quantity: number): QuoteAmounts {
    const usd = amountsOf(unitNet, quantity, context.taxRatePercent);
    return { usd, display: inCurrency(usd, context.fxRate, context.currency.decimals) };
  }
}
