// Unit tests of the ledger search text (resolution money-15) and of LIKE escaping.
import { describe, expect, it } from 'bun:test';
import { escapeLike, parseLedgerSearch } from './ledger-search';

describe('parseLedgerSearch', () => {
  it('reads a plain positive whole number as an id search (the console already stripped JRN- and zeros)', () => {
    expect(parseLedgerSearch('25')).toEqual({ kind: 'id', id: 25 });
    expect(parseLedgerSearch(' 48100 ')).toEqual({ kind: 'id', id: 48100 });
  });

  it('reads everything else as text', () => {
    for (const text of ['deposit', 'JRN-00025', '0', '007', '12.5', '-3', 'Zain Mobile Hub', '99999999999999999999']) {
      expect(parseLedgerSearch(text)).toEqual({ kind: 'text', text });
    }
  });
});

describe('escapeLike', () => {
  it('makes % and _ and the escape character match themselves', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('plain')).toBe('plain');
  });
});
