// The batch half of the shop naming (feature 31, plan section 3.5): what depends on the other titles. The cut of a long title is
// applied only where it makes no twin among the batch and the listings, the uniqueness ladder puts back marketing words where two
// different names would share a slug base, and the twins that remain are flagged. Pure.
import type { BrandKind } from './brand';
import { type NamingFlag, type NamingInput, detectFacts, orderFlags, titleFlags } from './facts';
import { slugFor } from './slug-for';
import { cleanTitle, cutTitle } from './title-rules';

/** One row to name; `fixedTitle` is a title staff already chose (it is kept, and still counts in the uniqueness checks). */
export interface BatchInput extends NamingInput {
  /**
   * A title the caller keeps as it is (a copied row that staff edited); left out, the rules make the title. The facts (brand,
   * carrier, country) are still detected from the name, so a caller that edited a row's facts must put them back itself.
   */
  readonly fixedTitle?: string;
}

/** What the naming gives one row. */
export interface NamedService {
  /** The shop title; `''` when no Latin word is left (a person types it). */
  readonly title: string;
  /** `slugFor(title)`: the slug before any suffix; `assignSlugs` makes it unique. */
  readonly slugBase: string;
  /** The brand; `''` for none. */
  readonly brand: string;
  /** The kind of the brand; `null` for none. */
  readonly brandKind: BrandKind | null;
  /** The carrier; `''` for none. */
  readonly carrier: string;
  /** The ISO-2 country; `''` for none. */
  readonly country: string;
  /** The naming flags, in the order of `NAMING_FLAGS` (`slug_suffixed` is added by the caller after `assignSlugs`). */
  readonly flags: readonly NamingFlag[];
}

/** Options of {@link nameAll}. */
export interface NameAllOptions {
  /** The public titles of every listing in the table (the cut guard and `title_taken` compare with them). */
  readonly listingTitles?: Iterable<string>;
}

/**
 * A title compared without case and repeated spaces.
 *
 * Why: plan 31 section 3.2: the rule of `title_taken`, which a row edit applies to its new title too.
 *
 * @param title the shop title
 * @returns the title in lower case with single spaces
 */
export function titleKey(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A supplier name compared as written, spaces collapsed.
 *
 * Why: plan 31 section 3.2: two rows with one supplier name are one service twice (`duplicate_name`), not twins (`title_taken`).
 *
 * @param name the supplier's service name
 * @returns the name with single spaces
 */
export function nameKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** Adds a value to the set kept under a key. */
function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

/**
 * Names a batch of services: title, slug base, brand, carrier, country and flags for each row, in the order of `rows`.
 *
 * Why: plan section 3.5: the only batch function. Brand, carrier and country are {@link detectFacts} of each row alone. The cut
 * (R13) is applied only where the cut title is not also the cut form of another title of the batch or of a listing, so a variant
 * published next week keeps the words that tell it from its listed siblings (#476 beside #473-#475). Where two different names
 * still make one slug base, both are cleaned again without the marketing, delivery and cut rules (`marketing_kept`). A title that
 * still equals a listing's title, or another row's with a different supplier name, is `title_taken`; rows of one supplier name
 * are `duplicate_name`.
 *
 * @param rows the services to name
 * @param options the listings' titles
 * @returns one named row per input row, in the same order
 */
export function nameAll(rows: readonly BatchInput[], options: NameAllOptions = {}): NamedService[] {
  const listingTitles = [...(options.listingTitles ?? [])].filter((title) => title.trim() !== '');
  const cleaned = rows.map((row) => cleanTitle(row.name, row.type));
  // Facts are read from the row's own cleaned name, even where staff fixed the title: they are a function of the row.
  const facts = rows.map((row, i) => detectFacts(row, cleaned[i]));
  const uncut = rows.map((row, i) => row.fixedTitle ?? cleaned[i] ?? '');
  const cut = rows.map((row, i) => (row.fixedTitle !== undefined ? row.fixedTitle : cutTitle(uncut[i] ?? '')));

  // The cut guard: each cut form and the uncut titles it comes from, over the batch and the listings.
  const cutForms = new Map<string, Set<string>>();
  rows.forEach((_row, i) => addTo(cutForms, titleKey(cut[i] ?? ''), titleKey(uncut[i] ?? '')));
  for (const title of listingTitles) addTo(cutForms, titleKey(cutTitle(title)), titleKey(title));
  // A listing whose title is a row's uncut title adds no second entry above, so its cut form is checked on its own.
  const listingCutForms = new Set(listingTitles.map((title) => titleKey(cutTitle(title))));
  const titles = rows.map((_row, i) => {
    const whole = uncut[i] ?? '';
    const short = cut[i] ?? '';
    if (short === whole) return short;
    const twin = (cutForms.get(titleKey(short))?.size ?? 0) > 1 || listingCutForms.has(titleKey(short));
    return twin ? whole : short;
  });

  // The uniqueness ladder: two different supplier names on one slug base get their marketing words back.
  const namesBySlug = new Map<string, Set<string>>();
  rows.forEach((row, i) => addTo(namesBySlug, slugFor(titles[i] ?? ''), nameKey(row.name)));
  const relaxed = rows.map((row, i) => {
    const title = titles[i] ?? '';
    if (row.fixedTitle !== undefined || title === '') return false;
    if ((namesBySlug.get(slugFor(title))?.size ?? 0) <= 1) return false;
    const kept = cleanTitle(row.name, row.type, { keepMarketing: true });
    titles[i] = kept;
    return kept !== title;
  });

  // The twins that remain: a listing's title, or another row's title under a different supplier name.
  const listingKeys = new Set(listingTitles.map(titleKey));
  const namesByTitle = new Map<string, Set<string>>();
  const rowsByName = new Map<string, number>();
  rows.forEach((row, i) => {
    addTo(namesByTitle, titleKey(titles[i] ?? ''), nameKey(row.name));
    rowsByName.set(nameKey(row.name), (rowsByName.get(nameKey(row.name)) ?? 0) + 1);
  });

  return rows.map((row, i) => {
    const title = titles[i] ?? '';
    const fact = facts[i];
    const brand = fact?.brand ?? '';
    const brandKind = fact?.brandKind ?? null;
    const flags: NamingFlag[] = [...(fact?.flags ?? []), ...titleFlags(title, brand, brandKind)];
    const key = titleKey(title);
    if (title !== '' && (listingKeys.has(key) || (namesByTitle.get(key)?.size ?? 0) > 1)) flags.push('title_taken');
    if ((rowsByName.get(nameKey(row.name)) ?? 0) > 1) flags.push('duplicate_name');
    if (relaxed[i] === true) flags.push('marketing_kept');
    return {
      title,
      slugBase: slugFor(title),
      brand,
      brandKind,
      carrier: fact?.carrier ?? '',
      country: fact?.country ?? '',
      flags: orderFlags(flags),
    };
  });
}
