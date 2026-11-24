// Unit tests of the storefront policy rules (feature 16): the five keys, and the value each must carry (ANSWERS settings Q1, the mock's ranges).
import { describe, expect, it } from 'bun:test';
import {
  BOOLEAN_POLICIES,
  NUMBER_POLICIES,
  POLICY_KEYS,
  POLICY_LABELS,
  isPolicyKey,
  policyProblem,
} from '@src/modules/storefront/domain/policy-rules';

describe('the policy keys', () => {
  it('are the four switches and the one number, each with a label for the audit log', () => {
    expect(POLICY_KEYS).toEqual([
      'guestCheckout',
      'require3ds',
      'withdrawalWaiver',
      'autoRefundFailed',
      'refundHoursBeforeDispatch',
    ]);
    expect(BOOLEAN_POLICIES).toHaveLength(4);
    expect(NUMBER_POLICIES).toHaveLength(1);
    for (const key of POLICY_KEYS) expect(POLICY_LABELS[key]).toBeTruthy();
  });

  it('isPolicyKey tells the five from everything else, the retired reminder delay and the two policies of the retired IMEI check included', () => {
    expect(isPolicyKey('guestCheckout')).toBe(true);
    expect(isPolicyKey('abandonedMinutes')).toBe(false);
    expect(isPolicyKey('imeiRetentionDays')).toBe(false);
    expect(isPolicyKey('imeiPrecheck')).toBe(false);
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
  });

  it('refuses a number that is not a whole JSON number', () => {
    for (const value of [1.5, '24', null, true, Number.NaN, Infinity, []]) {
      expect(policyProblem('refundHoursBeforeDispatch', value)).toBe('Use a whole number.');
    }
  });

  it('refuses a key that is not a storefront setting, the retired reminder delay included', () => {
    expect(policyProblem('maintenance', true)).toBe('This is not a storefront setting.');
    expect(policyProblem('abandonedMinutes', 60)).toBe('This is not a storefront setting.');
    expect(policyProblem('imeiRetentionDays', 30)).toBe('This is not a storefront setting.');
    expect(policyProblem('imeiPrecheck', true)).toBe('This is not a storefront setting.');
    expect(policyProblem('payments.auto_credit_delay_minutes', 5)).toBe('This is not a storefront setting.');
  });
});
