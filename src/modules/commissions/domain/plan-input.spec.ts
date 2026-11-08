// Unit tests of the plan input rules (feature 11): the rate range of 0.5 to 15 percent and its format, and the scope of a kind.
import { describe, expect, it } from 'bun:test';
import { normalisePercent, planRateProblem, scopeOf } from './plan-input';

describe('planRateProblem', () => {
  it('accepts the limits and the values between them, with up to 4 decimals', () => {
    for (const rate of ['0.5', '0.5000', '3', '3.5', '14.9999', '15', '15.0000']) {
      expect(planRateProblem(rate)).toBeUndefined();
    }
  });

  it("refuses a rate outside 0.5 to 15 with the demo's sentence", () => {
    for (const rate of ['0', '0.49', '0.4999', '15.0001', '16', '100']) {
      expect(planRateProblem(rate)).toBe('Enter a rate between 0.5 and 15.');
    }
  });

  it('refuses text that is not a plain decimal number', () => {
    for (const rate of ['', 'abc', '3,5', '-3', '3.12345', '1e1', ' 3', '3%']) {
      expect(planRateProblem(rate)).toBe('Enter the rate as a number with at most 4 decimals, for example 3.5.');
    }
  });
});

describe('normalisePercent and scopeOf', () => {
  it('stores the rate with 4 decimals', () => {
    expect(normalisePercent('3.5')).toBe('3.5000');
    expect(normalisePercent('15')).toBe('15.0000');
  });

  it('gives a referral plan the referrals scope and a rebate plan the own scope', () => {
    expect(scopeOf('referral')).toBe('referrals');
    expect(scopeOf('rebate')).toBe('own');
  });
});
