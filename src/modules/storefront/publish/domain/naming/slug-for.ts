// Slugs of the bulk publish (feature 31, plan section 3.5): the slug base of a shop title, the next free suffix, and the unique
// slugs of a batch in service id order. Pure; `slugOf` (ANSWERS storefront Q9) does the letters.
import { SLUG_MAX_LENGTH, slugOf } from '../../../domain/slug';

/** The most suffixes {@link nextFreeSlug} tries; more than every listing and row there can be. */
const MAX_SUFFIX = 100_000;

/**
 * The slug base of a shop title: `slugOf` of the title after two substitutions of this path only (`$10` becomes `10 usd`, so
 * `Gift Card $10` and `Gift Card 10` differ; `AT&T` becomes `att`, owner question 7); over {@link SLUG_MAX_LENGTH} characters it
 * is cut at the last hyphen that fits.
 *
 * Why: plan section 3.5, A3 section 3: a slug is a public address and is never renamed after publishing.
 *
 * @param title the shop title
 * @returns the slug base; `''` for a title with no Latin letter or digit
 */
export function slugFor(title: string): string {
  const text = title.replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1 usd').replace(/(?<![A-Za-z0-9])AT&T(?![A-Za-z0-9])/gi, 'att');
  // slugOf cuts at the limit inside a word; slugging word by word gives the whole slug, so the cut can fall on a hyphen.
  const whole = text
    .split(/\s+/)
    .map((word) => slugOf(word))
    .filter((part) => part !== '')
    .join('-');
  if (whole.length <= SLUG_MAX_LENGTH) return whole;
  const head = whole.slice(0, SLUG_MAX_LENGTH + 1);
  const at = head.lastIndexOf('-');
  return (at > 0 ? head.slice(0, at) : whole.slice(0, SLUG_MAX_LENGTH)).replace(/-+$/, '');
}

/**
 * The base when it is free, else the first free `base-2`, `base-3`, ...; the base is shortened (and never ends on a hyphen) so the
 * slug stays within {@link SLUG_MAX_LENGTH}.
 *
 * Why: plan section 3.5: one rule for the three callers: the batch ({@link assignSlugs}), the row edit that empties the slug
 * field, and the publisher's next free suffix at apply.
 *
 * @param base a slug base from {@link slugFor} (`''` gives `''`)
 * @param isTaken tells whether a slug is held already
 * @returns the free slug
 * @throws Error when no suffix up to 100 000 is free (impossible for a finite set of taken slugs)
 */
export function nextFreeSlug(base: string, isTaken: (slug: string) => boolean): string {
  if (base === '' || !isTaken(base)) return base;
  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const suffix = `-${n}`;
    const slug = `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!isTaken(slug)) return slug;
  }
  throw new Error(`No free slug for "${base}".`);
}

/** The slug {@link assignSlugs} gave one row. */
export interface AssignedSlug {
  /** The unique slug; `''` when the row has no slug base (its title is empty). */
  readonly slug: string;
  /** True when the slug got a suffix (the soft flag `slug_suffixed`). */
  readonly suffixed: boolean;
}

/**
 * Makes the slugs of a batch unique, in service id order, against each other and against `taken` (the slugs of every listing and
 * the addresses staff typed in the run): the first row keeps its base, the next ones get `-2`, `-3` through {@link nextFreeSlug}.
 *
 * Why: plan sections 3.2 and 3.5: the preview gives every row a slug that is free among the listings and the rows of the run.
 *
 * @param rows each row's service id and slug base
 * @param taken the slugs already held
 * @returns one slug per row, in the order of `rows`
 */
export function assignSlugs(
  rows: readonly { readonly id: number; readonly slugBase: string }[],
  taken: Iterable<string>,
): AssignedSlug[] {
  const held = new Set(taken);
  const out: AssignedSlug[] = rows.map(() => ({ slug: '', suffixed: false }));
  const order = rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.id - b.row.id || a.index - b.index);
  for (const { row, index } of order) {
    if (row.slugBase === '') continue;
    const slug = nextFreeSlug(row.slugBase, (candidate) => held.has(candidate));
    held.add(slug);
    out[index] = { slug, suffixed: slug !== row.slugBase };
  }
  return out;
}
