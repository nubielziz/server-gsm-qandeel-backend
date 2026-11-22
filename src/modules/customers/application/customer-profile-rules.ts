// CustomerProfileRules: the country rules a profile edit shares between the staff edit and the customer's own edit (map domain I, stage 14).
import { Injectable } from '@nestjs/common';
import { type DbExecutor } from '../../../infra/db';
import { FALLBACK_CURRENCY, currencyCodeFor } from '../domain/country-currency';
import { currencyByCode, hasAnyCurrentTaxRate, hasCurrentTaxRate } from '../infra/foreign-reads.repository';
import { countryNotSupported } from './customer-errors';

/**
 * The rules of a customer's country.
 *
 * Why: ANSWERS customers Q8: a customer can only be given a country the storefront sells to (one with a current `tax_rates` row), and a
 * changed country re-derives the currency. Staff (`PATCH /admin/customers/:id`) and the customer (`PATCH /store/v1/me`) follow the same
 * two rules; they live here once. Decision 050: the checkout follows the same country rule.
 *
 * Side effects: reads only (`currencies`, `tax_rates`).
 */
@Injectable()
export class CustomerProfileRules {
  /**
   * Derives the currency code a customer of a country pays in.
   *
   * Why: ANSWERS customers Q8: the country's storefront currency (the table's code, when that currency is active and shown by
   * the store), else USD. `null` only when USD itself is missing from `currencies`, because the column is a foreign key to it.
   *
   * @param db the pool or the transaction to read with
   * @param country the ISO-2 country code
   * @returns the currency code, or `null` when not even USD exists
   */
  async currencyFor(db: DbExecutor, country: string): Promise<string | null> {
    const mapped = await currencyByCode(db, currencyCodeFor(country));
    if (mapped?.isStorefront && mapped.isActive) return mapped.code;
    return (await currencyByCode(db, FALLBACK_CURRENCY)) ? FALLBACK_CURRENCY : null;
  }

  /**
   * Refuses a country the storefront does not sell to.
   *
   * Why: ANSWERS customers Q8: only a country with a current `tax_rates` row is allowed, the list the store config serves.
   *
   * @param db the pool or the transaction to read with
   * @param country the ISO-2 country code
   * @param now the clock's time
   * @throws {AppError} `VALIDATION_FAILED` (422 on `country`: "Choose a country.")
   */
  async assertCountryAccepted(db: DbExecutor, country: string, now: Date): Promise<void> {
    if (!(await hasCurrentTaxRate(db, country, now))) throw countryNotSupported();
  }

  /**
   * Refuses a checkout for a country the shop has no tax window for.
   *
   * Why: decision 050: the tax of a checkout is the window of the declared country, so a country without one would be sold untaxed; the
   * refusal is the profile's own (ANSWERS customers Q8). A shop with no window in force accepts every country (no tax), as before.
   *
   * @param db the pool or the transaction to read with
   * @param country the ISO-2 country code, upper case
   * @param now the clock's time
   * @throws {AppError} `VALIDATION_FAILED` (422 on `country`, code `unsupported`, "Choose a country.")
   */
  async assertCheckoutCountry(db: DbExecutor, country: string, now: Date): Promise<void> {
    if (!(await hasAnyCurrentTaxRate(db, now))) return;
    await this.assertCountryAccepted(db, country, now);
  }
}
