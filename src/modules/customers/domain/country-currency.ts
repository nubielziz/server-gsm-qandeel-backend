// The currency a storefront customer pays in, by country (customers.md POST and PATCH: "create and a country change derive the
// code from the country"). The map follows the demo's storefront countries; the server decides, the console only names them.

/**
 * The currency of each country the storefront sells to.
 *
 * Why: RESOLUTIONS b2c-1: a customer's `currency` is derived from the country, never typed. Same table as the demo's
 * `B2C_COUNTRIES` (09-b2c-data.js). A country that is not here pays in the base currency.
 */
export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  GB: 'GBP',
  DE: 'EUR',
  FR: 'EUR',
  NL: 'EUR',
  IE: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  SE: 'SEK',
  US: 'USD',
  CA: 'CAD',
  AE: 'AED',
  SA: 'SAR',
};

/** The currency of a country with no entry in {@link COUNTRY_CURRENCY}: the ledger's base currency. */
export const FALLBACK_CURRENCY = 'USD';

/**
 * Names the currency code a customer of a country pays in.
 *
 * @param country an upper-case ISO 3166 alpha-2 code (or `''` for unknown)
 * @returns the currency code (not yet checked against the `currencies` table)
 */
export function currencyCodeFor(country: string): string {
  return COUNTRY_CURRENCY[country] ?? FALLBACK_CURRENCY;
}
