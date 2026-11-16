// Text normalisation and model codes of the storefront search (feature 29, plan section 4.3): pure, shared by the index (documents,
// terms) and the queries (slice B2), so a word is cut the same way when it is indexed and when it is typed.

/** The longest query kept after normalising (plan section 4.3). */
export const MAX_QUERY_LENGTH = 100;
/** The most model codes per document. */
export const MAX_CODES = 100;
/** The most word windows per document. */
export const MAX_WORD_WINDOWS = 60;
/** The longest model code or word window kept. */
export const MAX_CODE_LENGTH = 24;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi;
// U+0000-U+001F and U+007F (plan section 4.3); the zero-width joiner and the emoji variation selector go with the emoji.
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
const CONTROL = /[\u0000-\u001f\u007f]/g;
const EMOJI = /\p{Extended_Pictographic}|\u200d|\ufe0e|\ufe0f/gu;
const SPACES = /\s+/g;
const HAS_DIGIT = /\p{N}/u;

/**
 * Decodes the HTML entities supplier names carry (`AT&amp;T`, `&#39;`, `&quot;`, numeric forms), once.
 *
 * Why: fact 8 of the plan: imported names hold entities; the shop shows `AT&T`, so the index must hold `AT&T` too.
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

/**
 * Cleans a text for display in the index: entities decoded, control characters and emoji removed, spaces collapsed; case and `&` kept.
 *
 * Why: plan section 4.2: the `title` field holds the title as shown, so the engine's `matched_tokens` map onto the words the visitor
 * sees (Typesense folds case and drops symbols itself).
 *
 * @param text the raw text
 * @returns the cleaned text
 */
export function cleanDisplay(text: string): string {
  return decodeEntities(text).replace(CONTROL, ' ').replace(EMOJI, '').replace(SPACES, ' ').trim();
}

/**
 * Normalises a text for matching: entities decoded, NFKC, lower case, control characters and emoji removed, `&` removed
 * (`at&t` becomes `att`), brackets and `|,;:` turned into spaces, spaces collapsed.
 *
 * Why: plan section 4.3: the index and the query must cut words the same way; `-`, `.`, `/` and `_` stay (model codes keep them,
 * and Typesense drops them itself when it tokenises).
 *
 * @param text the raw text
 * @returns the normalised text
 */
export function normaliseText(text: string): string {
  return decodeEntities(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(CONTROL, ' ')
    .replace(EMOJI, '')
    .replace(/&/g, '')
    .replace(/[()[\]{}<>|,;:]/g, ' ')
    .replace(SPACES, ' ')
    .trim();
}

/**
 * Normalises a query and cuts it to {@link MAX_QUERY_LENGTH} characters.
 *
 * @param text what the visitor typed
 * @returns the normalised query (it may be empty)
 */
export function normaliseQuery(text: string): string {
  return normaliseText(text).slice(0, MAX_QUERY_LENGTH).trim();
}

/**
 * Tells whether a token holds a digit.
 *
 * @param token one word
 * @returns true when any character is a number
 */
export function hasDigit(token: string): boolean {
  return HAS_DIGIT.test(token);
}

/**
 * Drops every token that holds a digit.
 *
 * Why: step 0 of the plan (section 11): in Typesense 30.2 `enable_typos_for_alpha_numerical_tokens: false` does not stop typo matches
 * on letter-and-digit tokens (`sma527f` found SM-A525F through a typo-searched field). So a field searched with `num_typos > 0`
 * never holds such a token: they are matched only through `title`, `codes`, `joins` and `models`, all searched with 0 typos.
 *
 * @param text a cleaned or normalised text (tokens are split on spaces, as Typesense splits them)
 * @returns the text without those tokens; `''` when nothing is left
 */
export function typoSafe(text: string): string {
  return text
    .split(' ')
    .filter((token) => token !== '' && !hasDigit(token))
    .join(' ');
}

/**
 * Extracts the model codes of some texts (`SM-A525F` gives `sma525f`, `sm`, `a525f`).
 *
 * Why: plan section 4.3, owner question 10: model numbers match while typed and never with typos; a code is a token with at least
 * one letter and one digit, 3-24 characters. For each code the joined form (no separators), its parts when it had separators, and
 * the form without a separated leading prefix of 1-3 letters. Sources are the title, the internal service name (its codes only),
 * the model labels and, because the typo-searched fields drop digit tokens (step 0), the brand, carrier, network labels and category.
 *
 * @param texts the texts to read, in order
 * @returns the codes, deduplicated, at most {@link MAX_CODES}
 */
export function extractCodes(texts: readonly string[]): string[] {
  const codes = new Set<string>();
  const add = (code: string) => {
    if (codes.size < MAX_CODES && code.length >= 2 && code.length <= MAX_CODE_LENGTH) codes.add(code);
  };
  for (const text of texts) {
    for (const token of normaliseText(text).split(' ')) {
      if (token.length < 3 || token.length > MAX_CODE_LENGTH) continue;
      const parts = token.split(/[^a-z0-9]+/).filter((part) => part !== '');
      const joined = parts.join('');
      if (!/[a-z]/.test(joined) || !/[0-9]/.test(joined) || joined.length < 3) continue;
      add(joined);
      if (parts.length > 1) {
        for (const part of parts) add(part);
        const [first, ...rest] = parts;
        if (first !== undefined && /^[a-z]{1,3}$/.test(first) && rest.length > 0) add(rest.join(''));
      }
      if (codes.size >= MAX_CODES) return [...codes];
    }
  }
  return [...codes];
}

/**
 * The concatenated windows of 2-4 consecutive words of a title (`iphone 15 pro max` gives `iphone15`, `iphone15pro`,
 * `iphone15promax`, `15pro`, `15promax`, `promax`).
 *
 * Why: plan section 4.3: a visitor types `iphone15promax` or `iphone15pr` without spaces; the windows let such a query match by
 * prefix with no typo.
 *
 * @param title the display title
 * @returns the windows of at most {@link MAX_CODE_LENGTH} characters, deduplicated, at most {@link MAX_WORD_WINDOWS}
 */
export function wordWindows(title: string): string[] {
  const words = normaliseText(title)
    .split(' ')
    .map((word) => word.replace(/[^a-z0-9]/g, ''))
    .filter((word) => word !== '');
  const windows = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    for (let size = 2; size <= 4 && start + size <= words.length; size += 1) {
      const joined = words.slice(start, start + size).join('');
      if (joined.length <= MAX_CODE_LENGTH) windows.add(joined);
      if (windows.size >= MAX_WORD_WINDOWS) return [...windows];
    }
  }
  return [...windows];
}

/**
 * A listing fact as written by staff, trimmed with inner spaces collapsed (case kept): `  samsung   Galaxy ` gives `samsung Galaxy`.
 *
 * @param text the raw fact
 * @returns the cleaned fact
 */
export function cleanFact(text: string): string {
  return cleanDisplay(text);
}
