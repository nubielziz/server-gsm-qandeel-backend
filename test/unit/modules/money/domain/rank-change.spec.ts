// Unit test of the pure rules of the rank change (decision 064): the plan of the wallets, the blockers money owns and their order and words,
// the one refusal inside a kind, and the key, memo and lines of the balance move.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { assertBalanced } from '@src/modules/money/domain/ledger-lines';
import {
  RANK_BLOCKER_MESSAGES,
  RANK_BLOCKER_ORDER,
  type RankMoneyFacts,
  blockerErrors,
  crossesKinds,
  isSameRequest,
  moneyBlockers,
  orderBlockers,
  planRankMove,
  rankMoveKey,
  rankMoveLines,
  rankMoveMemo,
  sameKindRefusal,
} from '@src/modules/money/domain/rank-change';

/** The facts of an account with nothing in flight: no blocker applies. */
const CLEAN: RankMoneyFacts = {
  hasAccount: true,
  holdBalance: Money.zero(),
  sourceBalance: Money.of('25'),
  anyWalletFrozen: false,
  openTopUp: false,
  openDispute: false,
  openBalanceRefund: false,
};

describe('the blocker codes', () => {
  it('lists the ten codes of decision 064, each once, each with its own sentence', () => {
    expect([...RANK_BLOCKER_ORDER]).toEqual([
      'guest',
      'open_hold',
      'live_order',
      'open_topup',
      'open_dispute',
      'open_refund',
      'open_checkout',
      'frozen',
      'negative_balance',
      'credit_limit',
    ]);
    const sentences = RANK_BLOCKER_ORDER.map((code) => RANK_BLOCKER_MESSAGES[code]);
    expect(new Set(sentences).size).toBe(10);
    for (const sentence of sentences) expect(sentence.trim().length).toBeGreaterThan(10);
  });

  it('puts codes in the canonical order and keeps each once, whatever order the modules found them in', () => {
    expect(orderBlockers(['frozen', 'live_order', 'guest', 'live_order', 'open_checkout'])).toEqual([
      'guest',
      'live_order',
      'open_checkout',
      'frozen',
    ]);
    expect(orderBlockers([])).toEqual([]);
  });

  it('answers one error per blocker on the field groupId, with the code and its sentence', () => {
    expect(blockerErrors(['negative_balance', 'open_hold'])).toEqual([
      { field: 'groupId', code: 'open_hold', message: RANK_BLOCKER_MESSAGES.open_hold },
      { field: 'groupId', code: 'negative_balance', message: RANK_BLOCKER_MESSAGES.negative_balance },
    ]);
  });
});

describe('crossesKinds and planRankMove', () => {
  it('tells a change between the two kinds from one inside a kind', () => {
    expect(crossesKinds('merchant', 'retail')).toBe(true);
    expect(crossesKinds('retail', 'merchant')).toBe(true);
    expect(crossesKinds('merchant', 'merchant')).toBe(false);
    expect(crossesKinds('retail', 'retail')).toBe(false);
  });

  it('merchant to retail: the merchant wallet empties into the store balance, which is opened, and the credit limit goes', () => {
    expect(planRankMove('merchant', 'retail')).toEqual({
      source: 'client_wallet',
      target: 'customer_wallet',
      open: ['customer_wallet'],
      clearsCreditLimit: true,
    });
  });

  it('retail to merchant: the store balance empties into the merchant wallet, which is opened with its hold', () => {
    expect(planRankMove('retail', 'merchant')).toEqual({
      source: 'customer_wallet',
      target: 'client_wallet',
      open: ['client_wallet', 'client_hold'],
      clearsCreditLimit: false,
    });
  });

  it('refuses a plan for a change that crosses nothing', () => {
    expect(() => planRankMove('merchant', 'merchant')).toThrow(RangeError);
    expect(() => planRankMove('retail', 'retail')).toThrow(RangeError);
  });
});

describe('moneyBlockers', () => {
  it('finds none for an account with nothing in flight, whatever positive balance it holds', () => {
    expect(moneyBlockers(CLEAN)).toEqual([]);
    expect(moneyBlockers({ ...CLEAN, sourceBalance: Money.zero() })).toEqual([]);
  });

  it('finds each blocker alone', () => {
    expect(moneyBlockers({ ...CLEAN, hasAccount: false })).toEqual(['guest']);
    expect(moneyBlockers({ ...CLEAN, holdBalance: Money.of('0.0001') })).toEqual(['open_hold']);
    expect(moneyBlockers({ ...CLEAN, openTopUp: true })).toEqual(['open_topup']);
    expect(moneyBlockers({ ...CLEAN, openDispute: true })).toEqual(['open_dispute']);
    expect(moneyBlockers({ ...CLEAN, openBalanceRefund: true })).toEqual(['open_refund']);
    expect(moneyBlockers({ ...CLEAN, anyWalletFrozen: true })).toEqual(['frozen']);
    expect(moneyBlockers({ ...CLEAN, sourceBalance: Money.of('-0.0001') })).toEqual(['negative_balance']);
  });

  it('finds every blocker that applies, together, in the canonical order', () => {
    const everything: RankMoneyFacts = {
      hasAccount: false,
      holdBalance: Money.of('5'),
      sourceBalance: Money.of('-5'),
      anyWalletFrozen: true,
      openTopUp: true,
      openDispute: true,
      openBalanceRefund: true,
    };
    expect(moneyBlockers(everything)).toEqual([
      'guest',
      'open_hold',
      'open_topup',
      'open_dispute',
      'open_refund',
      'frozen',
      'negative_balance',
    ]);
  });
});

describe('sameKindRefusal', () => {
  it('refuses a rank without credit while the credit limit is above zero', () => {
    expect(sameKindRefusal({ targetAllowsCredit: false, creditLimit: Money.of('500') })).toBe('credit_limit');
    expect(sameKindRefusal({ targetAllowsCredit: false, creditLimit: Money.of('0.0001') })).toBe('credit_limit');
  });

  it('lets the change through when the rank allows credit or the limit is zero', () => {
    expect(sameKindRefusal({ targetAllowsCredit: true, creditLimit: Money.of('500') })).toBeUndefined();
    expect(sameKindRefusal({ targetAllowsCredit: false, creditLimit: Money.zero() })).toBeUndefined();
  });
});

describe('the move of the balance', () => {
  it('keys the journal by the account and the request, so each request posts once', () => {
    expect(rankMoveKey(7, 'k-1')).toBe('rank:7:k-1');
    expect(rankMoveKey(7, 'k-2')).not.toBe(rankMoveKey(7, 'k-1'));
    expect(rankMoveKey(8, 'k-1')).not.toBe(rankMoveKey(7, 'k-1'));
  });

  it('words the memo by the direction and the new rank', () => {
    expect(rankMoveMemo('Storefront retail', 'retail')).toBe(
      'Moved to the store balance with the rank change to Storefront retail',
    );
    expect(rankMoveMemo('Gold', 'merchant')).toBe('Moved from the store balance with the rank change to Gold');
  });

  it('merchant to retail: debits the merchant wallet and credits the store balance of the same account', () => {
    const lines = rankMoveLines(7, planRankMove('merchant', 'retail'), Money.of('42.5'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ account: { kind: 'client_wallet', ownerType: 'account', ownerId: 7 } });
    expect(lines[0]!.debit.toWire()).toBe('42.5000');
    expect(lines[0]!.credit.isZero()).toBe(true);
    expect(lines[1]).toMatchObject({ account: { kind: 'customer_wallet', ownerType: 'account', ownerId: 7 } });
    expect(lines[1]!.credit.toWire()).toBe('42.5000');
    expect(lines[1]!.debit.isZero()).toBe(true);
    expect(() => assertBalanced(lines, 'USD')).not.toThrow();
  });

  it('retail to merchant: the reverse', () => {
    const lines = rankMoveLines(9, planRankMove('retail', 'merchant'), Money.of('3'));
    expect(lines[0]).toMatchObject({ account: { kind: 'customer_wallet', ownerType: 'account', ownerId: 9 } });
    expect(lines[0]!.debit.toWire()).toBe('3.0000');
    expect(lines[1]).toMatchObject({ account: { kind: 'client_wallet', ownerType: 'account', ownerId: 9 } });
    expect(lines[1]!.credit.toWire()).toBe('3.0000');
    expect(() => assertBalanced(lines, 'USD')).not.toThrow();
  });

  it('never builds the lines of an empty or negative move', () => {
    const plan = planRankMove('merchant', 'retail');
    expect(() => rankMoveLines(7, plan, Money.zero())).toThrow(RangeError);
    expect(() => rankMoveLines(7, plan, Money.of('-1'))).toThrow(RangeError);
  });
});

describe('isSameRequest', () => {
  it('a stored change replays only for the rank it named', () => {
    expect(isSameRequest({ toGroupId: 4 }, 4)).toBe(true);
    expect(isSameRequest({ toGroupId: 4 }, 5)).toBe(false);
  });
});
