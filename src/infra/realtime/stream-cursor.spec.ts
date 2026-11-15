// Unit tests of the composite stream cursor (decision 037): parse and format, unknown letters, malformed parts, the length cap.
import { describe, expect, it } from 'bun:test';
import { MAX_CURSOR_LENGTH, formatStreamCursor, parseStreamCursor, streamCursorOf } from './stream-cursor';

const LETTERS = new Set(['i', 't']);

describe('parseStreamCursor', () => {
  it('reads every part of a known source', () => {
    expect([...parseStreamCursor('i9001-t5521', LETTERS)]).toEqual([
      ['i', 9001],
      ['t', 5521],
    ]);
    expect([...parseStreamCursor('i0', LETTERS)]).toEqual([['i', 0]]);
  });

  it('ignores unknown letters and malformed parts, keeping the rest', () => {
    expect([...parseStreamCursor('x5-i12', LETTERS)]).toEqual([['i', 12]]);
    for (const bad of ['i', 'i-3', 'I12', 'i12a', 'i 12', 'ii12', 'i1e3', '12', 'i1234567890123456'])
      expect(parseStreamCursor(bad, LETTERS).size, bad).toBe(0);
    expect([...parseStreamCursor('garbage-t7--', LETTERS)]).toEqual([['t', 7]]);
  });

  it('keeps the first value of a repeated letter', () => {
    expect([...parseStreamCursor('i5-i9', LETTERS)]).toEqual([['i', 5]]);
  });

  it('treats a cursor over 64 characters, an empty one or none as a fresh start', () => {
    const long = `i1-${'x'.repeat(MAX_CURSOR_LENGTH)}`;
    expect(parseStreamCursor(long, LETTERS).size).toBe(0);
    expect(parseStreamCursor(`i1${'-'.repeat(MAX_CURSOR_LENGTH - 2)}`, LETTERS).size).toBe(1);
    expect(parseStreamCursor('', LETTERS).size).toBe(0);
    expect(parseStreamCursor(undefined, LETTERS).size).toBe(0);
  });
});

describe('formatStreamCursor', () => {
  it('joins the parts in source order and skips a missing one', () => {
    const parts = new Map([
      ['t', 5521],
      ['i', 9001],
    ]);
    expect(formatStreamCursor(parts, ['i', 't'])).toBe('i9001-t5521');
    expect(formatStreamCursor(new Map([['t', 3]]), ['i', 't'])).toBe('t3');
    expect(formatStreamCursor(new Map(), ['i'])).toBe('');
  });

  it('round-trips through the parser', () => {
    const parts = new Map([
      ['i', 42],
      ['t', 0],
    ]);
    expect(parseStreamCursor(formatStreamCursor(parts, ['i', 't']), LETTERS)).toEqual(parts);
  });
});

describe('streamCursorOf', () => {
  it('prefers the Last-Event-ID header over the query', () => {
    expect(streamCursorOf('i9', 'i3')).toBe('i9');
    expect(streamCursorOf(undefined, 'i3')).toBe('i3');
    expect(streamCursorOf('', 'i3')).toBe('i3');
    expect(streamCursorOf(undefined, '')).toBeUndefined();
    expect(streamCursorOf(undefined, undefined)).toBeUndefined();
  });
});
