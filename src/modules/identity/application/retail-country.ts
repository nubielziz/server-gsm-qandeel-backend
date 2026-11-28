// The country rule of a retail account (decision 064, ANSWERS customers Q8; decision 079): while the shop has tax windows in force a retail
// account may only have a country of one of them; while it has none, any real country (`common/countries.ts`). Its currency follows from
// that country. One copy of the rule for the staff writes (`ClientDetailsEditor`: the create and the edit of an account), the shop's
// sign-up and the finish of a sign-up (decision 079).
import { isCountryCode } from '../../../common/countries';
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import type { ShopCurrencyReads } from '../../money/ports/shop-currency-reads';
import { FALLBACK_CURRENCY, currencyCodeFor } from '../domain/account-rules';

/**
 * Refuses a country the shop does not sell to.
 *
 * Why: ANSWERS customers Q8: a retail account can only be given a country with a current tax rate (the list the store config serves); the
 * staff create and edit of a retail account, the shop's sign-up and its finish apply the same rule. Decision 079 (the review's B1): a shop
 * with no tax window in force (production has none today) sells untaxed to every country, so any code of the static list is accepted then;
 * without that a shop with no tax rates could make no account at all.
 *
 * @param money the seam to the shop's tax windows
 * @param db the database or a transaction
 * @param country the upper-case ISO 3166 alpha-2 code
 * @param now the time from the injected clock
 * @throws {AppError} `VALIDATION_FAILED` (422 on `country`, code `unsupported`: "Choose a country.")
 */
export async function assertRetailCountry(
  money: ShopCurrencyReads,
  db: DbExecutor,
  country: string,
  now: Date,
): Promise<void> {
  const windows = await money.taxRatesInForce(db, now);
  const wanted = country.toUpperCase();
  if (windows.length === 0 ? isCountryCode(wanted) : windows.some((window) => window.country === wanted)) return;
  const message = 'Choose a country.';
  throw new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ field: 'country', code: 'unsupported', message }],
  });
}

/**
 * Derives the currency code a retail account of a country pays in.
 *
 * @param money the seam to the shop's currencies
 * @param db the database or a transaction
 * @param country the upper-case ISO 3166 alpha-2 code
 * @returns the country's shop currency when the shop offers it, else USD; `null` only when USD itself is missing (the column is a foreign key)
 */
export async function retailCurrencyFor(
  money: ShopCurrencyReads,
  db: DbExecutor,
  country: string,
): Promise<string | null> {
  const wanted = currencyCodeFor(country.toUpperCase());
  if (await money.offered(db, wanted)) return wanted;
  return (await money.byCode(db, FALLBACK_CURRENCY)) ? FALLBACK_CURRENCY : null;
}
