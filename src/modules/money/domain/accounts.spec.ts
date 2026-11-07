// Unit tests of the account rules (decision 024): normal sides, the sign of stored balances and the wallet figures.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { LEDGER_ACCOUNT_KINDS } from '../db/schema';
import {
  CREDIT_NORMAL_KINDS,
  DEBIT_NORMAL_KINDS,
  balanceDelta,
  emptyWalletView,
  normalSideOf,
  toDebitPositive,
  walletViewOf,
} from './accounts';

const m = (amount: string) => Money.of(amount);

describe('normal sides', () => {
  it('cover all 15 account kinds exactly once', () => {
    const all = [...DEBIT_NORMAL_KINDS, ...CREDIT_NORMAL_KINDS].sort();
    expect(all).toEqual([...LEDGER_ACCOUNT_KINDS].sort());
  });

  it("follow the map's kinds: assets and expenses are debit-normal, liabilities, income and equity credit-normal", () => {
    for (const kind of [
      'bank',
      'gateway_clearing',
      'supplier_prepaid',
      'cogs',
      'gateway_fees',
      'adjustments',
    ] as const) {
      expect(normalSideOf(kind)).toBe('debit');
    }
    for (const kind of [
      'client_wallet',
      'client_hold',
      'customer_funds',
      'vat_payable',
      'revenue',
      'fee_income',
      'owner_capital',
    ] as const) {
      expect(normalSideOf(kind)).toBe('credit');
    }
  });
});

describe('balances', () => {
  it('grow with debits on a debit-normal account and with credits on a credit-normal one', () => {
    // A debit is positive, a credit negative (the entry amount).
    expect(balanceDelta('bank', m('100')).toWire()).toBe('100.0000');
    expect(balanceDelta('client_wallet', m('-100')).toWire()).toBe('100.0000');
    expect(balanceDelta('client_wallet', m('5')).toWire()).toBe('-5.0000');
  });

  it('read debit-positive on the wire: a credit-normal account with money reads negative', () => {
    expect(toDebitPositive('client_wallet', m('250')).toWire()).toBe('-250.0000');
    expect(toDebitPositive('bank', m('250')).toWire()).toBe('250.0000');
    expect(toDebitPositive('client_wallet', Money.zero()).toWire()).toBe('0.0000');
  });
});

describe('wallet view', () => {
  it('adds the credit limit to the balance for the available figure (decision 024)', () => {
    expect(walletViewOf({ balance: m('120.5'), reserved: m('20'), creditLimit: m('500') })).toEqual({
      balance: '120.5000',
      reserved: '20.0000',
      creditLimit: '500.0000',
      available: '620.5000',
    });
  });

  it('shows credit in use as a negative balance and a smaller available figure', () => {
    expect(walletViewOf({ balance: m('-200'), reserved: m('0'), creditLimit: m('500') }).available).toBe('300.0000');
  });

  it('is all zero for a merchant without accounts', () => {
    expect(emptyWalletView()).toEqual({
      balance: '0.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '0.0000',
    });
  });
});
