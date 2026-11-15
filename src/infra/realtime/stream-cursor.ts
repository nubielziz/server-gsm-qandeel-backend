// The composite cursor of a live stream (decision 037): one part per source, `<letter><id>`, joined by `-` (`i9001-t5521`). It is
// the `id:` of every replayable frame, and a reconnect sends it back (`Last-Event-ID`, or `?cursor=`). Pure functions.

/** The longest cursor read; a longer one is ignored as a whole (the stream starts fresh). */
export const MAX_CURSOR_LENGTH = 64;

const PART = /^([a-z])(\d{1,15})$/;

/**
 * Reads a cursor a client sent back.
 *
 * Why: the cursor comes from the client and is never trusted: unknown letters and malformed parts are ignored (that source
 * starts at its head), a repeated letter keeps its first value, and anything over {@link MAX_CURSOR_LENGTH} characters counts as
 * no cursor at all.
 *
 * @param text the `Last-Event-ID` header or the `cursor` query value
 * @param letters the cursor letters of the registered sources
 * @returns the accepted parts, by letter (empty: a fresh stream)
 */
export function parseStreamCursor(text: string | undefined, letters: ReadonlySet<string>): Map<string, number> {
  const parts = new Map<string, number>();
  if (text === undefined || text.length === 0 || text.length > MAX_CURSOR_LENGTH) return parts;
  for (const piece of text.split('-')) {
    const match = PART.exec(piece);
    if (!match) continue;
    const letter = match[1]!;
    const id = Number(match[2]);
    if (!letters.has(letter) || parts.has(letter) || !Number.isSafeInteger(id)) continue;
    parts.set(letter, id);
  }
  return parts;
}

/**
 * Writes the composite cursor of a connection.
 *
 * Why: the browser sends the last `id:` it saw back on reconnect; one string must carry the position of every source.
 *
 * @param parts the connection's position per source letter
 * @param order the source letters in registration order (the order of the parts)
 * @returns `i9001-t5521`, or an empty string when there is no part
 */
export function formatStreamCursor(parts: ReadonlyMap<string, number>, order: readonly string[]): string {
  const out: string[] = [];
  for (const letter of order) {
    const id = parts.get(letter);
    if (id !== undefined) out.push(`${letter}${id}`);
  }
  return out.join('-');
}

/**
 * Picks the cursor of a stream request: the `Last-Event-ID` header wins over `?cursor=`.
 *
 * Why: the browser's own reconnect sends the header; a client that opens a new `EventSource` (after a refusal, or in another tab
 * that takes the lead) can only use the query (plan § 3.5).
 *
 * @param header the `last-event-id` header, if any
 * @param query the `cursor` query value, if any
 * @returns the cursor text to parse, or `undefined`
 */
export function streamCursorOf(header: string | undefined, query: string | undefined): string | undefined {
  if (header !== undefined && header !== '') return header;
  return query === '' ? undefined : query;
}
