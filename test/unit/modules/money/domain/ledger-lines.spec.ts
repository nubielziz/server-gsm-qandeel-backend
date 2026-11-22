// Unit tests of the posting checks (decision 024 step 1): at least two lines, one positive side each, debits = credits,
// one currency, else LEDGER_UNBALANCED.
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import { Money } from '@src/common/money';
import {
  type LedgerLine,
  assertBalanced,
  creditLine,
  debitLine,
  reversalLines,
} from '@src/modules/money/domain/ledger-lines';

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

describe('reversalLines', () => {
  it('mirrors every entry of a posted journal on the same account, so the two sum to zero (decision 048)', () => {
    const clearing = { kind: 'gateway_clearing' } as const;
    const funds = { kind: 'customer_funds' } as const;
    const vat = { kind: 'vat_payable' } as const;
    // A refund journal as stored (signed, debit positive): Dr customer funds 3.99, Dr VAT 0.80, Cr gateway clearing 4.79.
    const lines = reversalLines([
      { amount: m('3.9900'), account: funds },
      { amount: m('0.8000'), account: vat },
      { amount: m('-4.7900'), account: clearing },
    ]);
    expect(lines).toEqual([
      ...creditLine(funds, m('3.99')),
      ...creditLine(vat, m('0.80')),
      ...debitLine(clearing, m('4.79')),
    ]);
    expect(code(lines)).toBe('ok');
    const wallet = { kind: 'customer_wallet', ownerType: 'customer', ownerId: 7 } as const;
    expect(reversalLines([{ amount: m('-2.0000'), account: wallet }])).toEqual(debitLine(wallet, m('2')));
  });
});
