// Bulk reply (POST /admin/orders/bulk-reply/preview): reading the pasted lines and matching them to orders. Pure; the use case
// loads the candidate orders by input and calls these functions.

/** The most lines one paste or one apply may hold (RESOLUTIONS orders-suppliers-19: at most 500 items per apply). */
export const MAX_BULK_ITEMS = 500;

/** How the server read one pasted line (the console's `BulkReplyLineStatus`). */
export type BulkReplyLineStatus = 'matched' | 'not_found' | 'ambiguous' | 'invalid' | 'not_open';

/** One pasted line after reading it. */
export interface ParsedLine {
  /** 1-based over the pasted text; blank lines are skipped but still counted. */
  readonly line: number;
  readonly raw: string;
  /** The first token, or `null` when the line is blank after trimming. */
  readonly imei: string | null;
  /** The rest of the line, or `null` when there is none. */
  readonly code: string | null;
}

/** An order a line may match: only its id, whether it is open and its input. */
export interface MatchCandidate {
  readonly id: number;
  readonly open: boolean;
}

/**
 * Removes every whitespace character from an input.
 *
 * Why: orders-suppliers-2: lines are matched on `orders.imei` with whitespace removed on both sides.
 *
 * @param text an input
 * @returns the text without whitespace
 */
export function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * Reads the pasted text into lines.
 *
 * Why: ANSWERS orders Q13 and the console's paste dialog: each non-blank line is an input followed by a code, separated by
 * whitespace, a comma or a semicolon; the code keeps the rest of the line as typed (its own commas included).
 *
 * @param text the pasted text
 * @returns the non-blank lines with their 1-based position in the text
 */
export function parseBulkLines(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const match = /^([^\s,;]+)[\s,;]*(.*)$/.exec(trimmed);
    const imei = match?.[1] ?? null;
    const code = match?.[2]?.trim() ?? '';
    lines.push({ line: index + 1, raw, imei, code: code === '' ? null : code });
  });
  return lines;
}

/**
 * Decides the status of one line from the orders that carry its input.
 *
 * Why: the console shows `invalid` (no input or no code), `not_found` (no order with that input), `not_open` (only closed
 * ones), `ambiguous` (several open ones: staff must pick) and `matched`; only a matched line carries an order id.
 *
 * @param line the parsed line
 * @param candidates every order whose input equals the line's input, whitespace removed
 * @returns the status and the order id when matched
 */
export function matchLine(
  line: ParsedLine,
  candidates: readonly MatchCandidate[],
): { status: BulkReplyLineStatus; orderId: number | null } {
  if (line.imei === null || line.code === null) return { status: 'invalid', orderId: null };
  if (candidates.length === 0) return { status: 'not_found', orderId: null };
  const open = candidates.filter((candidate) => candidate.open);
  if (open.length === 0) return { status: 'not_open', orderId: null };
  if (open.length > 1) return { status: 'ambiguous', orderId: null };
  return { status: 'matched', orderId: open[0]!.id };
}
