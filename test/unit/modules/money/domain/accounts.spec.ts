// Unit tests of the account rules (decision 024, decision 064): normal sides, the sign of stored balances, the owner of every wallet and
// the wallet figures of the live wallet.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { LEDGER_ACCOUNT_KINDS } from '@src/modules/money/db/schema';
import {
  ACCOUNT_OWNER_TYPE,
  CREDIT_NORMAL_KINDS,
  DEBIT_NORMAL_KINDS,
  balanceDelta,
  emptyWalletView,
  holdAccountOf,
  liveWalletFigures,
  normalSideOf,
  storeWalletAccountOf,
  toDebitPositive,
  walletAccountOf,
  walletViewOf,
} from '@src/modules/money/domain/accounts';

const m = (amount: string) => Money.of(amount);

describe('normal sides', () => {
  it('cover all 16 account kinds exactly once', () => {
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
      'customer_wallet',
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

describe('the owner of a wallet', () => {
  it('is an account for every wallet and hold, whatever the rank (decision 064)', () => {
    expect(ACCOUNT_OWNER_TYPE).toBe('account');
    expect(walletAccountOf(7)).toEqual({ kind: 'client_wallet', ownerType: 'account', ownerId: 7 });
    expect(holdAccountOf(7)).toEqual({ kind: 'client_hold', ownerType: 'account', ownerId: 7 });
    expect(storeWalletAccountOf(7)).toEqual({ kind: 'customer_wallet', ownerType: 'account', ownerId: 7 });
  });

  it('uses an owner type the stored list allows, and never the old words', () => {
    const owners = [walletAccountOf(1), holdAccountOf(1), storeWalletAccountOf(1)].map((ref) => ref.ownerType);
    for (const owner of owners) {
      expect(owner).toBe('account');
      expect(['client', 'customer']).not.toContain(owner);
    }
  });
});

describe('liveWalletFigures', () => {
  const merchant = { kind: 'merchant', hold: Money.zero(), frozen: false, enabled: true } as const;
  const store = { kind: 'store', hold: Money.zero(), creditLimit: Money.zero(), enabled: true } as const;

  it('gives a merchant wallet the four figures of walletViewOf: the hold is reserved, credit adds to what is available', () => {
    expect(liveWalletFigures({ ...merchant, balance: m('120.5'), hold: m('20'), creditLimit: m('500') })).toEqual({
      balance: '120.5000',
      reserved: '20.0000',
      creditLimit: '500.0000',
      available: '620.5000',
    });
  });

  it('keeps a frozen merchant wallet spendable in the figure: the freeze refuses new holds, it does not hide money', () => {
    const figures = liveWalletFigures({ ...merchant, balance: m('40'), creditLimit: m('10'), frozen: true });
    expect(figures.available).toBe('50.0000');
  });

  it('gives a store balance no hold and no credit; the balance is what can be spent', () => {
    expect(liveWalletFigures({ ...store, balance: m('48.5'), frozen: false })).toEqual({
      balance: '48.5000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '48.5000',
    });
  });

  it('gives a store balance nothing to spend while it is on hold, switched off or not above zero', () => {
    expect(liveWalletFigures({ ...store, balance: m('48.5'), frozen: true }).available).toBe('0.0000');
    expect(liveWalletFigures({ ...store, balance: m('48.5'), frozen: false, enabled: false }).available).toBe('0.0000');
    expect(liveWalletFigures({ ...store, balance: Money.zero(), frozen: false }).available).toBe('0.0000');
    const clawedBack = liveWalletFigures({ ...store, balance: m('-12'), frozen: true });
    expect(clawedBack).toMatchObject({ balance: '-12.0000', available: '0.0000' });
  });

  it('ignores a hold and a credit limit that a store account should never have', () => {
    const figures = liveWalletFigures({ ...store, balance: m('5'), hold: m('3'), creditLimit: m('9'), frozen: false });
    expect(figures).toMatchObject({ reserved: '0.0000', creditLimit: '0.0000', available: '5.0000' });
  });
});
