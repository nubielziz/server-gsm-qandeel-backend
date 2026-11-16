// Country names of the storefront search (feature 29, plan section 4.2): the English name of a listing's ISO-2 country plus the
// everyday names visitors type (`uk`, `usa`, `uae`). Pure.
import { normaliseText } from './normalise';

/**
 * Names visitors type for a country beside its English name, normalised.
 *
 * Why: plan section 4.2: "uk unlock" and "usa iphone unlock" must find services whose listing says GB or US (golden cases 44, 52, 53),
 * though no title says "UK" or "USA".
 */
export const COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  GB: ['uk', 'britain', 'great britain', 'england', 'united kingdom'],
  US: ['usa', 'america', 'united states'],
  AE: ['uae', 'emirates'],
  SA: ['ksa', 'saudi'],
  KR: ['korea', 'south korea'],
  NL: ['holland'],
  CZ: ['czech'],
  TR: ['turkey', 'turkiye'],
  RU: ['russia'],
  VN: ['vietnam'],
  DE: ['deutschland'],
  CH: ['swiss'],
  NZ: ['nz'],
  AU: ['aus'],
};

const DISPLAY = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * The English name of a country.
 *
 * @param code an ISO-2 code (any case)
 * @returns the name (`United Kingdom`), or `null` for a code that names no region
 */
export function countryName(code: string): string | null {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  let name: string | undefined;
  try {
    name = DISPLAY.of(upper);
  } catch {
    return null;
  }
  return name === undefined || name === upper || name === 'Unknown Region' ? null : name;
}

/**
 * Every name a visitor may type for a country: the English name and the aliases, normalised.
 *
 * @param code the listing's ISO-2 code (or `''`)
 * @returns the names, deduplicated; empty for no country or an unknown code
 */
export function countryNames(code: string): string[] {
  const name = countryName(code);
  if (name === null) return [];
  const names = [normaliseText(name), ...(COUNTRY_ALIASES[code.trim().toUpperCase()] ?? [])];
  return [...new Set(names.filter((entry) => entry !== ''))];
}
