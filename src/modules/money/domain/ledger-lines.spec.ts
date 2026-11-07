// Unit tests of the posting checks (decision 024 step 1): at least two lines, one positive side each, debits = credits,
// one currency, else LEDGER_UNBALANCED.
import { describe, expect, it } from 'bun:test';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { type LedgerLine, assertBalanced, creditLine, debitLine } from './ledger-lines';

const bank = { kind: 'bank' } as const;
const revenue = { kind: 'revenue' } as const;
const m = (amount: string) => Money.of(amount);
const code = (lines: readonly LedgerLine[], currency = 'USD') => {
  try {
    assertBalanced(lines, currency);
  } catch (error) {
    return error instanceof AppError ? error.code : String(error);
  }
  return 'ok';
};

describe('assertBalanced', () => {
  it('accepts a balanced posting of two or more lines', () => {
    expect(code([...debitLine(bank, m('10')), ...creditLine(revenue, m('10'))])).toBe('ok');
    expect(code([...debitLine(bank, m('10')), ...creditLine(revenue, m('4')), ...creditLine(revenue, m('6'))])).toBe(
      'ok',
    );
  });

  it('refuses fewer than two lines', () => {
    expect(code([])).toBe('LEDGER_UNBALANCED');
    expect(code(debitLine(bank, m('10')))).toBe('LEDGER_UNBALANCED');
  });

  it('refuses debits that differ from credits, by even 0.0001', () => {
    expect(code([...debitLine(bank, m('10.0001')), ...creditLine(revenue, m('10'))])).toBe('LEDGER_UNBALANCED');
  });

  it('refuses a line with both sides, with neither, or with a negative side', () => {
    const both: LedgerLine = { account: bank, debit: m('1'), credit: m('1') };
    const neither: LedgerLine = { account: bank, debit: Money.zero(), credit: Money.zero() };
    const negative: LedgerLine = { account: bank, debit: m('-1'), credit: Money.zero() };
    const good = creditLine(revenue, m('1'));
    for (const bad of [both, neither, negative]) expect(code([bad, ...good])).toBe('LEDGER_UNBALANCED');
  });

  it('refuses an account in another currency than the posting', () => {
    const lines = [...debitLine({ ...bank, currency: 'EUR' }, m('10')), ...creditLine(revenue, m('10'))];
    expect(code(lines)).toBe('LEDGER_UNBALANCED');
    // A line without its own currency takes the posting's, so the same lines are one currency in a EUR posting.
    expect(code(lines, 'EUR')).toBe('ok');
  });
});

describe('debitLine and creditLine', () => {
  it('drop a zero amount and refuse a negative one', () => {
    expect(debitLine(bank, Money.zero())).toEqual([]);
    expect(() => creditLine(bank, m('-0.0001'))).toThrow(RangeError);
  });
});
