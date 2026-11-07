// StorefrontMoney: the read-only money facts the storefront needs (feature 14a): the currencies it offers, the tax rate in force
// for a buyer's country and the B2C payment methods that are on. The shop prices and locks; this file only reads.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import {
  findCurrencyByCode,
  findOfferedCurrencies,
  findStorefrontGateways,
  findTaxWindow,
  findTaxWindowsInForce,
} from '../infra/storefront-money.repository';
import { BASE_CURRENCY } from '../domain/accounts';

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
}

/**
 * Reads currencies, tax windows and payment methods for the storefront.
 *
 * Why: the map's `GET /store/v1/config` lists "countries, currencies, tax and enabled payment methods", and a checkout locks the
 * tax rate and the exchange rate it reads here. The money module owns `currencies`, `tax_rates` and `payment_gateways`, so the
 * storefront and the checkout ask this class (decision 016) instead of reading those tables.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class StorefrontMoney {
  /**
   * Lists the currencies the storefront offers.
   *
   * @param db the database or a transaction
   * @returns the offered currencies by code
   */
  async currencies(db: DbExecutor): Promise<StorefrontCurrency[]> {
    return (await findOfferedCurrencies(db)).map(toCurrency);
  }

  /**
   * Finds one offered currency.
   *
   * @param db the database or a transaction
   * @param code the ISO code (any case)
   * @returns the currency, or `undefined` when it is unknown or not offered
   */
  async offered(db: DbExecutor, code: string): Promise<StorefrontCurrency | undefined> {
    const upper = code.toUpperCase();
    return (await findOfferedCurrencies(db)).map(toCurrency).find((currency) => currency.code === upper);
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
    const offered = (await findOfferedCurrencies(db)).map(toCurrency);
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
   * @param region the buyer's region; a regional window wins over the national one when both exist
   * @returns the window in force, or `undefined` when the country has none (no tax)
   */
  async taxInForce(db: DbExecutor, country: string, at: Date, region = ''): Promise<TaxInForce | undefined> {
    const upper = country.toUpperCase();
    const row =
      (region === '' ? undefined : await findTaxWindow(db, upper, region, at)) ??
      (await findTaxWindow(db, upper, '', at));
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
   * @param db the database or a transaction
   * @returns the active gateways meant for B2C or both audiences
   */
  async paymentMethods(db: DbExecutor): Promise<StorefrontPaymentMethod[]> {
    return (await findStorefrontGateways(db)).map((gateway) => ({
      code: gateway.code,
      name: gateway.name,
      supports3ds: gateway.supports3ds,
    }));
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
