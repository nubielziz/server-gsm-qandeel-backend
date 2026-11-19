// Carrier and country detection of the shop naming (feature 31, plan section 3.5; A3 section 5): the first carrier an IMEI title
// names, and the one country the title, the group or the carriers settle. Pure; the country words are the search's English names
// (`countryNames`) read backwards plus the suppliers' own spellings.
import { countryNames } from '../../../search/domain/countries';
import { CARRIER_COUNTRIES, CARRIERS } from './lexicon/carriers';
import {
  COUNTRY_TRAPS,
  EXTRA_COUNTRY_WORDS,
  NO_SINGLE_COUNTRY,
  NOT_COUNTRY_CODES,
  SUPPORT_TRAP,
} from './lexicon/countries';
import { type NamingKind, isRouterCodeList } from './title-rules';

/** Where a service's country came from. */
export type CountrySource = 'name' | 'name_carrier' | 'group' | 'carrier' | 'multi' | 'none';

/** The carrier and country of one service. */
export interface DetectedGeo {
  /** The carrier named first in the title (or the group), IMEI services only; `null` for none. */
  readonly carrier: string | null;
  /** Every carrier named, in the order of the text. */
  readonly carriers: readonly string[];
  /** The ISO-2 country, or `null` when none or several. */
  readonly country: string | null;
  /** Where the country came from (`multi`: a list or `All Countries`, deliberately none). */
  readonly countrySource: CountrySource;
  /** Every country named in the title and the group, deduplicated (more than three is a multi-country list). */
  readonly countries: readonly string[];
}

/** A country word, its pattern and its code. */
interface CountryWord {
  readonly pattern: RegExp;
  readonly code: string;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The country words: every name `countryNames` gives for today's codes (two-letter aliases left out), then the extras. */
function buildCountryWords(): readonly CountryWord[] {
  const byWord = new Map<string, string>();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const first of letters) {
    for (const second of letters) {
      const code = first + second;
      if (NOT_COUNTRY_CODES.has(code)) continue;
      for (const name of countryNames(code)) {
        // A bare two-letter alias (`nz`) is a code, and only US, UK and JP are accepted as codes (A3 section 5.3).
        if (name.length > 2 && !byWord.has(name)) byWord.set(name, code);
      }
    }
  }
  for (const [word, code] of EXTRA_COUNTRY_WORDS) byWord.set(word.toLowerCase(), code);
  return [...byWord].map(([word, code]) => ({
    // A country word is whole: not glued to a letter, a digit or a dot before it (`SamsungTool.us`), nor to a letter or digit after.
    pattern: new RegExp(`(?<![A-Za-z0-9.])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'i'),
    code,
  }));
}

let countryWords: readonly CountryWord[] | undefined;

/**
 * Finds the countries a text names, in no particular order, each code once.
 *
 * Why: A3 sections 5.2-5.3: the traps are blanked first (`CDMA YEMEN`, `SamsungTool.us`, ...); a bare `US` counts only as a
 * whole capital word (or `Us ` at the start), a bare `JP` only as `JP -` at the start.
 *
 * @param text a title or group text (already cleared of the "supported" phrases by the caller)
 * @returns the ISO-2 codes found
 */
export function detectCountries(text: string): string[] {
  countryWords ??= buildCountryWords();
  let t = text;
  for (const trap of COUNTRY_TRAPS) t = t.replace(trap, ' ');
  const codes = new Set<string>();
  for (const { pattern, code } of countryWords) if (pattern.test(t)) codes.add(code);
  if (!codes.has('US') && /(?:^|[\s([-])US(?=[\s\-)\]/]|$)/i.test(t) && (/\bUS\b/.test(t) || /^Us /.test(t)))
    codes.add('US');
  if (!codes.has('JP') && /^JP\s*-/.test(t)) codes.add('JP');
  return [...codes];
}

/** The carriers an IMEI text names, ordered by where they are named. */
function namedCarriers(text: string): { readonly name: string; readonly at: number }[] {
  const found: { name: string; at: number }[] = [];
  for (const entry of CARRIERS) {
    const match = entry.pattern.exec(text);
    if (match !== null && !found.some((hit) => hit.name === entry.name))
      found.push({ name: entry.name, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The one country every named carrier shares, or `null`. */
function carriersCountry(carriers: readonly string[]): string | null {
  let common: string[] | null = null;
  for (const name of carriers) {
    const entry = CARRIERS.find((item) => item.name === name);
    const set = CARRIER_COUNTRIES[name] ?? (entry?.country != null ? [entry.country] : null);
    if (set === null) continue;
    common = common === null ? [...set] : common.filter((code) => set.includes(code));
  }
  return common !== null && common.length === 1 ? (common[0] ?? null) : null;
}

/**
 * Detects the carrier and the country of one service.
 *
 * Why: plan section 3.5, A3 section 5: carriers for IMEI services only, the first named in the title (else in the group), none
 * from a router code list; the country from a country word in the title, else the one country word of the group, else the single
 * country the named carriers share; none for `All Countries`, `Worldwide` or a list of more than three. A country word before
 * `supported` or after `not`/`non` is no country (`China Supported`).
 *
 * @param title the title before the cut (rules R1-R12)
 * @param name the supplier's name (only to recognise a router code list)
 * @param group the group text as `groupText` gives it
 * @param kind the family of rules of the service type
 * @returns the carrier, the country and where it came from
 */
export function detectGeo(title: string, name: string, group: string, kind: NamingKind): DetectedGeo {
  // Router model lists name the carriers and countries of the router variant, not of the service.
  const routerList = isRouterCodeList(name) || isRouterCodeList(title) || /^router code$/i.test(group);
  const unsupported = (text: string) => text.replace(SUPPORT_TRAP, ' ');
  const titleHits = routerList ? [] : detectCountries(unsupported(title));
  const groupHits = detectCountries(unsupported(group));
  let carriers: string[] = [];
  if (!routerList && kind === 'imei') {
    carriers = namedCarriers(title).map((hit) => hit.name);
    if (carriers.length === 0) carriers = namedCarriers(group).map((hit) => hit.name);
  }
  const carrierCountry = carriersCountry(carriers);
  const noSingle = NO_SINGLE_COUNTRY.test(title) || titleHits.length > 3;
  const countries = [...new Set([...titleHits, ...groupHits])];
  let country: string | null = null;
  let countrySource: CountrySource = 'none';
  if (noSingle && titleHits.length !== 1) {
    countrySource = 'multi';
  } else if (titleHits.length === 1) {
    country = titleHits[0] ?? null;
    countrySource = 'name';
  } else if (titleHits.length > 1) {
    if (carrierCountry !== null && titleHits.includes(carrierCountry)) {
      country = carrierCountry;
      countrySource = 'name_carrier';
    } else {
      countrySource = 'multi';
    }
  } else if (groupHits.length === 1 && !routerList) {
    country = groupHits[0] ?? null;
    countrySource = 'group';
  } else if (carrierCountry !== null) {
    country = carrierCountry;
    countrySource = 'carrier';
  }
  return { carrier: carriers[0] ?? null, carriers, country, countrySource, countries };
}
