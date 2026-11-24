// Unit tests of the wallet rules: the credit limit (user rule 2), the adjustment approval limit (ANSWERS merchants Q4, decision 049: a
// staff member's credits over 24 hours, a debit alone, an Owner exempt, a credit limit above it for Owners) and the pure parts of the staff
// wallet actions of one account (decision 064: the keys, the pools by wallet kind, the replay check, the refusals, the statement window).
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import { Money } from '@src/common/money';
import type { ParsedFilter } from '@src/common/contract';
import {
  accountLabelOf,
  adjustmentKeyOf,
  adjustmentNeedsOwner,
  adjustmentRefusalDetail,
  approvalLimitOf,
  checkCreditLimit,
  creditLimitNeedsOwner,
  creditLimitOwnerDetail,
  creditLimitRaise,
  creditSumRefusalDetail,
  dollarsText,
  emptyAccountWallet,
  isSameAdjustment,
  legacyAdjustmentKeysOf,
  poolOfRank,
  receiptApprovalRefusalDetail,
  statementLedgerKindOf,
  statementWindowOf,
  storeCreditLimitRefusal,
  storeCreditRefusal,
  unfreezeRefusal,
  walletActionRequestOf,
} from '@src/modules/money/domain/wallet-rules';

const fieldErrors = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, errors: error.errors };
    throw error;
  }
  return undefined;
};

describe('checkCreditLimit (user rule 2)', () => {
  it('accepts zero for any group and a positive limit for a group that allows credit', () => {
    expect(checkCreditLimit('0.0000', false).toWire()).toBe('0.0000');
    expect(checkCreditLimit('2500.0000', true).toWire()).toBe('2500.0000');
  });

  it('refuses a positive limit on a group without overdraft with one message, on `creditLimit`', () => {
    expect(fieldErrors(() => checkCreditLimit('0.0001', false))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'creditLimit', code: 'not_allowed', message: 'This group does not allow credit.' }],
    });
  });

  it('refuses a negative limit even where credit is allowed', () => {
    expect(fieldErrors(() => checkCreditLimit('-1.0000', true))?.errors[0]).toMatchObject({
      field: 'creditLimit',
      code: 'min',
    });
  });
});

describe('the approval limit', () => {
  it('defaults to the demo $10,000 and takes a valid setting', () => {
    expect(approvalLimitOf(undefined).toWire()).toBe('10000.0000');
    expect(approvalLimitOf('2500.5000').toWire()).toBe('2500.5000');
    expect(approvalLimitOf(5000).toWire()).toBe('5000.0000');
    expect(approvalLimitOf(250.5).toWire()).toBe('250.5000');
  });

  it('falls back to the default for a malformed or negative setting, never lifting the limit', () => {
    for (const bad of ['abc', '-5', -5, 0.00001, 1e21, Number.NaN, Number.POSITIVE_INFINITY, null, {}, [], true])
      expect(approvalLimitOf(bad).toWire()).toBe('10000.0000');
  });
});

describe('adjustmentNeedsOwner (decision 049)', () => {
  const limit = Money.of('10000');
  const judge = (direction: 'credit' | 'debit', amount: string, credited: string, owner = false) =>
    adjustmentNeedsOwner({
      direction,
      amount: Money.of(amount),
      creditedInWindow: Money.of(credited),
      limit,
      owner,
    });

  it("sums a staff member's credits and judges a debit alone", () => {
    expect(judge('credit', '4000', '6000')).toBe(false);
    expect(judge('credit', '0.0001', '10000')).toBe(true);
    expect(judge('credit', '10000', '0')).toBe(false);
    expect(judge('credit', '10000.0001', '0')).toBe(true);
    expect(judge('debit', '10000.0001', '9000')).toBe(true);
    expect(judge('debit', '9000', '9000')).toBe(false);
    expect(judge('debit', '10000', '50000')).toBe(false);
  });

  it('never refuses an Owner', () => {
    expect(judge('credit', '50000', '0', true)).toBe(false);
    expect(judge('credit', '1', '90000', true)).toBe(false);
    expect(judge('debit', '50000', '0', true)).toBe(false);
  });
});

describe('adjustmentRefusalDetail (decision 049)', () => {
  it('names the limit and the total, never a split', () => {
    const credit = adjustmentRefusalDetail({
      direction: 'credit',
      amount: Money.of('6000'),
      creditedInWindow: Money.of('5000'),
      limit: Money.of('10000'),
    });
    const debit = adjustmentRefusalDetail({
      direction: 'debit',
      amount: Money.of('10000.0001'),
      creditedInWindow: Money.zero(),
      limit: Money.of('10000'),
    });
    expect(credit).toBe('Credits over $10,000 in 24 hours need an owner: yours would come to $11,000.');
    expect(debit).toBe('Debits over $10,000 need an owner.');
    expect(`${credit} ${debit}`.toLowerCase()).not.toContain('split');
  });

  it('writes cents only when there are some, and every place that is not zero', () => {
    expect(dollarsText(Money.of('10000.0001'))).toBe('$10,000.0001');
    expect(dollarsText(Money.of('10000.0010'))).toBe('$10,000.001');
    expect(dollarsText(Money.of('500.5000'))).toBe('$500.50');
    expect(dollarsText(Money.of('500.1200'))).toBe('$500.12');
    expect(dollarsText(Money.of('1234567'))).toBe('$1,234,567');
  });
});

describe('creditLimitNeedsOwner (decision 049)', () => {
  const limit = Money.of('10000');
  it('refuses only a raise above the approval limit', () => {
    expect(creditLimitNeedsOwner(Money.of('10000.0001'), Money.zero(), limit)).toBe(true);
    expect(creditLimitNeedsOwner(Money.of('10000'), Money.zero(), limit)).toBe(false);
    expect(creditLimitNeedsOwner(Money.of('15000'), Money.of('20000'), limit)).toBe(false);
    expect(creditLimitNeedsOwner(Money.of('20000'), Money.of('20000'), limit)).toBe(false);
    expect(creditLimitNeedsOwner(Money.of('16000'), Money.of('15000'), limit)).toBe(true);
  });

  it('says who may set it', () => {
    expect(creditLimitOwnerDetail(limit)).toBe('Only an owner can set a credit limit above $10,000.');
  });
});

describe('creditLimitRaise (decision 049)', () => {
  it('is the part above the limit it replaces, and zero for a lowering or an unchanged limit', () => {
    expect(creditLimitRaise(Money.of('10000'), Money.zero()).toWire()).toBe('10000.0000');
    expect(creditLimitRaise(Money.of('3000'), Money.of('1000')).toWire()).toBe('2000.0000');
    expect(creditLimitRaise(Money.of('1000'), Money.of('3000')).toWire()).toBe('0.0000');
    expect(creditLimitRaise(Money.of('3000'), Money.of('3000')).toWire()).toBe('0.0000');
  });
});

describe('the refusals of the 24-hour sums (decision 049)', () => {
  it('name the limit and the total the sum would reach', () => {
    expect(creditSumRefusalDetail(Money.of('10000'), Money.of('10000.0001'))).toBe(
      'Credits and credit-limit raises over $10,000 in 24 hours need an owner: yours would come to $10,000.0001.',
    );
    expect(receiptApprovalRefusalDetail(Money.of('10000'), Money.of('12500'))).toBe(
      'Approved transfer top-ups over $10,000 in 24 hours need an owner: yours would come to $12,500.',
    );
  });
});

describe('the pools follow the wallet kind of the rank (decision 064)', () => {
  it('gives the merchant pool and the merchant wallet to a merchant rank, the store pool and the store balance to any other', () => {
    expect(poolOfRank('merchant')).toEqual({ pool: 'merchant', ledgerKind: 'client_wallet' });
    expect(poolOfRank('retail')).toEqual({ pool: 'store', ledgerKind: 'customer_wallet' });
  });
});

describe('the keys of a staff adjustment', () => {
  it('is adjust:<accountId>:<key> for both kinds', () => {
    expect(adjustmentKeyOf(7, 'dialog-1')).toBe('adjust:7:dialog-1');
    expect(adjustmentKeyOf(107, 'k')).toBe('adjust:107:k');
  });

  it('adds the pre-release store key for each old customer number, and nothing for an old merchant number or a new account', () => {
    expect(
      legacyAdjustmentKeysOf(
        [
          { type: 'client', id: 7 },
          { type: 'customer', id: 7 },
        ],
        'k',
      ),
    ).toEqual(['adjust:customer:7:k']);
    expect(legacyAdjustmentKeysOf([], 'k')).toEqual([]);
    expect(
      legacyAdjustmentKeysOf(
        [
          { type: 'customer', id: 3 },
          { type: 'customer', id: 3 },
          { type: 'customer', id: 9 },
        ],
        'k',
      ),
    ).toEqual(['adjust:customer:3:k', 'adjust:customer:9:k']);
  });
});

describe('isSameAdjustment: a key reused for another request is refused, whichever wallet the journal sits on', () => {
  const journal = (kind: string, amount: string, memo = 'Manual credit: Goodwill for a slow unlock') => ({
    memo,
    entries: [
      { amount: amount.startsWith('-') ? amount.slice(1) : `-${amount}`, account: { kind: 'adjustments' } },
      { amount, account: { kind } },
    ],
  });
  const memo = 'Manual credit: Goodwill for a slow unlock';

  it('accepts the same credit on a merchant wallet or a store balance (the wallet line is negative for a credit)', () => {
    expect(isSameAdjustment(journal('client_wallet', '-10.0000'), memo, 'credit', Money.of('10'))).toBe(true);
    expect(isSameAdjustment(journal('customer_wallet', '-10.0000'), memo, 'credit', Money.of('10'))).toBe(true);
  });

  it('accepts the same debit (the wallet line is positive)', () => {
    const debit = 'Manual debit: Fee while held';
    expect(isSameAdjustment(journal('customer_wallet', '5.0000', debit), debit, 'debit', Money.of('5'))).toBe(true);
  });

  it('refuses another amount, another direction, another reason and a journal without a wallet line', () => {
    expect(isSameAdjustment(journal('client_wallet', '-10.0000'), memo, 'credit', Money.of('11'))).toBe(false);
    expect(isSameAdjustment(journal('client_wallet', '-10.0000'), memo, 'debit', Money.of('10'))).toBe(false);
    expect(
      isSameAdjustment(journal('client_wallet', '-10.0000'), 'Manual credit: Another', 'credit', Money.of('10')),
    ).toBe(false);
    expect(isSameAdjustment(journal('supplier_prepaid', '-10.0000'), memo, 'credit', Money.of('10'))).toBe(false);
  });
});

describe('storeCreditRefusal', () => {
  it('refuses a credit to an anonymized account and to a guest, never a debit', () => {
    expect(storeCreditRefusal({ status: 'anonymized', hasAccount: false }, 'credit')).toBe('ANONYMIZED');
    expect(storeCreditRefusal({ status: 'active', hasAccount: false }, 'credit')).toBe('NO_ACCOUNT');
    expect(storeCreditRefusal({ status: 'active', hasAccount: true }, 'credit')).toBeUndefined();
    expect(storeCreditRefusal({ status: 'suspended', hasAccount: true }, 'credit')).toBeUndefined();
    expect(storeCreditRefusal({ status: 'anonymized', hasAccount: false }, 'debit')).toBeUndefined();
    expect(storeCreditRefusal({ status: 'active', hasAccount: false }, 'debit')).toBeUndefined();
  });
});

describe('walletActionRequestOf', () => {
  it('is the same for two spellings of one body and differs for another action or another body', () => {
    const a = walletActionRequestOf('freeze', { reason: 'Checking a payment', extra: undefined });
    const b = walletActionRequestOf('freeze', { reason: 'Checking a payment' });
    expect(a).toBe(b);
    expect(walletActionRequestOf('unfreeze', { reason: 'Checking a payment' })).not.toBe(a);
    expect(walletActionRequestOf('freeze', { reason: 'Another reason' })).not.toBe(a);
    expect(walletActionRequestOf('credit_limit', { creditLimit: '2000.0000' })).not.toBe(
      walletActionRequestOf('credit_limit', { creditLimit: '2000.0001' }),
    );
  });

  it('orders the keys of a body, so the order a client sends them in does not matter', () => {
    expect(walletActionRequestOf('credit_limit', { a: '1', b: '2' })).toBe(
      walletActionRequestOf('credit_limit', { b: '2', a: '1' }),
    );
  });
});

describe('storeCreditLimitRefusal', () => {
  it('is a 422 on creditLimit with the code not_allowed', () => {
    const refusal = fieldErrors(() => {
      throw storeCreditLimitRefusal();
    });
    expect(refusal).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'creditLimit', code: 'not_allowed', message: 'A store balance has no credit limit.' }],
    });
  });
});

describe('unfreezeRefusal', () => {
  it('holds a store balance below zero and any wallet with an open top-up dispute', () => {
    expect(unfreezeRefusal({ kind: 'store', balance: Money.of('-0.0001'), openDisputes: 0 })).toBe('negative_balance');
    expect(unfreezeRefusal({ kind: 'store', balance: Money.of('-5'), openDisputes: 2 })).toBe('negative_balance');
    expect(unfreezeRefusal({ kind: 'store', balance: Money.of('5'), openDisputes: 1 })).toBe('open_dispute');
    expect(unfreezeRefusal({ kind: 'merchant', balance: Money.of('5'), openDisputes: 1 })).toBe('open_dispute');
  });

  it('lets a merchant wallet below zero go: credit in use is not a debt that holds the wallet', () => {
    expect(unfreezeRefusal({ kind: 'merchant', balance: Money.of('-300'), openDisputes: 0 })).toBeUndefined();
    expect(unfreezeRefusal({ kind: 'store', balance: Money.zero(), openDisputes: 0 })).toBeUndefined();
  });
});

describe('accountLabelOf', () => {
  it('names an account by its name, else its email, and an anonymized one by number', () => {
    expect(accountLabelOf({ id: 4, name: ' Daniel Rivera ', email: 'd@example.com', status: 'active' })).toBe(
      'Daniel Rivera',
    );
    expect(accountLabelOf({ id: 4, name: '  ', email: 'd@example.com', status: 'active' })).toBe('d@example.com');
    expect(accountLabelOf({ id: 4, name: 'Deleted account', email: 'x@redacted.invalid', status: 'anonymized' })).toBe(
      'account 4',
    );
  });
});

describe('the statement of a wallet', () => {
  it('reads the live wallet unless the request names the history of one kind', () => {
    expect(statementLedgerKindOf(undefined, 'client_wallet')).toBe('client_wallet');
    expect(statementLedgerKindOf('live', 'customer_wallet')).toBe('customer_wallet');
    expect(statementLedgerKindOf('merchant', 'customer_wallet')).toBe('client_wallet');
    expect(statementLedgerKindOf('store', 'client_wallet')).toBe('customer_wallet');
  });

  it('reads the createdAt window from the parsed filters, each end only when it was sent', () => {
    const from = new Date('2026-11-10T09:05:00.000Z');
    const to = new Date('2026-11-10T10:00:00.000Z');
    const filters: ParsedFilter[] = [
      { field: 'createdAt', op: 'gte', values: [from] },
      { field: 'createdAt', op: 'lte', values: [to] },
      { field: 'kind', op: 'eq', values: ['deposit'] },
    ];
    expect(statementWindowOf(filters)).toEqual({ from, to });
    expect(statementWindowOf(filters.slice(0, 1))).toEqual({ from });
    expect(statementWindowOf([])).toEqual({});
  });
});

describe('emptyAccountWallet', () => {
  it('answers every key of the wallet with zero figures and the facts of its kind', () => {
    expect(
      emptyAccountWallet({ kind: 'store', creditAllowed: false, enabled: false, adjustApprovalLimit: Money.of('500') }),
    ).toEqual({
      kind: 'store',
      currency: 'USD',
      balance: '0.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '0.0000',
      creditAllowed: false,
      frozen: null,
      enabled: false,
      pendingTopUps: { count: 0, amount: '0.0000' },
      openDisputes: 0,
      adjustApprovalLimit: '500.0000',
    });
    expect(
      emptyAccountWallet({
        kind: 'merchant',
        creditAllowed: true,
        enabled: true,
        adjustApprovalLimit: Money.of('10000'),
      }),
    ).toMatchObject({ kind: 'merchant', creditAllowed: true, enabled: true, adjustApprovalLimit: '10000.0000' });
  });
});
