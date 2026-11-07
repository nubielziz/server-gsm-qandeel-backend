// Unit tests of the order CSV: quoting, spreadsheet-formula protection and the two column sets.
import { describe, expect, it } from 'bun:test';
import { ADMIN_ORDER_CSV_COLUMNS, CLIENT_ORDER_CSV_COLUMNS, csvCell, csvHeader, csvLine } from './order-csv';

describe('csvCell', () => {
  it('writes plain text, numbers and nothing as they are', () => {
    expect(csvCell('abc')).toBe('abc');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a cell with a comma, a quote or a line break and doubles the quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('prefixes a cell that would run as a formula with an apostrophe', () => {
    for (const text of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(text).replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    // A minus inside the text is fine.
    expect(csvCell('a-b')).toBe('a-b');
  });
});

describe('lines and columns', () => {
  it('ends every line with CRLF', () => {
    expect(csvLine([1, 'a', null])).toBe('1,a,\r\n');
    expect(csvHeader(['a', 'b'])).toBe('a,b\r\n');
  });

  it('the merchant export has no cost and no supplier column', () => {
    expect([...ADMIN_ORDER_CSV_COLUMNS]).toEqual([
      'id',
      'created',
      'channel',
      'buyer',
      'service',
      'input',
      'status',
      'supplier',
      'price',
      'cost',
    ]);
    expect([...CLIENT_ORDER_CSV_COLUMNS]).toEqual([
      'id',
      'created',
      'service',
      'input',
      'quantity',
      'status',
      'price',
      'currency',
    ]);
    expect(CLIENT_ORDER_CSV_COLUMNS).not.toContain('cost' as never);
    expect(CLIENT_ORDER_CSV_COLUMNS).not.toContain('supplier' as never);
  });
});
