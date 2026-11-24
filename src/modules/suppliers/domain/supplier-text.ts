// How the text of a supplier's answer is cleaned and bounded before anything stores or relays it (decision 051). Pure; the driver cleans every
// answer once, the readers of `dhru-protocol.ts` bound each field they keep.

/** The longest string of an answer after cleaning (decision 051). */
export const SUPPLIER_STRING_MAX = 20_000;
/** The longest error message kept from a supplier (decision 051). */
export const SUPPLIER_MESSAGE_MAX = 500;
/** The longest result (`CODE`) kept from a supplier (decision 051). */
export const SUPPLIER_RESULT_MAX = 20_000;
/** The longest service name, group, type, time, account currency or mail kept from a supplier (decision 051). */
export const SUPPLIER_LABEL_MAX = 300;
/** The longest reference or service id kept from a supplier (decision 051). */
export const SUPPLIER_REFERENCE_MAX = 200;
/** The deepest level of an answer that is kept; the root is level 0 and anything deeper becomes `null` (decision 051). */
export const SUPPLIER_JSON_MAX_DEPTH = 32;

// Control characters but tab, line feed and carriage return; and surrogate halves that have no partner (the database refuses both).
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- removing control characters is the point of this pattern
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// The same set plus every surrogate: text without any of these needs no replacing.
// eslint-disable-next-line no-control-regex -- detecting control characters is the point of this pattern
const MAYBE_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/;

/**
 * Cuts a text to a number of UTF-16 code units without leaving half of a surrogate pair.
 *
 * Why: decision 051: every kept supplier text has a bound, and a cut text must stay valid for the database and for JSON.
 *
 * @param text the text
 * @param max the most code units to keep
 * @returns the text itself when it fits, else its first `max` code units minus a trailing high surrogate
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Removes the characters a stored text must not hold and caps its length.
 *
 * Why: decision 051: a supplier's text is stored as it arrives; U+0000 and lone surrogates make the database refuse the write, so one
 * answer could stop an order, the call log or a sync. Tab, line feed, carriage return, valid surrogate pairs and format characters such
 * as U+200F stay (text a supplier writes in Arabic is data, decision 039).
 *
 * @param text the text of an answer
 * @returns the text without U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+007F-U+009F and lone surrogates, cut to
 *   {@link SUPPLIER_STRING_MAX}
 */
export function cleanSupplierText(text: string): string {
  const clean = MAYBE_UNSAFE.test(text) ? text.replace(UNSAFE, '') : text;
  return cutText(clean, SUPPLIER_STRING_MAX);
}

function cleanValue(value: unknown, depth: number): unknown {
  if (depth > SUPPLIER_JSON_MAX_DEPTH) return null;
  if (typeof value === 'string') return cleanSupplierText(value);
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const clean = cleanSupplierText(key);
      // A member named `__proto__` would set the object's prototype instead of a member: it is dropped.
      if (clean === '__proto__') continue;
      out[clean] = cleanValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Cleans a parsed JSON answer.
 *
 * Why: decision 051: one cleaning step where the driver parses an answer means no sink (call log, events, results, mails) has to
 * remember it.
 *
 * @param value a parsed JSON value
 * @returns a copy in which every string and every key went through {@link cleanSupplierText}, a key `__proto__` is dropped and any value
 *   deeper than {@link SUPPLIER_JSON_MAX_DEPTH} is `null`; numbers, booleans and `null` are kept
 */
export function cleanSupplierJson(value: unknown): unknown {
  return cleanValue(value, 0);
}

function textOfValue(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/**
 * Reads a supplier's value as one line of text.
 *
 * Why: decision 051: names, groups, types, times, references and messages are shown in lists and sentences; they are bounded and have no
 * line breaks.
 *
 * @param value the value of an answer
 * @param max the most code units to keep
 * @returns the text of a string or of a finite number (else `''`), cleaned, each run of tabs and line breaks turned into one space,
 *   trimmed and cut to `max`
 */
export function supplierLine(value: unknown, max: number): string {
  const text = cleanSupplierText(textOfValue(value)).replace(/[\t\n\r\u2028\u2029]+/g, ' ');
  return cutText(text.trim(), max);
}

/**
 * Reads a supplier's value as a block of text that may hold several lines.
 *
 * Why: decision 051: the result of an order may have several lines; it is cleaned, bounded and uses one kind of line break.
 *
 * @param value the value of an answer
 * @param max the most code units to keep
 * @returns the text, cleaned, with CRLF, CR, U+2028 and U+2029 turned into line feeds, trimmed and cut to `max` (tabs stay)
 */
export function supplierBlock(value: unknown, max: number): string {
  const text = cleanSupplierText(textOfValue(value)).replace(/\r\n|\r|\u2028|\u2029/g, '\n');
  return cutText(text.trim(), max);
}
