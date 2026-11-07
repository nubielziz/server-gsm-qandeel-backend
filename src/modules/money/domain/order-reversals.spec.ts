// Unit tests of the two reversals the order engine posts beyond the map's 13 money events (decision 024): reopen (B2B and B2C)
// and the B2B refund of a completed order. Each is balanced, keeps the cost booked and moves revenue only.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { assertBalanced } from './ledger-lines';
import { REVERSAL_EVENT_IDS, REVERSAL_KINDS, type ReversalPosting, refund, reopen, reopenB2c } from './money-events';

const m = (amount: string): Money => Money.of(amount);

/** The posting as `[account, debit, credit]` triples, like the map writes its events. */
function triples(posting: ReversalPosting): Array<[string, number, number]> {
  return posting.lines.map((line) => [line.account.kind, Number(line.debit.toWire()), Number(line.credit.toWire())]);
}

describe('reopen', () => {
  it('B2B: the revenue goes back to the merchant hold and the cost is not touched', () => {
    const posting = reopen({ clientId: 7, amount: m('5') });
    expect(triples(posting)).toEqual([
      ['revenue', 5, 0],
      ['client_hold', 0, 5],
    ]);
    expect(posting.lines[1]!.account).toEqual({ kind: 'client_hold', ownerType: 'client', ownerId: 7 });
    expect(() => assertBalanced(posting.lines, 'USD')).not.toThrow();
  });

  it('B2C: the revenue goes back to customer funds', () => {
    const posting = reopenB2c({ net: m('12.49') });
    expect(triples(posting)).toEqual([
      ['revenue', 12.49, 0],
      ['customer_funds', 0, 12.49],
    ]);
    expect(() => assertBalanced(posting.lines, 'USD')).not.toThrow();
  });

  it('is the exact mirror of the revenue line of complete, so a second completion nets to the original books', () => {
    const posting = reopen({ clientId: 7, amount: m('3.31') });
    expect(posting.lines.map((line) => line.debit.toWire())).toEqual(['3.3100', '0.0000']);
  });
});

describe('refund', () => {
  it('B2B: the revenue goes straight back to the wallet, the hold and the cost stay as they are', () => {
    const posting = refund({ clientId: 7, amount: m('5') });
    expect(triples(posting)).toEqual([
      ['revenue', 5, 0],
      ['client_wallet', 0, 5],
    ]);
    expect(posting.lines[1]!.account).toEqual({ kind: 'client_wallet', ownerType: 'client', ownerId: 7 });
    expect(() => assertBalanced(posting.lines, 'USD')).not.toThrow();
  });

  it('is the same net effect as reopen then reject: the wallet gets the price back once', () => {
    const direct = refund({ clientId: 7, amount: m('5') });
    const walletCredit = direct.lines.find((line) => line.account.kind === 'client_wallet')!;
    expect(walletCredit.credit.toWire()).toBe('5.0000');
  });
});

describe('the reversal vocabulary', () => {
  it('names the ids and posts under the console kinds and the order reference', () => {
    expect([...REVERSAL_EVENT_IDS]).toEqual(['reopen', 'refund']);
    expect(REVERSAL_KINDS).toEqual({ reopen: 'adjustment', refund: 'refund' });
    for (const posting of [reopen({ clientId: 1, amount: m('1') }), refund({ clientId: 1, amount: m('1') })]) {
      expect(posting.refType).toBe('order');
      expect(posting.kind).toBe(REVERSAL_KINDS[posting.event]);
    }
  });

  it('refuses a negative amount and drops a zero one', () => {
    expect(() => reopen({ clientId: 1, amount: m('-1') })).toThrow(RangeError);
    expect(reopen({ clientId: 1, amount: Money.zero() }).lines).toEqual([]);
  });
});
