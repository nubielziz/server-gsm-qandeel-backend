// The name of a category made by an import (feature 31, plan 31 section 3.5): the supplier's group text, cleaned. Pure, no database.
// Arabic script is matched with escapes only (decision 039): no file holds the script itself.
import { CONTROL_CHARACTERS, EMOJI, decodeEntities } from '../../../common/text';

/** The name of the category of a service whose supplier group is empty, or is nothing but decoration. */
export const IMPORTED_CATEGORY_NAME = 'Imported';

// The Arabic script blocks (basic, supplement, extended-A, presentation forms A and B).
const ARABIC_LETTERS = /[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{08A0}-\u{08FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}]+/gu;
// Zero-width characters, direction marks and embeddings, isolates, the byte order mark and the variation selectors: invisible, so a group that
// differs from another only by one of them would otherwise be a second category.
const INVISIBLE = /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]|\u{FE0E}|\u{FE0F}/gu;
// Check marks, sparkles, star, shamrock, guillemets, heart and bolt: decoration the emoji class misses or that suppliers write without the
// emoji selector.
const DECORATION = /[\u{2713}\u{2714}\u{2705}\u{2728}\u{2B50}\u{2618}\u{00BB}\u{00AB}\u{2764}\u{26A1}]/gu;
const EMPTY_BRACKETS = /\(\s*\)|\[\s*\]/g;
// What a name never starts or ends with once the words around it are gone: hyphens and dashes, slashes, bars, colons, semicolons, commas,
// underscores, stars, tildes, bullets and `&` (a full stop and a plus stay: `Apple Inc.` and `iPhone 15+` are names).
const EDGE_SEPARATORS =
  /^[\s\-\u{2013}\u{2014}/\\|:;,_*~\u{2022}\u{00B7}&]+|[\s\-\u{2013}\u{2014}/\\|:;,_*~\u{2022}\u{00B7}&]+$/gu;

/**
 * Cleans the supplier's group text into the name of a category.
 *
 * Why: plan 31 section 3.5 "Category names": Quick add names a category after the supplier's group, and the public menu shows that name, so
 * `&amp;`, emoji, direction marks and Arabic script must not reach it. Entities are decoded; control and invisible characters, emoji and
 * decoration and Arabic script runs are removed (with the brackets they leave empty); spaces are collapsed; separators left at either end
 * are dropped; nothing left gives `Imported`. Case, inner punctuation and everything else stay, so a clean name is returned as it is and
 * cleaning twice changes nothing.
 *
 * @param group the supplier's group text, as `supplier_services.remote_group` stores it
 * @returns the category name: never empty, never starting or ending with a separator or a space
 */
export function cleanGroupName(group: string): string {
  const cleaned = decodeEntities(group)
    .replace(/\u{00A0}/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(EMOJI, '')
    .replace(DECORATION, ' ')
    .replace(ARABIC_LETTERS, ' ')
    .replace(EMPTY_BRACKETS, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_SEPARATORS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? IMPORTED_CATEGORY_NAME : cleaned;
}
