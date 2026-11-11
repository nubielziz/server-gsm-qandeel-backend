// The public slug of a storefront category (feature 22): `<id>-<words of the name>`. The catalog's categories have no slug column, so
// the slug is derived, exactly like the help slug (domain/help-slug.ts); the id in front is the only part that counts.
import { slugOf } from './slug';

/** How many characters of the name's words a category slug keeps. */
const CATEGORY_SLUG_WORDS_MAX = 60;

/**
 * Builds the public slug of a category.
 *
 * Why: the menu and the category pages need an address for one category and `service_categories` has no slug column. The id makes the
 * slug unique and stable without a column or a collision rule; the words come from the category's base (English) name, so the slug is
 * the same in both languages, and a rename never breaks a link because the site reads the number before the first hyphen.
 *
 * @param category the category's id and base name
 * @returns for example `4-carrier-unlock`; just the id when the name has no Latin letter or digit
 */
export function categorySlug(category: { id: number; name: string }): string {
  const words = slugOf(category.name).slice(0, CATEGORY_SLUG_WORDS_MAX).replace(/-$/, '');
  return words === '' ? String(category.id) : `${category.id}-${words}`;
}
