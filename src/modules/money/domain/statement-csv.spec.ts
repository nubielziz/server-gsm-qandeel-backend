// Unit tests of the statement CSV (route GET /client/wallet/statement?format=csv): RFC 4180 quoting and formula safety.
import { describe, expect, it } from 'bun:test';
import { csvTextCell, statementCsv } from './statement-csv';

const line = (memo: string, kind = 'deposit') => ({
  createdAt: '2026-10-28T09:30:00.000Z',
  transactionId: 12,
  kind,
  memo,
  amount: '-5.0000',
  balanceAfter: '95.0000',
});

describe('csvTextCell', () => {
  it('quotes a cell with a comma, a quote or a line break and doubles the quotes', () => {
    expect(csvTextCell('a,b')).toBe('"a,b"');
    expect(csvTextCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvTextCell('two\nlines')).toBe('"two\nlines"');
    expect(csvTextCell('plain')).toBe('plain');
  });

  it('turns a cell that starts like a formula into text', () => {
    for (const risky of ['=SUM(A1:A9)', '+1', '-1', '@cmd', '\tx', '\rx']) {
      expect(csvTextCell(risky).replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });
});

describe('statementCsv', () => {
  it('writes a header, then one CRLF-terminated row per line with exact amounts', () => {
    expect(statementCsv([line('Deposit PAY-1')])).toBe(
      'createdAt,transactionId,kind,memo,amount,balanceAfter\r\n' +
        '2026-10-28T09:30:00.000Z,12,deposit,Deposit PAY-1,-5.0000,95.0000\r\n',
    );
  });

  it('writes only the header for no lines', () => {
    expect(statementCsv([])).toBe('createdAt,transactionId,kind,memo,amount,balanceAfter\r\n');
  });

  it('keeps a staff-typed memo from running as a formula', () => {
    expect(statementCsv([line('=HYPERLINK("http://x")', 'adjustment')])).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});
