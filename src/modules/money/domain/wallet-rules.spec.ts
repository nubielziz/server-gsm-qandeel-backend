// Unit tests of the wallet rules: the credit limit (user rule 2) and the adjustment approval limit (ANSWERS merchants Q4).
import { describe, expect, it } from 'bun:test';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { approvalLimitOf, checkCreditLimit, needsSecondApprover } from './wallet-rules';

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

  it('asks for a second approver only strictly above the limit', () => {
    const limit = Money.of('10000');
    expect(needsSecondApprover(Money.of('10000'), limit)).toBe(false);
    expect(needsSecondApprover(Money.of('10000.0001'), limit)).toBe(true);
  });
});
