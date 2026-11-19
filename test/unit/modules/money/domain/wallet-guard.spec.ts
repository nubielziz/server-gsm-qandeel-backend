// Unit tests of the wallet debit guard (decision 024 step 4, plan 21 § 5.5): credits pass, a customer wallet never ends below zero unless
// the clawback says so, the merchant rule is unchanged.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { walletDebitRefusal } from '@src/modules/money/domain/wallet-guard';

const m = (amount: string) => Money.of(amount);
const customer = { kind: 'customer_wallet' as const, overdraftLimit: '0.0000' };
const merchant = { kind: 'client_wallet' as const, overdraftLimit: '100.0000' };

describe('walletDebitRefusal on a customer wallet', () => {
  it('lets a credit pass, even on a negative balance', () => {
    expect(walletDebitRefusal(customer, m('-10'), m('-5'))).toBeUndefined();
    expect(walletDebitRefusal(customer, m('0'), m('5'))).toBeUndefined();
  });

  it('lets a debit down to zero pass and refuses one below zero', () => {
    expect(walletDebitRefusal(customer, m('10'), m('0'))).toBeUndefined();
    expect(walletDebitRefusal(customer, m('10'), m('-0.0001'))).toBe(
      'The balance would end at -0.0001; a store balance cannot go below zero.',
    );
  });

  it('lets the clawback override take it below zero, but not the merchant override', () => {
    expect(walletDebitRefusal(customer, m('10'), m('-40'), { allowNegativeCustomerWallet: true })).toBeUndefined();
    expect(walletDebitRefusal(customer, m('10'), m('-40'), { allowBelowCreditLimit: true })).toBeString();
  });
});

describe('walletDebitRefusal on a merchant wallet (unchanged)', () => {
  it('allows a debit down to the credit limit and refuses one below it', () => {
    expect(walletDebitRefusal(merchant, m('0'), m('-100'))).toBeUndefined();
    expect(walletDebitRefusal(merchant, m('0'), m('-100.0001'))).toBe(
      'The wallet would end at -100.0001, below its credit limit of 100.0000.',
    );
  });

  it('lets allowBelowCreditLimit pass, but not the customer override', () => {
    expect(walletDebitRefusal(merchant, m('0'), m('-500'), { allowBelowCreditLimit: true })).toBeUndefined();
    expect(walletDebitRefusal(merchant, m('0'), m('-500'), { allowNegativeCustomerWallet: true })).toBeString();
  });
});

describe('walletDebitRefusal on other accounts', () => {
  it('never refuses a system account', () => {
    expect(walletDebitRefusal({ kind: 'customer_funds', overdraftLimit: '0' }, m('0'), m('-50'))).toBeUndefined();
  });
});
