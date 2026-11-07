// Unit tests of the cursor paging helpers of REST v1 lists (ALIGNMENT § 7): the cursor text, the page cut and the query fields.
import { describe, expect, it } from 'bun:test';
import { AppError } from '../errors';
import {
  CURSOR_DEFAULT_LIMIT,
  CURSOR_MAX_LIMIT,
  cutPage,
  decodeCursor,
  encodeCursor,
  zCursor,
  zCursorLimit,
  zCursorPage,
} from './cursor';
import { z } from 'zod';

/** The error a bad cursor throws. */
function cursorError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the cursor to be refused');
}

describe('encodeCursor and decodeCursor', () => {
  it('round trips numbers and text through an opaque URL-safe text', () => {
    const text = encodeCursor([4711, 'a b/c+d']);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(text, ['number', 'string'] as const)).toEqual([4711, 'a b/c+d']);
    expect(decodeCursor(encodeCursor([7]), ['number'] as const)[0]).toBe(7);
  });

  it('refuses text that is not a cursor of this list, on the field `cursor`', () => {
    const cases: Array<[string, readonly ('number' | 'string')[]]> = [
      ['not a cursor', ['number']],
      ['', ['number']],
      [Buffer.from('"x"').toString('base64url'), ['number']],
      [Buffer.from('[1,2]').toString('base64url'), ['number']],
      [Buffer.from('["1"]').toString('base64url'), ['number']],
      [Buffer.from('[1.5]').toString('base64url'), ['number']],
      [Buffer.from('[9007199254740993]').toString('base64url'), ['number']],
      [Buffer.from('[1]').toString('base64url'), ['string']],
      [Buffer.from('[1]').toString('base64url'), ['number', 'number']],
    ];
    for (const [text, shape] of cases) {
      const error = cursorError(() => decodeCursor(text, shape));
      expect(error.code, text).toBe('VALIDATION_FAILED');
      expect(error.errors[0]).toMatchObject({ field: 'cursor', code: 'invalid_cursor' });
    }
  });
});

describe('cutPage', () => {
  const rows = [{ id: 5 }, { id: 4 }, { id: 3 }];

  it('sends the page and a cursor after its last row when one more row was read', () => {
    const page = cutPage(rows, 2, (row) => [row.id]);
    expect(page.data).toEqual([{ id: 5 }, { id: 4 }]);
    expect(decodeCursor(page.nextCursor!, ['number'] as const)).toEqual([4]);
  });

  it('says nextCursor null on the last page, exactly full or not', () => {
    expect(cutPage(rows, 3, (row) => [row.id])).toEqual({ data: rows, nextCursor: null });
    expect(cutPage(rows, 10, (row) => [row.id]).nextCursor).toBeNull();
    expect(cutPage([], 2, (row: { id: number }) => [row.id])).toEqual({ data: [], nextCursor: null });
  });
});

describe('the query fields and the page schema', () => {
  it('reads limit from text, defaults it to 50 and keeps it in 1 to 100', () => {
    expect(zCursorLimit.parse(undefined)).toBe(CURSOR_DEFAULT_LIMIT);
    expect(zCursorLimit.parse('25')).toBe(25);
    expect(zCursorLimit.parse(String(CURSOR_MAX_LIMIT))).toBe(CURSOR_MAX_LIMIT);
    for (const bad of ['0', '101', '1.5', 'x', '-1']) expect(zCursorLimit.safeParse(bad).success, bad).toBe(false);
  });

  it('takes an optional cursor of 1 to 512 characters', () => {
    expect(zCursor.parse(undefined)).toBeUndefined();
    expect(zCursor.safeParse('').success).toBe(false);
    expect(zCursor.safeParse('x'.repeat(513)).success).toBe(false);
    expect(zCursor.parse('abc')).toBe('abc');
  });

  it('describes a page as { data, nextCursor }', () => {
    const page = zCursorPage(z.object({ id: z.number() }));
    expect(page.parse({ data: [{ id: 1 }], nextCursor: null })).toEqual({ data: [{ id: 1 }], nextCursor: null });
    expect(page.safeParse({ data: [] }).success).toBe(false);
  });
});
