// How the ledger list reads its `q` (resolution money-15, ANSWERS finance Q3): a number is a journal or record id, other
// text searches memo, kind and owner names.

/** A parsed search text. */
export type LedgerSearch =
  { readonly kind: 'id'; readonly id: number } | { readonly kind: 'text'; readonly text: string };

const NUMERIC = /^[1-9]\d{0,15}$/;

/**
 * Decides what a search text means.
 *
 * Why: resolution money-15: the console strips `JRN-`/`#` and leading zeros, so a numeric `q` matches `id = q OR ref_id = q`
 * (any reference type); any other text matches memo, kind and the owner names of the lines, case-insensitively.
 *
 * @param text the trimmed `q`
 * @returns an id search for a plain positive whole number, a text search otherwise
 */
export function parseLedgerSearch(text: string): LedgerSearch {
  const trimmed = text.trim();
  if (NUMERIC.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return { kind: 'id', id: Number(trimmed) };
  return { kind: 'text', text: trimmed };
}

/**
 * Escapes the characters `LIKE` treats as wildcards.
 *
 * Why: the list layer hands repositories raw user text (ALIGNMENT § 2); a `%` or `_` typed by a user must match itself.
 *
 * @param text raw user text
 * @returns text safe inside a `LIKE '%…%'` pattern (with the default escape character `\`)
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
