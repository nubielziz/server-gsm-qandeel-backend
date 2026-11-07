// Unit tests of the bulk reply reading and matching (docs/contract/endpoints/orders.md, bulk-reply/preview).
import { describe, expect, it } from 'bun:test';
import { MAX_BULK_ITEMS, matchLine, parseBulkLines, squash } from './bulk-reply';

describe('parseBulkLines', () => {
  it('splits the input from the code on whitespace, comma or semicolon and keeps the rest of the line as typed', () => {
    const lines = parseBulkLines('111 code one\n222,code two\n333;a, b; c\n444\t tabbed  ');
    expect(lines.map((line) => [line.imei, line.code])).toEqual([
      ['111', 'code one'],
      ['222', 'code two'],
      ['333', 'a, b; c'],
      ['444', 'tabbed'],
    ]);
  });

  it('skips blank lines but counts them in the line numbers, and reads CRLF text', () => {
    const lines = parseBulkLines('111 a\r\n\r\n   \r\n222 b');
    expect(lines.map((line) => line.line)).toEqual([1, 4]);
    expect(lines[0]!.raw).toBe('111 a');
  });

  it('gives a line with an input only no code', () => {
    expect(parseBulkLines('111')[0]).toMatchObject({ imei: '111', code: null });
    expect(parseBulkLines('111,;  ')[0]).toMatchObject({ imei: '111', code: null });
    expect(parseBulkLines('')).toEqual([]);
  });

  it('names the cap of the paste', () => {
    expect(MAX_BULK_ITEMS).toBe(500);
  });
});

describe('matchLine', () => {
  const line = (imei: string | null, code: string | null) => ({ line: 1, raw: '', imei, code });
  it('is invalid without an input or a code', () => {
    expect(matchLine(line(null, 'x'), [])).toEqual({ status: 'invalid', orderId: null });
    expect(matchLine(line('1', null), [{ id: 5, open: true }])).toEqual({ status: 'invalid', orderId: null });
  });

  it('is not_found without orders, not_open with only closed ones, ambiguous with several open ones and matched with one', () => {
    expect(matchLine(line('1', 'x'), [])).toEqual({ status: 'not_found', orderId: null });
    expect(matchLine(line('1', 'x'), [{ id: 5, open: false }])).toEqual({ status: 'not_open', orderId: null });
    expect(
      matchLine(line('1', 'x'), [
        { id: 5, open: true },
        { id: 6, open: true },
      ]),
    ).toEqual({
      status: 'ambiguous',
      orderId: null,
    });
    expect(
      matchLine(line('1', 'x'), [
        { id: 5, open: false },
        { id: 6, open: true },
      ]),
    ).toEqual({
      status: 'matched',
      orderId: 6,
    });
  });
});

describe('squash', () => {
  it('removes every kind of whitespace', () => {
    expect(squash(' SN 566A\t15082\n')).toBe('SN566A15082');
  });
});
