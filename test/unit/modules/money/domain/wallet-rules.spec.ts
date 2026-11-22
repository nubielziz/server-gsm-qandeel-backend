// Unit tests of the wallet rules: the credit limit (user rule 2) and the adjustment approval limit (ANSWERS merchants Q4,
// decision 049: a staff member's credits over 24 hours, a debit alone, an Owner exempt, a credit limit above it for Owners).
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import { Money } from '@src/common/money';
import {
  adjustmentNeedsOwner,
  adjustmentRefusalDetail,
  approvalLimitOf,
  checkCreditLimit,
  creditLimitNeedsOwner,
  creditLimitOwnerDetail,
  dollarsText,
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

  it('writes cents only when there are some', () => {
    expect(dollarsText(Money.of('10000.0001'))).toBe('$10,000.00');
    expect(dollarsText(Money.of('500.5000'))).toBe('$500.50');
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
