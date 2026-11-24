// Bulk reply (POST /admin/orders/bulk-reply/preview): reading the pasted lines and matching them to orders. Pure; the use case
// loads the candidate orders by input and calls these functions.

/** The most lines one paste or one apply may hold (RESOLUTIONS orders-suppliers-19: at most 500 items per apply). */
export const MAX_BULK_ITEMS = 500;

/** How long an order closed by a cancel or a reject still keeps its input from matching another account's or service's order. */
export const RECENT_REJECTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** An order a line may match: its id, whether it is open, whose order of which service it is, and whether it was rejected lately. */
export interface MatchCandidate {
  readonly id: number;
  readonly open: boolean;
  /** The buyer and the service of the order as one key (`ownerKey`). */
  readonly owner: string;
  /** True when a cancel or a reject closed the order within the last `RECENT_REJECTION_DAYS` days (`isRecentRejection`). */
  readonly recentlyRejected: boolean;
}

/**
 * Names the buyer and the service of an order as one key.
 *
 * Why: a pasted result belongs to one account's order of one service; two orders with the same input but another account (a merchant, a shop
 * customer or a guest are all accounts, decision 064) or another service are different work, so `matchLine` compares these keys.
 *
 * @param order the order's buyer account and its service
 * @returns a key equal for two orders exactly when they have the same buyer account and the same service
 */
export function ownerKey(order: { readonly accountId: number; readonly serviceId: number }): string {
  return `account ${order.accountId} service ${order.serviceId}`;
}

/**
 * Says whether an order was closed by a cancel or a reject within the last `RECENT_REJECTION_DAYS` days.
 *
 * Why: staff may still hold the supplier's answer for an order that was cancelled or rejected while they worked on it; for a week
 * such an order keeps its input from matching another buyer's or service's open order.
 *
 * @param order the order's status and when it was closed
 * @param now the current time
 * @returns true for a `rejected` order closed at most `RECENT_REJECTION_DAYS` days before `now` (or after it)
 */
export function isRecentRejection(order: { readonly status: string; readonly closedAt: Date }, now: Date): boolean {
  return order.status === 'rejected' && now.getTime() - order.closedAt.getTime() <= RECENT_REJECTION_DAYS * DAY_MS;
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
 * whitespace, a comma or a semicolon; the code keeps the rest of the line as typed (its own commas included). Decision 051: lines end at
 * CRLF, CR, LF, U+2028 or U+2029, so no line holds a character the line pattern's `.` cannot match and reading a line takes time in
 * proportion to its length.
 *
 * @param text the pasted text
 * @returns the non-blank lines with their 1-based position in the text
 */
export function parseBulkLines(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  text.split(/\r\n|\r|\n|\u2028|\u2029/).forEach((raw, index) => {
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
 * ones), `ambiguous` and `matched`; only a matched line carries an order id. A line is matched only when exactly one order with
 * its input is open and no order with that input but another buyer or another service is open or was closed by a cancel or a
 * reject in the last `RECENT_REJECTION_DAYS` days: a result must complete the order it was meant for, so staff reply to such a
 * line on the order itself.
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
  const match = open[0]!;
  const rival = candidates.some(
    (candidate) =>
      candidate.id !== match.id && candidate.owner !== match.owner && (candidate.open || candidate.recentlyRejected),
  );
  if (rival) return { status: 'ambiguous', orderId: null };
  return { status: 'matched', orderId: match.id };
}
