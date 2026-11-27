// A text turned into an identifier by the server (decision 077): the code of a payment method and the key of an alert rule. Two modules
// need it and cannot import each other, so it lives here. Pure: no database, no clock.

/**
 * The shape an identifier made from a text must have.
 *
 * Why: each record that gets a made identifier has its own format rule (a payment method's code is a URL segment of up to 40
 * characters; an alert rule's key starts with a letter and holds 3 to 41); the rules say what the maker must honour.
 */
export interface IdentifierRules {
  /** The longest identifier, any suffix included. */
  readonly maxLength: number;
  /**
   * What a text with nothing usable in it becomes, and the word put in front (`<fallback>_`) when the shape rules below need it.
   * It must itself satisfy the rules (letters only, at least `minLength` long).
   */
  readonly fallback: string;
  /** The shortest identifier; a shorter result is put behind `<fallback>_`. Default 1. */
  readonly minLength?: number;
  /** True when the identifier must start with a letter: a result that starts with a digit is put behind `<fallback>_`. Default false. */
  readonly startsWithLetter?: boolean;
}

/**
 * The Latin letters that do not fall apart into a letter and an accent when a text is decomposed.
 *
 * Written with escapes only: ß, æ, œ, ø, ł, đ, ð.
 */
const LATIN_LETTERS: Readonly<Record<string, string>> = {
  '\u00df': 'ss',
  '\u00e6': 'ae',
  '\u0153': 'oe',
  '\u00f8': 'o',
  '\u0142': 'l',
  '\u0111': 'd',
  '\u00f0': 'd',
};

/** The most tries {@link firstFreeIdentifier} makes before it gives up (a bug or a flood, never a real list of names). */
export const MAX_IDENTIFIER_ATTEMPTS = 1000;

/**
 * Turns a text into an identifier: lower case, accents dropped, every run of characters that are not a-z or 0-9 one underscore, no
 * underscore at either end, cut to the longest length.
 *
 * Why: decision 077: staff no longer type the code of a payment method or the key of an alert rule; the server makes it from the name
 * (`Bank of Jordan` becomes `bank_of_jordan`). A name in another script (Arabic, Chinese) has no a-z or 0-9 in it and gives the fallback.
 *
 * @param text the name to turn into an identifier
 * @param rules the length, the fallback and the shape the identifier must have
 * @returns the identifier: never empty, never longer than `rules.maxLength`, never starting or ending with `_`
 */
export function identifierFrom(text: string, rules: IdentifierRules): string {
  const plain = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\u00df\u00e6\u0153\u00f8\u0142\u0111\u00f0]/g, (letter) => LATIN_LETTERS[letter] ?? letter);
  let made = plain.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (made === '') made = rules.fallback;
  else if ((rules.startsWithLetter === true && /^[0-9]/.test(made)) || made.length < (rules.minLength ?? 1)) {
    made = `${rules.fallback}_${made}`;
  }
  return made.slice(0, rules.maxLength).replace(/_+$/, '');
}

/**
 * The identifier to try on the given attempt: `base` itself, then `base_2`, `base_3`, ...
 *
 * Why: decision 077: a name that makes a code another record already holds gets the next number instead of failing, as the console's
 * old helper did for ready-made methods. The base is cut so that the suffix always fits the longest length.
 *
 * @param base the identifier made from the text ({@link identifierFrom})
 * @param attempt which try this is, counted from 1 (a number below 1 counts as 1)
 * @param maxLength the longest identifier, suffix included
 * @returns `base` on the first try, `<base>_<attempt>` after it
 */
export function identifierAttempt(base: string, attempt: number, maxLength: number): string {
  if (attempt <= 1) return base.slice(0, maxLength).replace(/_+$/, '');
  const suffix = `_${attempt}`;
  return `${base.slice(0, maxLength - suffix.length).replace(/_+$/, '')}${suffix}`;
}

/** What {@link firstFreeIdentifier} needs from its caller. */
export interface FreeIdentifierSearch<T> {
  /** The identifier made from the text ({@link identifierFrom}), or a catalog key. */
  readonly base: string;
  /** The longest identifier, suffix included. */
  readonly maxLength: number;
  /** Tells whether a record already holds the candidate (a plain read: it only saves rows the unique index would refuse anyway). */
  readonly isTaken: (candidate: string) => Promise<boolean>;
  /**
   * Writes the record under the candidate and answers it; answers `undefined` when the candidate was taken at the same moment
   * (`INSERT ... ON CONFLICT DO NOTHING`: no error, so the caller's transaction stays usable).
   */
  readonly insert: (candidate: string) => Promise<T | undefined>;
}

/**
 * Writes a record under the first identifier from `base` that nobody holds, however many creates run at the same moment.
 *
 * Why: decision 077: two creates of the same name at once must both succeed, with `base` and `base_2`, and must not answer `409` for an
 * identifier nobody typed. The read skips the identifiers already held; the conflict-safe insert is the last word when another transaction
 * takes one between the read and the write (it waits for that transaction to end, then reports the conflict, and the next number is tried).
 *
 * @param search the base, the longest length, the read and the conflict-safe insert
 * @returns what `insert` answered for the identifier that was written
 * @throws {Error} after {@link MAX_IDENTIFIER_ATTEMPTS} tries
 */
export async function firstFreeIdentifier<T>(search: FreeIdentifierSearch<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
    const candidate = identifierAttempt(search.base, attempt, search.maxLength);
    if (await search.isTaken(candidate)) continue;
    const written = await search.insert(candidate);
    if (written !== undefined) return written;
  }
  throw new Error(`No free identifier was found from "${search.base}" in ${MAX_IDENTIFIER_ATTEMPTS} tries.`);
}
