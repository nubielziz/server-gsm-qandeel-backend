// The rules of the code inventory: which pasted lines are codes, how a code is masked, and the batch reference format.
// Pure functions; the import use case (`application/inventory-admin.service.ts`) adds the database parts.

/** The shortest line read as a code. */
export const MIN_CODE_LENGTH = 6;
/** The longest line read as a code. */
export const MAX_CODE_LENGTH = 128;
/** The most lines one import may carry (more is `422` on `codes`). */
export const MAX_IMPORT_CODES = 10_000;
/** The most ids one void call may carry. */
export const MAX_VOID_IDS = 10_000;
/** The longest batch reference staff may send. */
export const MAX_BATCH_REF_LENGTH = 40;

/** The encryption context of `inventory_codes.code_enc` (decision 019: `<table>.<column>`). */
export const INVENTORY_CODE_AAD = 'inventory_codes.code_enc';

/**
 * The text that is hashed to find a duplicate code: the code behind a prefix.
 *
 * Why: `code_hash` is the keyed hash of decision 019 (`TokenService.hash`); the prefix keeps it apart from session, API key and
 * every other token hash, so a code can never collide with a credential. The import and the seed both use this function.
 *
 * @param code a trimmed code
 * @returns the text to pass to `TokenService.hash`
 */
export function inventoryCodeHashInput(code: string): string {
  return `inventory-code:${code}`;
}

/** Eight bullets then the last four characters: the fixed-length mask of every code. */
const MASK_BULLETS = '•'.repeat(8);

/** Whitespace or a control character anywhere in a line. */
const FORBIDDEN_INSIDE = /[\s\p{Cc}]/u;

/** A batch reference staff may send: letters, digits, dot, underscore and hyphen. */
export const BATCH_REF_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * Tells whether a trimmed line can be stored as a code.
 *
 * Why: RESOLUTIONS catalog-15: lines that are shorter than 6 or longer than 128 characters, or have a space, tab, line break
 * or other control character inside, are counted as `rejected` (not an error); the rest are codes.
 *
 * @param code the line after trimming
 * @returns true when it is a storable code
 */
export function isStorableCode(code: string): boolean {
  const length = [...code].length;
  return length >= MIN_CODE_LENGTH && length <= MAX_CODE_LENGTH && !FORBIDDEN_INSIDE.test(code);
}

/**
 * The last four characters of a code, kept in clear so the console can mask the rest (MISMATCHES B18).
 *
 * @param code a storable code
 * @returns its last four characters (whole characters, not UTF-16 halves)
 */
export function lastFour(code: string): string {
  return [...code].slice(-4).join('');
}

/**
 * The text the console shows instead of a code: eight bullets and the last four characters.
 *
 * Why: RESOLUTIONS catalog-15: a fixed length, so listing never decrypts a code and never leaks its length.
 *
 * @param last4 the stored last four characters
 * @returns the masked code, for example `••••••••1234`
 */
export function maskedCode(last4: string): string {
  return `${MASK_BULLETS}${last4}`;
}

/**
 * Formats a batch reference from the next number of the batch sequence.
 *
 * @param sequence the value drawn from `inventory_batch_ref_seq` (from 1)
 * @returns `B-0031` for 31; the number grows past four digits instead of being cut
 */
export function batchRefOf(sequence: number): string {
  return `B-${String(sequence).padStart(4, '0')}`;
}

/** The outcome of sorting a pasted list. */
export interface PreparedCodes {
  /** The codes to store, once each, in the order they appeared. */
  readonly codes: string[];
  /** Lines that are not codes (too short, too long, or with whitespace inside). */
  readonly rejected: number;
  /** Lines that repeat an earlier line of the same list. */
  readonly repeated: number;
}

/**
 * Trims a pasted list, counts the lines that are not codes and drops the repeats.
 *
 * Why: staff paste one entry per line and the server counts what it cannot use (RESOLUTIONS catalog-15); a code repeated in
 * the same batch counts as a duplicate, the first one is kept. Codes are case sensitive.
 *
 * @param lines the raw entries
 * @returns the codes to store and the counts
 */
export function prepareCodes(lines: readonly string[]): PreparedCodes {
  const seen = new Set<string>();
  const codes: string[] = [];
  let rejected = 0;
  let repeated = 0;
  for (const line of lines) {
    const code = line.trim();
    if (!isStorableCode(code)) {
      rejected += 1;
    } else if (seen.has(code)) {
      repeated += 1;
    } else {
      seen.add(code);
      codes.push(code);
    }
  }
  return { codes, rejected, repeated };
}
