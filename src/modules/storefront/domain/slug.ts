// Slugs of the storefront content (listings, content pages, help articles): how one is made from a title and what a valid one
// looks like. Pure functions (decision 017 content; ANSWERS storefront Q9).

/** The longest slug the storefront accepts. */
export const SLUG_MAX_LENGTH = 120;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The sentence a typed slug of the wrong form is refused with. */
export const SLUG_FORM_MESSAGE = 'Use lower-case letters, digits and single hyphens, for example "about-us".';

/**
 * Makes a web address part from a title, as the demo's `slugOf` does: lower case, `&` becomes `and`, every other run of
 * characters that are not letters or digits becomes one `-`, and `-` is trimmed at both ends.
 *
 * Why: ANSWERS storefront Q9: a listing or page created without a slug gets this one, so `Unlock iPhone on AT&T` is
 * `unlock-iphone-on-atandt`. Only Latin letters and digits survive, so an Arabic title gives an empty slug and the caller must
 * ask for one.
 *
 * @param text the title
 * @returns the slug, cut to {@link SLUG_MAX_LENGTH} characters; `''` when the title has no Latin letter or digit
 */
export function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length <= SLUG_MAX_LENGTH ? slug : slug.slice(0, SLUG_MAX_LENGTH).replace(/-$/, '');
}

/**
 * Tells whether a text is a valid slug: lower-case letters and digits in groups joined by single hyphens.
 *
 * Why: a slug is a URL path part, so it is checked rather than silently changed when staff type one.
 *
 * @param text the slug as typed (already trimmed)
 * @returns true when it is valid and at most {@link SLUG_MAX_LENGTH} characters
 */
export function isSlug(text: string): boolean {
  return text.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(text);
}

/** What {@link chooseSlug} decided. */
export type SlugChoice =
  { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly message: string };

/**
 * Picks the slug of a new record: the one staff typed, or one made from the title.
 *
 * @param typed the slug the request carried, if any (trimmed; `''` counts as left out)
 * @param title the title to make one from
 * @returns the slug, or the sentence that explains why none could be chosen
 */
export function chooseSlug(typed: string | undefined, title: string): SlugChoice {
  if (typed !== undefined && typed !== '') {
    return isSlug(typed) ? { ok: true, slug: typed } : { ok: false, message: SLUG_FORM_MESSAGE };
  }
  const made = slugOf(title);
  return made === ''
    ? { ok: false, message: 'Enter a slug: the title has no letters or digits to make one from.' }
    : { ok: true, slug: made };
}
