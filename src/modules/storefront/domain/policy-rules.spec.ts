// Unit tests of the storefront policy rules (feature 16): the eight keys, and the value each must carry (ANSWERS settings Q1, the mock's ranges).
import { describe, expect, it } from 'bun:test';
import {
  BOOLEAN_POLICIES,
  NUMBER_POLICIES,
  POLICY_KEYS,
  POLICY_LABELS,
  isPolicyKey,
  policyProblem,
} from './policy-rules';

describe('the policy keys', () => {
  it('are the five switches and the three numbers, each with a label for the audit log', () => {
    expect(POLICY_KEYS).toEqual([
      'guestCheckout',
      'require3ds',
      'withdrawalWaiver',
      'autoRefundFailed',
      'imeiPrecheck',
      'refundHoursBeforeDispatch',
      'abandonedMinutes',
      'imeiRetentionDays',
    ]);
    expect(BOOLEAN_POLICIES).toHaveLength(5);
    expect(NUMBER_POLICIES).toHaveLength(3);
    for (const key of POLICY_KEYS) expect(POLICY_LABELS[key]).toBeTruthy();
  });

  it('isPolicyKey tells the eight from everything else', () => {
    expect(isPolicyKey('guestCheckout')).toBe(true);
    expect(isPolicyKey('imeiRetentionDays')).toBe(true);
    expect(isPolicyKey('maintenance')).toBe(false);
    expect(isPolicyKey('constructor')).toBe(false);
    expect(isPolicyKey('')).toBe(false);
  });
});

describe('policyProblem', () => {
  it('accepts a boolean for each switch and nothing else', () => {
    for (const key of BOOLEAN_POLICIES) {
      expect(policyProblem(key, true)).toBeUndefined();
      expect(policyProblem(key, false)).toBeUndefined();
      for (const value of ['true', 0, 1, null, undefined, {}, []])
        expect(policyProblem(key, value)).toBe('Use true or false.');
    }
  });

  it('accepts a whole number inside the range of each number, edges included', () => {
    expect(policyProblem('refundHoursBeforeDispatch', 0)).toBeUndefined();
    expect(policyProblem('refundHoursBeforeDispatch', 72)).toBeUndefined();
    expect(policyProblem('refundHoursBeforeDispatch', 73)).toBe('Use a number from 0 to 72.');
    expect(policyProblem('refundHoursBeforeDispatch', -1)).toBe('Use a number from 0 to 72.');
    expect(policyProblem('abandonedMinutes', 5)).toBeUndefined();
    expect(policyProblem('abandonedMinutes', 1440)).toBeUndefined();
    expect(policyProblem('abandonedMinutes', 4)).toBe('Use a number from 5 to 1440.');
    expect(policyProblem('abandonedMinutes', 1441)).toBe('Use a number from 5 to 1440.');
    expect(policyProblem('imeiRetentionDays', 0)).toBeUndefined();
    expect(policyProblem('imeiRetentionDays', 3650)).toBeUndefined();
    expect(policyProblem('imeiRetentionDays', 3651)).toBeDefined();
  });

  it('refuses a number that is not a whole JSON number', () => {
    for (const value of [1.5, '24', null, true, Number.NaN, Infinity, []]) {
      expect(policyProblem('refundHoursBeforeDispatch', value)).toBe('Use a whole number.');
    }
    expect(policyProblem('imeiRetentionDays', 1.5)).toBeDefined();
    expect(policyProblem('imeiRetentionDays', '30')).toBeDefined();
  });

  it('refuses a key that is not a storefront setting', () => {
    expect(policyProblem('maintenance', true)).toBe('This is not a storefront setting.');
    expect(policyProblem('payments.auto_credit_delay_minutes', 5)).toBe('This is not a storefront setting.');
  });
});
