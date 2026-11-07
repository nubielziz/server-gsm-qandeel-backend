// Cursor paging of REST v1 lists (ALIGNMENT § 7): `?limit=` (1-100, default 50) and an opaque `?cursor=` answer `{ data, nextCursor }`.
// The helpers build the query fields, the page schema and the cursor text; the repository of each list picks the sort key.
import { z } from 'zod';
import { AppError } from '../errors/app-error';

/** The page size of a cursor list when the caller sends no `limit`. */
export const CURSOR_DEFAULT_LIMIT = 50;

/** The largest page of a cursor list. */
export const CURSOR_MAX_LIMIT = 100;

/**
 * The `limit` query field of a cursor list: 1 to 100, default 50.
 *
 * Why: ALIGNMENT § 7 fixes the page size range for every REST v1 list; query values arrive as text, so it is coerced.
 */
export const zCursorLimit = z.coerce
  .number()
  .int('Must be a whole number.')
  .min(1, 'Must be at least 1.')
  .max(CURSOR_MAX_LIMIT, `Must be at most ${CURSOR_MAX_LIMIT}.`)
  .default(CURSOR_DEFAULT_LIMIT)
  .describe(`How many rows to return, 1 to ${CURSOR_MAX_LIMIT} (default ${CURSOR_DEFAULT_LIMIT}).`);

/**
 * The `cursor` query field of a cursor list: the `nextCursor` of the previous page.
 *
 * Why: the text is opaque to the client; only the server reads it back.
 */
export const zCursor = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .describe('The `nextCursor` of the previous page; leave it out for the first page.');

/**
 * The schema of a page of a cursor list.
 *
 * @param row the schema of one row
 * @returns `{ data: row[], nextCursor: string | null }`
 */
export function zCursorPage<R extends z.ZodType>(row: R) {
  return z.object({
    data: z.array(row),
    nextCursor: z.string().nullable().describe('Pass it as `cursor` to get the next page; `null` on the last page.'),
  });
}

/**
 * Writes a cursor.
 *
 * @param position the sort key of the last row of the page (numbers and text)
 * @returns an opaque URL-safe text
 */
export function encodeCursor(position: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/**
 * Reads a cursor back.
 *
 * @param text the `cursor` query value
 * @param shape the kinds of the parts the list's cursor holds, in order (`number` or `string`)
 * @returns the parts
 * @throws {AppError} `VALIDATION_FAILED` on `cursor` when the text is not a cursor of this list
 */
export function decodeCursor<const K extends readonly ('number' | 'string')[]>(
  text: string,
  shape: K,
): { [I in keyof K]: K[I] extends 'number' ? number : string } {
  const bad = () =>
    new AppError('VALIDATION_FAILED', {
      detail: 'The cursor is not valid. Use the nextCursor of the previous page.',
      errors: [{ field: 'cursor', code: 'invalid_cursor', message: 'This cursor is not valid for this list.' }],
    });
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parts) || parts.length !== shape.length) throw bad();
  shape.forEach((kind, index) => {
    const part: unknown = parts[index];
    if (kind === 'number' ? typeof part !== 'number' || !Number.isSafeInteger(part) : typeof part !== 'string')
      throw bad();
  });
  return parts as { [I in keyof K]: K[I] extends 'number' ? number : string };
}

/**
 * Cuts a page out of rows read with one extra row.
 *
 * Why: the repositories ask for `limit + 1` rows; the extra row only says there is a next page, and the cursor points after the last
 * row that is sent.
 *
 * @param rows the rows read, at most `limit + 1`
 * @param limit the page size
 * @param positionOf the sort key of a row
 * @returns the rows of the page and the cursor of the next one (`null` on the last page)
 */
export function cutPage<T>(
  rows: readonly T[],
  limit: number,
  positionOf: (row: T) => readonly (string | number)[],
): { data: T[]; nextCursor: string | null } {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return { data, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(positionOf(last)) : null };
}
