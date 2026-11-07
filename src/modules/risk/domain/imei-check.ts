// The pure rules of the storefront IMEI check (feature 14a, stage 14): how an IMEI is hashed and what a check without a supplier
// lookup knows. No database.
import { isValidImei, normalizeImei } from '../../orders';

/** The encryption context of `imei_checks.imei_enc` (decision 019: `<table>.<column>`). */
export const IMEI_CHECK_AAD = 'imei_checks.imei_enc';

/**
 * The text that is hashed to find a check of the same IMEI again: the IMEI behind a prefix.
 *
 * Why: `imei_hash` is the keyed hash of decision 019 (`TokenService.hash`); the prefix keeps it apart from session, API key and
 * inventory-code hashes, so an IMEI can never collide with a credential. The check, the retention job and the account erasure all
 * use this function.
 *
 * @param imei the 15 digits
 * @returns the text to pass to `TokenService.hash`
 */
export function imeiHashInput(imei: string): string {
  return `imei:${imei}`;
}

/** The result of reading what the buyer typed. */
export type ImeiReading = { readonly ok: true; readonly imei: string; readonly tac: string } | { readonly ok: false };

/**
 * Reads a typed IMEI: spaces and dashes are removed, the checksum must hold.
 *
 * Why: RESOLUTIONS b2c-3 and the brief: "Luhn checksum plus the TAC". The TAC is the first 8 digits.
 *
 * @param text the IMEI as typed
 * @returns the 15 digits and the TAC, or `ok: false` when the length, the digits or the Luhn check digit are wrong
 */
export function readImei(text: string): ImeiReading {
  const imei = normalizeImei(text);
  return isValidImei(imei) ? { ok: true, imei, tac: imei.slice(0, 8) } : { ok: false };
}

/**
 * What a stage-14 check records in `imei_checks.result`.
 *
 * Why: the staff IMEI log shows `result` as is (RULES risk): it says which stage ran and what it found, so a reader can tell a
 * check that only verified the number from one that asked a supplier (stage 18).
 *
 * @param knownTac whether the TAC is in the catalogue
 * @returns the JSON object
 */
export function basicResult(knownTac: boolean): Record<string, string> {
  return { stage: 'basic', checksum: 'valid', tac: knownTac ? 'known' : 'unknown' };
}

/**
 * Reads the country a trusted proxy reports for the visitor.
 *
 * Why: RESOLUTIONS b2c-3: `imei_checks.country` is, in this order, the linked checkout's tax country, the known customer's
 * country, the proxy's country header (optional config `GEOIP_COUNTRY_HEADER`), else null. A free check has no checkout and no
 * signed-in customer, so the header is what is left. Only a two-letter value counts (Cloudflare writes `XX` and `T1` for unknown
 * and Tor: `XX` and `T1` are refused).
 *
 * @param value the header value, if the header is configured and present
 * @returns the upper-case ISO-2 country, or `null`
 */
export function countryFromHeader(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  const country = text?.trim().toUpperCase();
  if (country === undefined || !/^[A-Z]{2}$/.test(country) || country === 'XX' || country === 'T1') return null;
  return country;
}
