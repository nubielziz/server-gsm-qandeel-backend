// Unit tests of the buyer rules of the order engine (decision 064): who may place an order from a wallet, which money moves
// read the account's live wallet, when a reopen is refused after a crossing, and which wallet a refund credits. Pure, no database.
import { describe, expect, it } from 'bun:test';
import { ORDER_SOURCES } from '@src/modules/orders/db/schema';
import {
  PLACEMENT_REFUSAL_DETAILS,
  REOPEN_REFUSED_DETAIL,
  placementRefusal,
  readsLiveWallet,
  refundCreditsKind,
  reopenRefusal,
} from '@src/modules/orders/domain/buyer-rules';
import type { OrderMoneyMove } from '@src/modules/orders/domain/order-machine';

const MOVES: readonly (OrderMoneyMove | null)[] = [
  null,
  'complete',
  'b2c_deliver',
  'reject',
  'b2c_refund',
  'reopen',
  'refund',
];
const HELD_DOORS = ORDER_SOURCES.filter((source) => source !== 'store');

describe('placementRefusal', () => {
  it('lets an account of a merchant rank that may act place an order', () => {
    expect(placementRefusal({ rankKind: 'merchant', mayAct: true })).toBeUndefined();
  });

  it('refuses a retail rank with RANK_NOT_ALLOWED, and the rank is judged before the status', () => {
    expect(placementRefusal({ rankKind: 'retail', mayAct: true })).toBe('RANK_NOT_ALLOWED');
    expect(placementRefusal({ rankKind: 'retail', mayAct: false })).toBe('RANK_NOT_ALLOWED');
  });

  it('refuses a merchant account that may not act (suspended, blocked, anonymized) with ACCOUNT_SUSPENDED', () => {
    expect(placementRefusal({ rankKind: 'merchant', mayAct: false })).toBe('ACCOUNT_SUSPENDED');
  });

  it('has a plain English sentence for each refusal', () => {
    expect(Object.keys(PLACEMENT_REFUSAL_DETAILS).sort()).toEqual(['ACCOUNT_SUSPENDED', 'RANK_NOT_ALLOWED']);
    for (const detail of Object.values(PLACEMENT_REFUSAL_DETAILS)) expect(detail).toMatch(/^[A-Z].*\.$/);
  });
});

describe('readsLiveWallet', () => {
  it('is true only for the refund and the reopen of an order held from a wallet', () => {
    for (const source of ORDER_SOURCES) {
      for (const move of MOVES) {
        const expected = source !== 'store' && (move === 'refund' || move === 'reopen');
        expect(readsLiveWallet({ source }, move), `${source} ${String(move)}`).toBe(expected);
      }
    }
  });
});

describe('reopenRefusal', () => {
  it('refuses the reopen of a hold-and-settle order once its account lives on a store balance (409 RANK_CHANGED)', () => {
    for (const source of HELD_DOORS) expect(reopenRefusal({ source }, 'reopen', 'store'), source).toBe('RANK_CHANGED');
    expect(REOPEN_REFUSED_DETAIL).toBe('Refund the order instead.');
  });

  it('lets the reopen through while the account still holds a merchant wallet', () => {
    for (const source of HELD_DOORS) expect(reopenRefusal({ source }, 'reopen', 'merchant'), source).toBeUndefined();
  });

  it('never refuses a refund, whatever the wallet: a refund credits the live wallet instead', () => {
    for (const wallet of ['merchant', 'store'] as const) {
      for (const source of ORDER_SOURCES) expect(reopenRefusal({ source }, 'refund', wallet)).toBeUndefined();
    }
  });

  it('never refuses a shop order: it reopens into customer funds, whatever rank its account has now', () => {
    expect(reopenRefusal({ source: 'store' }, 'reopen', 'merchant')).toBeUndefined();
    expect(reopenRefusal({ source: 'store' }, 'reopen', 'store')).toBeUndefined();
  });

  it('refuses no other move: a reject, a release and a settlement cannot meet a crossing', () => {
    for (const move of MOVES.filter((candidate) => candidate !== 'reopen')) {
      for (const source of ORDER_SOURCES) expect(reopenRefusal({ source }, move, 'store')).toBeUndefined();
    }
  });
});

describe('refundCreditsKind', () => {
  it('credits the merchant wallet to a merchant account and the store balance to any other', () => {
    expect(refundCreditsKind('merchant')).toBe('client_wallet');
    expect(refundCreditsKind('store')).toBe('customer_wallet');
  });
});
