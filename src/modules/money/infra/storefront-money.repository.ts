// Drizzle queries behind the storefront's money reads (feature 14a): the currencies the shop offers, the tax window in force for
// a country and the B2C payment gateways that are switched on. Read only; the admin routes have their own repositories.
import { and, asc, desc, eq, inArray, isNull, lte, gt, or } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Currency, type PaymentGateway, type TaxRate, currencies, paymentGateways, taxRates } from '../db/schema';

/**
 * Reads the currencies the storefront offers (`is_storefront` and `is_active`), by code.
 *
 * @param db the database or a transaction
 * @returns the offered currencies
 */
export async function findOfferedCurrencies(db: DbExecutor): Promise<Currency[]> {
  return db
    .select()
    .from(currencies)
    .where(and(eq(currencies.isStorefront, true), eq(currencies.isActive, true)))
    .orderBy(asc(currencies.code));
}

/**
 * Reads one currency by code, offered or not.
 *
 * @param db the database or a transaction
 * @param code the ISO code
 * @returns the row, or `undefined`
 */
export async function findCurrencyByCode(db: DbExecutor, code: string): Promise<Currency | undefined> {
  const [row] = await db.select().from(currencies).where(eq(currencies.code, code)).limit(1);
  return row;
}

/**
 * Reads the tax window of a country and region that is in force at a moment.
 *
 * @param db the database or a transaction
 * @param country the ISO-2 country
 * @param region the region (`''` for the whole country)
 * @param at the moment (the clock's time)
 * @returns the window whose `valid_from` is at most `at` and whose `valid_to` is empty or after it, or `undefined`
 */
export async function findTaxWindow(
  db: DbExecutor,
  country: string,
  region: string,
  at: Date,
): Promise<TaxRate | undefined> {
  const [row] = await db
    .select()
    .from(taxRates)
    .where(
      and(
        eq(taxRates.country, country),
        eq(taxRates.region, region),
        lte(taxRates.validFrom, at),
        or(isNull(taxRates.validTo), gt(taxRates.validTo, at)),
      ),
    )
    .orderBy(desc(taxRates.validFrom), desc(taxRates.id))
    .limit(1);
  return row;
}

/**
 * Reads every tax window in force at a moment.
 *
 * @param db the database or a transaction
 * @param at the moment (the clock's time)
 * @returns the windows by country then region
 */
export async function findTaxWindowsInForce(db: DbExecutor, at: Date): Promise<TaxRate[]> {
  return db
    .select()
    .from(taxRates)
    .where(and(lte(taxRates.validFrom, at), or(isNull(taxRates.validTo), gt(taxRates.validTo, at))))
    .orderBy(asc(taxRates.country), asc(taxRates.region), desc(taxRates.validFrom));
}

/**
 * Reads the payment gateways a storefront customer may be offered: active, for B2C or both audiences.
 *
 * @param db the database or a transaction
 * @returns the gateways by name
 */
export async function findStorefrontGateways(db: DbExecutor): Promise<PaymentGateway[]> {
  return db
    .select()
    .from(paymentGateways)
    .where(and(eq(paymentGateways.isActive, true), inArray(paymentGateways.audience, ['b2c', 'both'])))
    .orderBy(asc(paymentGateways.name), asc(paymentGateways.id));
}
