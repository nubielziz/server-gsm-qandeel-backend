// StorefrontMoney: the read-only money facts the storefront needs (feature 14a): the currencies it offers, the tax rate in force
// for a buyer's country and the B2C payment methods that are on. The shop prices and locks; this file only reads.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { DbExecutor } from '../../../infra/db';
import { FX_GUARD_SETTINGS, PublicImages, SettingsReader } from '../../platform';
import type { Currency } from '../db/schema';
import { isRateOffered } from '../domain/currency-rules';
import { normalizeTaxRegion } from '../domain/tax-rate-rules';
import {
  findCurrencyByCode,
  findOfferedCurrencies,
  findStorefrontGateways,
  findTaxRegionsInForce,
  findTaxWindow,
  findTaxWindowsInForce,
} from '../infra/storefront-money.repository';
import { BASE_CURRENCY } from '../domain/accounts';
import { driverFor } from '../infra/gateway-drivers/drivers';
import type { ShopCurrencyReads } from '../ports/shop-currency-reads';

/** A currency the storefront can show and charge in. */
export interface StorefrontCurrency {
  readonly code: string;
  readonly name: string;
  /** Units of this currency per 1 USD, as the database prints it (8 decimals). */
  readonly rateToBase: string;
  /** The exchange markup percent (0 to 10), as the database prints it (4 decimals). */
  readonly markupPercent: string;
  /** Fraction digits the currency shows (0 to 4). */
  readonly decimals: number;
}

/** The tax window in force for a country. */
export interface TaxInForce {
  readonly country: string;
  readonly region: string;
  /** The percent as the database prints it (`'20.0000'`). */
  readonly ratePercent: string;
  readonly taxType: string;
  readonly label: string;
  readonly ossScheme: string;
}

/** A payment method the storefront may offer. */
export interface StorefrontPaymentMethod {
  readonly code: string;
  readonly name: string;
  readonly supports3ds: boolean;
  /** The ready-made method it was made from (feature 32), `null` for a custom method. */
  readonly preset: string | null;
  /** The public path of the logo staff uploaded (`/store/v1/media/<name>`), `null` when none. */
  readonly logoUrl: string | null;
}

/**
 * Reads currencies, tax windows and payment methods for the storefront.
 *
 * Why: the map's `GET /store/v1/config` lists "countries, currencies, tax and enabled payment methods", and a checkout locks the
 * tax rate and the exchange rate it reads here. The money module owns `currencies`, `tax_rates` and `payment_gateways`, so the
 * storefront and the checkout ask this class (decision 016) instead of reading those tables. Decision 049: a currency whose rate is held
 * or older than `fx.max_rate_age_hours` is not offered; a session that locked a rate keeps it (`byCode`). It also answers the
 * `ShopCurrencyReads` seam of identity's account writes (bound in `MoneyModule`).
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class StorefrontMoney implements ShopCurrencyReads {
  /**
   * @param clock the clock the age of a rate is measured with (decision 031)
   * @param images the public pictures, to turn a method's uploaded logo into its public path. Optional because this class lives in the
   *   global `MoneyModule`, which an app built without a database also loads (its `FilesModule` is left out there); no route reads
   *   `paymentMethods` in such an app.
   * @param settings the settings reader, for `fx.max_rate_age_hours`; optional for the same reason as `images`: without it the default
   *   age bound applies
   */
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly images?: PublicImages,
    @Optional() private readonly settings?: SettingsReader,
  ) {}

  /**
   * Lists the currencies the storefront offers now.
   *
   * @param db the database or a transaction
   * @returns the offered currencies by code (a held or too old rate is left out, decision 049)
   */
  async currencies(db: DbExecutor): Promise<StorefrontCurrency[]> {
    return (await this.offeredNow(db)).map(toCurrency);
  }

  /**
   * Finds one offered currency.
   *
   * @param db the database or a transaction
   * @param code the ISO code (any case)
   * @returns the currency, or `undefined` when it is unknown, not offered, or its rate is held or too old (decision 049)
   */
  async offered(db: DbExecutor, code: string): Promise<StorefrontCurrency | undefined> {
    const upper = code.toUpperCase();
    return (await this.offeredNow(db)).map(toCurrency).find((currency) => currency.code === upper);
  }

  /**
   * Finds a currency by code whether or not the shop offers it today.
   *
   * Why: a session locked a currency and a rate; when staff switch the currency off later the buyer's own session must still be
   * shown in it.
   *
   * @param db the database or a transaction
   * @param code the ISO code
   * @returns the currency, or `undefined` when no such row exists
   */
  async byCode(db: DbExecutor, code: string): Promise<StorefrontCurrency | undefined> {
    const row = await findCurrencyByCode(db, code.toUpperCase());
    return row === undefined ? undefined : toCurrency(row);
  }

  /**
   * Picks the currency to use when the buyer named none: the base currency when it is offered, else the first offered one,
   * else the base currency row even if it is not offered (a shop that offers nothing still sells in USD).
   *
   * @param db the database or a transaction
   * @returns the default currency, or `undefined` when no currency table row exists at all
   */
  async defaultCurrency(db: DbExecutor): Promise<StorefrontCurrency | undefined> {
    const offered = (await this.offeredNow(db)).map(toCurrency);
    const base = offered.find((currency) => currency.code === BASE_CURRENCY);
    if (base) return base;
    if (offered[0]) return offered[0];
    const row = await findCurrencyByCode(db, BASE_CURRENCY);
    return row ? toCurrency(row) : undefined;
  }

  /**
   * Finds the tax window of a country at a moment.
   *
   * @param db the database or a transaction
   * @param country the buyer's ISO-2 country
   * @param at the moment (the injected clock's time)
   * @param region the buyer's region, in any case (compared trimmed and in upper case, as it is stored); a regional window wins over the
   *   national one when both exist
   * @returns the window in force, or `undefined` when the country has none (no tax)
   */
  async taxInForce(db: DbExecutor, country: string, at: Date, region = ''): Promise<TaxInForce | undefined> {
    const upper = country.toUpperCase();
    const key = normalizeTaxRegion(region);
    const row =
      (key === '' ? undefined : await findTaxWindow(db, upper, key, at)) ?? (await findTaxWindow(db, upper, '', at));
    return row === undefined
      ? undefined
      : {
          country: row.country,
          region: row.region,
          ratePercent: row.ratePercent,
          taxType: row.taxType,
          label: row.label,
          ossScheme: row.ossScheme,
        };
  }

  /**
   * Tells whether a buyer's region settles the tax of a country at a moment.
   *
   * Why: a country staff tax by region has no one rate for the whole country. While one of its regional windows is in force, the tax of a
   * checkout is the window of the buyer's region, so the region must be one that has a window in force (staff give a region without tax a
   * 0 % window); the national window alone does not settle it. Regions compare trimmed and in upper case, as they are stored.
   *
   * @param db the database or a transaction
   * @param country the buyer's ISO-2 country
   * @param region the buyer's region, or `undefined` when none was named
   * @param at the moment (the injected clock's time)
   * @returns true when the country has no regional window in force, or the region has one
   */
  async taxRegionAccepted(db: DbExecutor, country: string, region: string | undefined, at: Date): Promise<boolean> {
    const regions = await findTaxRegionsInForce(db, country.toUpperCase(), at);
    return regions.length === 0 || regions.includes(normalizeTaxRegion(region ?? ''));
  }

  /**
   * Lists every tax window in force at a moment.
   *
   * @param db the database or a transaction
   * @param at the moment (the injected clock's time)
   * @returns the windows by country then region (a country without one has no tax)
   */
  async taxRatesInForce(db: DbExecutor, at: Date): Promise<TaxInForce[]> {
    return (await findTaxWindowsInForce(db, at)).map((row) => ({
      country: row.country,
      region: row.region,
      ratePercent: row.ratePercent,
      taxType: row.taxType,
      label: row.label,
      ossScheme: row.ossScheme,
    }));
  }

  /**
   * Lists the payment methods a storefront customer may be offered.
   *
   * Why: plan 21 defect D6: the checkout and `/store/v1/config` offered every active B2C gateway, while `/pay` refuses a manual gateway and
   * one without a driver; only gateways `/pay` accepts are listed now (manual ones are for store balance top-ups).
   *
   * @param db the database or a transaction
   * @returns the active, automatic gateways with a driver, meant for B2C or both audiences, each with its `preset` and the `logoUrl` of an
   *   uploaded logo (feature 32; a ready-made automatic method cannot be added yet, so a custom one is the usual case)
   */
  async paymentMethods(db: DbExecutor): Promise<StorefrontPaymentMethod[]> {
    const payable = (await findStorefrontGateways(db)).filter(
      (gateway) => !gateway.isManual && driverFor(gateway.driver) !== undefined,
    );
    const logos =
      (await this.images?.urlsOf(
        db,
        payable.map((gateway) => gateway.logoFileId),
      )) ?? new Map<number, string>();
    return payable.map((gateway) => ({
      code: gateway.code,
      name: gateway.name,
      supports3ds: gateway.supports3ds,
      preset: gateway.preset,
      logoUrl: logos.get(gateway.logoFileId ?? 0) ?? null,
    }));
  }

  /** The currencies the shop may charge in now: offered by staff, with a rate that is not held and not older than the bound (decision 049). */
  private async offeredNow(db: DbExecutor): Promise<Currency[]> {
    const spec = FX_GUARD_SETTINGS.maxRateAgeHours;
    const maxAge = this.settings ? await this.settings.integer(spec.key, spec.fallback, spec) : spec.fallback;
    const nowMs = this.clock.nowMs();
    return (await findOfferedCurrencies(db)).filter((row) =>
      isRateOffered(row.code, row.rateUpdatedAt.getTime(), row.rateHeldAt?.getTime() ?? null, nowMs, maxAge),
    );
  }
}

function toCurrency(row: {
  code: string;
  name: string;
  rateToBase: string;
  markupPercent: string;
  decimals: number;
}): StorefrontCurrency {
  return {
    code: row.code,
    name: row.name,
    rateToBase: row.rateToBase,
    markupPercent: row.markupPercent,
    decimals: row.decimals,
  };
}
