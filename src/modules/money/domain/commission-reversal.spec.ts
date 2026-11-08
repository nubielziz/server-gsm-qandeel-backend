// Unit tests of the commission reversal (user rule 5): the exact mirror of the `commission` event, on the same reference type.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { assertBalanced } from './ledger-lines';
import { commission, commissionReversal } from './money-events';

const m = (amount: string): Money => Money.of(amount);

describe('commissionReversal', () => {
  it('gives the commission back: Dr the agent wallet, Cr commission_expense, balanced', () => {
    const posting = commissionReversal({ clientId: 7, amount: m('0.49') });
    expect(posting.lines.map((line) => [line.account.kind, line.debit.toWire(), line.credit.toWire()])).toEqual([
      ['client_wallet', '0.4900', '0.0000'],
      ['commission_expense', '0.0000', '0.4900'],
    ]);
    expect(posting.lines[0]!.account).toEqual({ kind: 'client_wallet', ownerType: 'client', ownerId: 7 });
    expect(() => assertBalanced(posting.lines, 'USD')).not.toThrow();
  });

  it('keeps the kind `commission` and the reference type `accrual` of the event it reverses', () => {
    const paid = commission({ clientId: 7, amount: m('1.05') });
    const back = commissionReversal({ clientId: 7, amount: m('1.05') });
    expect(back.kind).toBe(paid.kind);
    expect(back.kind).toBe('commission');
    expect(back.refType).toBe('accrual');
    expect(back.event).toBe('commission_reversal');
  });

  it('nets to nothing with the commission it reverses, line by line', () => {
    const paid = commission({ clientId: 7, amount: m('1.05') });
    const back = commissionReversal({ clientId: 7, amount: m('1.05') });
    const net = (kind: string) =>
      [...paid.lines, ...back.lines]
        .filter((line) => line.account.kind === kind)
        .reduce((sum, line) => sum.add(line.debit).sub(line.credit), Money.zero());
    expect(net('client_wallet').isZero()).toBe(true);
    expect(net('commission_expense').isZero()).toBe(true);
  });
});
