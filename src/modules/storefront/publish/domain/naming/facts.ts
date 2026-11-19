// The facts of one service for the shop (feature 31, plan section 3.5): brand, carrier and country read from the title before
// the cut and from the group, and the flags that follow from one row alone. Pure: a row's facts never depend on the other rows.
import { type BrandKind, detectBrand } from './brand';
import { type CountrySource, detectGeo } from './carrier-country';
import { type PublishServiceType, bracketsBalanced, cleanTitle, groupText, namingKind } from './title-rules';

/**
 * The version of the naming rules, stored on every publish run (`listing_publish_runs.rules_version`).
 *
 * Why: plan section 3.5: a later rule change is a new version, so a run's titles can be told apart from a later run's.
 */
export const NAMING_RULES_VERSION = 1;

/**
 * The flags the naming gives a row, in the order they are listed. Hard flags put the row in `review`: `title_long`,
 * `duplicate_name`, `title_taken`, `quantity_text`, `multi_country`; the others are soft (the row stays `ready`).
 *
 * Why: plan section 3.2: the naming half of `PUBLISH_FLAGS` (the price flags are the evaluation's).
 */
export const NAMING_FLAGS = [
  'title_long',
  'duplicate_name',
  'title_taken',
  'quantity_text',
  'multi_country',
  'title_81_100',
  'title_lacks_brand',
  'brackets_repaired',
  'marketing_kept',
  'slug_suffixed',
  'no_brand',
  'country_from_group',
  'carrier_no_country',
] as const;

/** One flag of {@link NAMING_FLAGS}. */
export type NamingFlag = (typeof NAMING_FLAGS)[number];

/**
 * The naming flags that put a row in `review` (a person should look).
 *
 * Why: plan section 3.2, the hard flags.
 */
export const HARD_NAMING_FLAGS: ReadonlySet<NamingFlag> = new Set([
  'title_long',
  'duplicate_name',
  'title_taken',
  'quantity_text',
  'multi_country',
]);

/** A title longer than this is a hard `title_long` (the end of such a name is what tells its variants apart). */
export const TITLE_LONG_LENGTH = 100;

/** A title longer than this (and at most {@link TITLE_LONG_LENGTH}) is a soft `title_81_100`. */
export const TITLE_SOFT_LENGTH = 80;

/** One service to name: its supplier name, its type and the name of its category (the supplier's group, for Quick add). */
export interface NamingInput {
  /** The service's name (the supplier's, verbatim). */
  readonly name: string;
  /** The catalog service type. */
  readonly type: PublishServiceType;
  /** The name of the service's category; entities are decoded here. */
  readonly group: string;
}

/** What the rules read from one row alone. */
export interface ServiceFacts {
  /** The title before the cut (rules R1-R12 and R14). */
  readonly uncutTitle: string;
  /** The brand; `''` for none. */
  readonly brand: string;
  /** The kind of the brand; `null` for none. */
  readonly brandKind: BrandKind | null;
  /** The carrier; `''` for none (IMEI services only). */
  readonly carrier: string;
  /** The ISO-2 country; `''` for none. */
  readonly country: string;
  /** Where the country came from. */
  readonly countrySource: CountrySource;
  /** Every country named in the title and the group. */
  readonly countries: readonly string[];
  /** The flags of this row alone, in the order of {@link NAMING_FLAGS}. */
  readonly flags: readonly NamingFlag[];
}

/**
 * Orders a set of flags as {@link NAMING_FLAGS} lists them.
 *
 * @param flags the flags, in any order, possibly repeated
 * @returns each flag once, in the order of the list
 */
export function orderFlags(flags: Iterable<NamingFlag>): NamingFlag[] {
  const set = new Set(flags);
  return NAMING_FLAGS.filter((flag) => set.has(flag));
}

/**
 * The flags of a title and a brand: `title_long`, `title_81_100`, `title_lacks_brand` (a tool brand whose first word the title
 * does not hold) and `no_brand`.
 *
 * Why: plan section 3.2: these derive from the title and the brand, so the row edit (`reflag`) recomputes them with this function
 * after staff change either.
 *
 * @param title the shop title
 * @param brand the brand (`''` for none)
 * @param brandKind the kind of the brand (`null` for none)
 * @returns the flags, in the order of {@link NAMING_FLAGS}
 */
export function titleFlags(title: string, brand: string, brandKind: BrandKind | null): NamingFlag[] {
  const flags: NamingFlag[] = [];
  if (title.length > TITLE_LONG_LENGTH) flags.push('title_long');
  else if (title.length > TITLE_SOFT_LENGTH) flags.push('title_81_100');
  if (brandKind === 'tool' && brand !== '' && title !== '') {
    const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    const first = words(brand)
      .split(' ')
      .find((word) => word.length >= 2);
    if (first !== undefined && !words(title).includes(first)) flags.push('title_lacks_brand');
  }
  if (brand === '') flags.push('no_brand');
  return orderFlags(flags);
}

/**
 * Detects the facts of one service: brand, carrier and country, read from the title **before the cut** and from the group with
 * fixed lexicons, and the flags of the row alone (`quantity_text`, `multi_country`, `brackets_repaired`, `country_from_group`,
 * `carrier_no_country`).
 *
 * Why: plan section 3.5: a row's facts must not depend on what else is in the run (naming a group alone gives the same brand,
 * carrier and country as naming the whole file); the prototype read them from the cut title and learned tools from the batch.
 *
 * @param row the service to read
 * @param uncutTitle the title of `cleanTitle(row.name, row.type)` when the caller has it already
 * @returns the facts and the row's flags
 */
export function detectFacts(row: NamingInput, uncutTitle: string = cleanTitle(row.name, row.type)): ServiceFacts {
  const kind = namingKind(row.type);
  const group = groupText(row.group);
  const brand = detectBrand(uncutTitle, group, kind);
  const geo = detectGeo(uncutTitle, row.name, group, kind);
  const flags: NamingFlag[] = [];
  if (/\bqnt\s*=|\b1\s?qnt\b/i.test(row.name)) flags.push('quantity_text');
  if (geo.countries.length > 3 && geo.country === null) flags.push('multi_country');
  if (!bracketsBalanced(row.name)) flags.push('brackets_repaired');
  if (geo.countrySource === 'group') flags.push('country_from_group');
  if (geo.carrier !== null && geo.country === null) flags.push('carrier_no_country');
  return {
    uncutTitle,
    brand: brand?.name ?? '',
    brandKind: brand?.kind ?? null,
    carrier: geo.carrier ?? '',
    country: geo.country ?? '',
    countrySource: geo.countrySource,
    countries: geo.countries,
    flags: orderFlags(flags),
  };
}
