// Unit test of the wallet kind a rank kind uses (decision 064).
import { describe, expect, it } from 'bun:test';
import type { RankKind } from '@src/modules/identity';
import { walletKindOfRank } from '@src/modules/money/domain/wallet-kinds';

/** A value a stored column or a bad caller could produce, passed where the type promises a rank kind. */
const stray = (value: unknown): RankKind => value as RankKind;

describe('walletKindOfRank', () => {
  it('gives a merchant rank the client wallet and a retail rank the customer wallet', () => {
    expect(walletKindOfRank('merchant')).toBe('client_wallet');
    expect(walletKindOfRank('retail')).toBe('customer_wallet');
  });

  it('fails closed: a kind that is neither gets the retail wallet, never the merchant one', () => {
    expect(walletKindOfRank(stray('something-else'))).toBe('customer_wallet');
    expect(walletKindOfRank(stray(undefined))).toBe('customer_wallet');
  });
});
