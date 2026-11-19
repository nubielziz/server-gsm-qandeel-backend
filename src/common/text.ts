// Text helpers shared by modules that cannot import each other (feature 31, plan 31 section 3.5): the HTML entities that supplier names carry
// and the two character classes that never belong in a name shown to people. The storefront search re-exports them (its public API is unchanged),
// and the catalog's category names use them.

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi;

/**
 * Control characters: U+0000-U+001F and U+007F.
 *
 * Why: plan section 4.3 of feature 29 (the search index) and plan 31 section 3.5 (category names): none of them belongs in a name that people read.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * Emoji, with the zero-width joiner and the emoji variation selectors that go with them.
 *
 * Why: suppliers decorate service and group names with emoji; the shop shows clean text.
 */
export const EMOJI = /\p{Extended_Pictographic}|\u{200d}|\u{fe0e}|\u{fe0f}/gu;

/**
 * Decodes the HTML entities supplier names carry (`AT&amp;T`, `&#39;`, `&quot;`, numeric forms), once.
 *
 * Why: fact 8 of plan 31 and fact 8 of feature 29: imported names hold entities; the shop shows `AT&T`, so the index and the category menu
 * must hold `AT&T` too.
 *
 * @param text the raw text
 * @returns the text with every known entity replaced; unknown ones stay as written
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
