// Unit tests of the customer wallet policy (feature 21, plan § 5.8 and § 11.1): defaults, bad values, min above max, every top-up refusal,
// liveness, the store status, the masked memo, available and room.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  CUSTOMER_WALLET_DEFAULTS,
  MAX_OPEN_TOPUPS,
  type TopUpCheckInput,
  availableOf,
  checkTopUp,
  customerMemo,
  customerWalletPolicy,
  isLiveTopUp,
  roomOf,
  topUpStatusOf,
} from '@src/modules/money/domain/customer-wallet-policy';

const m = (amount: string) => Money.of(amount);

describe('customerWalletPolicy', () => {
  it('uses the owner defaults when nothing is saved', () => {
    const policy = customerWalletPolicy({});
    expect(policy.enabled).toBe(false);
    expect(policy.cardTopUps).toBe(false);
    expect(policy.minTopUp.toWire()).toBe('5.0000');
    expect(policy.maxTopUp.toWire()).toBe('500.0000');
    expect(policy.maxBalance.toWire()).toBe('1000.0000');
    expect(policy.topUpsPerDay).toBe(5);
    expect(policy.topUpAmountPerDay.toWire()).toBe('1000.0000');
    expect(policy.adjustApprovalLimit.toWire()).toBe('500.0000');
    expect(CUSTOMER_WALLET_DEFAULTS.enabled).toBe(false);
  });

  it('reads saved values', () => {
    const policy = customerWalletPolicy({
      'wallet.customer.enabled': true,
      'wallet.customer.card_topups': true,
      'wallet.customer.min_topup': 10,
      'wallet.customer.max_topup': 200,
      'wallet.customer.max_balance': 300,
      'wallet.customer.topups_per_day': 2,
      'wallet.customer.topup_amount_per_day': 400,
      'wallet.customer.adjust_approval_limit': 0,
    });
    expect(policy).toMatchObject({ enabled: true, cardTopUps: true, topUpsPerDay: 2 });
    expect(policy.minTopUp.toWire()).toBe('10.0000');
    expect(policy.maxTopUp.toWire()).toBe('200.0000');
    expect(policy.maxBalance.toWire()).toBe('300.0000');
    expect(policy.topUpAmountPerDay.toWire()).toBe('400.0000');
    expect(policy.adjustApprovalLimit.toWire()).toBe('0.0000');
  });

  it('falls back per key on a wrong type or range, and to both defaults when the minimum is above the maximum', () => {
    const policy = customerWalletPolicy({
      'wallet.customer.enabled': 'true',
      'wallet.customer.max_balance': -1,
      'wallet.customer.topups_per_day': 2.5,
      'wallet.customer.adjust_approval_limit': 20_000,
    });
    expect(policy.enabled).toBe(false);
    expect(policy.maxBalance.toWire()).toBe('1000.0000');
    expect(policy.topUpsPerDay).toBe(5);
    expect(policy.adjustApprovalLimit.toWire()).toBe('500.0000');
    const swapped = customerWalletPolicy({ 'wallet.customer.min_topup': 100, 'wallet.customer.max_topup': 50 });
    expect(swapped.minTopUp.toWire()).toBe('5.0000');
    expect(swapped.maxTopUp.toWire()).toBe('500.0000');
  });
});

describe('checkTopUp', () => {
  const policy = customerWalletPolicy({});
  const base: TopUpCheckInput = {
    amount: m('50'),
    fee: m('0'),
    gatewayMin: '0',
    gatewayMax: '0',
    balance: m('0'),
    liveOpenCount: 0,
    pendingNet: m('0'),
    dayCount: 0,
    dayAmount: m('0'),
  };
  const codeOf = (input: Partial<TopUpCheckInput>) => {
    const refusal = checkTopUp({ ...base, ...input }, policy);
    if (refusal === undefined) return undefined;
    return 'field' in refusal ? refusal.field.code : 'conflict';
  };

  it('accepts a top-up within every limit', () => {
    expect(codeOf({})).toBeUndefined();
    expect(codeOf({ amount: m('5') })).toBeUndefined();
    expect(codeOf({ amount: m('500') })).toBeUndefined();
  });

  it('refuses below the higher minimum and above the lower non-zero maximum', () => {
    expect(codeOf({ amount: m('4.99') })).toBe('min');
    expect(codeOf({ amount: m('9'), gatewayMin: '10' })).toBe('min');
    expect(codeOf({ amount: m('500.01') })).toBe('max');
    expect(codeOf({ amount: m('101'), gatewayMax: '100' })).toBe('max');
    expect(codeOf({ amount: m('400'), gatewayMax: '0' })).toBeUndefined();
  });

  it('refuses a fee that eats the amount', () => {
    expect(codeOf({ amount: m('10'), fee: m('10') })).toBe('fee');
  });

  it(`refuses a fourth unpaid top-up with a conflict (at most ${MAX_OPEN_TOPUPS})`, () => {
    expect(codeOf({ liveOpenCount: 2 })).toBeUndefined();
    expect(codeOf({ liveOpenCount: 3 })).toBe('conflict');
  });

  it('refuses beyond the daily count and amount, this one included', () => {
    expect(codeOf({ dayCount: 4 })).toBeUndefined();
    expect(codeOf({ dayCount: 5 })).toBe('daily_count');
    expect(codeOf({ dayAmount: m('950') })).toBeUndefined();
    expect(codeOf({ dayAmount: m('950.01') })).toBe('daily_amount');
  });

  it('refuses when the balance with pending and this net would pass the maximum balance', () => {
    expect(codeOf({ balance: m('900'), pendingNet: m('50') })).toBeUndefined();
    expect(codeOf({ balance: m('900'), pendingNet: m('50.01') })).toBe('max_balance');
    expect(codeOf({ balance: m('960'), amount: m('50'), fee: m('10') })).toBeUndefined();
  });
});

describe('isLiveTopUp', () => {
  const now = new Date('2026-11-10T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it('keeps manual top-ups and top-ups with a pending payment live forever', () => {
    expect(isLiveTopUp({ manual: true, createdAt: hoursAgo(100), hasPendingPayment: false }, now)).toBe(true);
    expect(isLiveTopUp({ manual: false, createdAt: hoursAgo(100), hasPendingPayment: true }, now)).toBe(true);
  });

  it('lets an unpaid automatic top-up lapse after 24 hours', () => {
    expect(isLiveTopUp({ manual: false, createdAt: hoursAgo(23.5), hasPendingPayment: false }, now)).toBe(true);
    expect(isLiveTopUp({ manual: false, createdAt: hoursAgo(24), hasPendingPayment: false }, now)).toBe(false);
  });
});

describe('topUpStatusOf', () => {
  it('derives the five store states', () => {
    expect(topUpStatusOf('paid', 'approved')).toBe('credited');
    expect(topUpStatusOf('void', 'rejected')).toBe('rejected');
    expect(topUpStatusOf('void', null)).toBe('cancelled');
    expect(topUpStatusOf('open', 'pending')).toBe('in_review');
    expect(topUpStatusOf('open', null)).toBe('awaiting_payment');
  });
});

describe('customerMemo', () => {
  it('hides a staff reason and keeps system memos', () => {
    expect(customerMemo('adjustment', 'Manual credit: goodwill for a slow unlock')).toBe('Balance adjustment');
    expect(customerMemo('deposit', 'Top-up PAY-12 (Bank transfer)')).toBe('Top-up PAY-12 (Bank transfer)');
  });
});

describe('availableOf and roomOf', () => {
  it('answers zero while frozen, switched off or negative, else the balance', () => {
    expect(availableOf({ balance: m('20'), frozen: false, enabled: true }).toWire()).toBe('20.0000');
    expect(availableOf({ balance: m('20'), frozen: true, enabled: true }).toWire()).toBe('0.0000');
    expect(availableOf({ balance: m('20'), frozen: false, enabled: false }).toWire()).toBe('0.0000');
    expect(availableOf({ balance: m('-5'), frozen: false, enabled: true }).toWire()).toBe('0.0000');
  });

  it('never answers a negative room', () => {
    expect(roomOf(m('1000'), m('200'), m('50')).toWire()).toBe('750.0000');
    expect(roomOf(m('1000'), m('990'), m('50')).toWire()).toBe('0.0000');
    expect(roomOf(m('1000'), m('-30'), m('0')).toWire()).toBe('1030.0000');
  });
});
