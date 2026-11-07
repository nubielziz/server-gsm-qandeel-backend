// Unit tests of the pricing rule number and date checks.
import { describe, expect, it } from 'bun:test';
import { type RuleDraft, ruleNumberProblems } from './pricing-rule-input';

const draft = (overrides: Partial<RuleDraft> = {}): RuleDraft => ({
  scope: 'category',
  targetId: 4,
  groupId: null,
  kind: 'discount',
  percent: '2.0000',
  fixed: '0.0000',
  minProfit: '0.0000',
  priority: 100,
  startsAt: null,
  endsAt: null,
  ...overrides,
});

describe('ruleNumberProblems', () => {
  it('accepts a percent only, a fixed amount only, and both', () => {
    expect(ruleNumberProblems(draft())).toEqual([]);
    expect(ruleNumberProblems(draft({ percent: '0.0000', fixed: '1.5000' }))).toEqual([]);
    expect(ruleNumberProblems(draft({ percent: '5.0000', fixed: '0.5000', kind: 'margin' }))).toEqual([]);
  });

  it('asks for a percent or a fixed amount', () => {
    expect(ruleNumberProblems(draft({ percent: '0.0000', fixed: '0.0000' }))).toEqual([
      { field: 'percent', message: 'Enter a percent or a fixed amount.' },
    ]);
  });

  it('keeps a discount or promo within 100 % and a margin within 1000 %', () => {
    expect(ruleNumberProblems(draft({ percent: '100.0000' }))).toEqual([]);
    expect(ruleNumberProblems(draft({ percent: '100.0001', kind: 'promo' }))[0]?.field).toBe('percent');
    expect(ruleNumberProblems(draft({ percent: '1000.0000', kind: 'margin' }))).toEqual([]);
    expect(ruleNumberProblems(draft({ percent: '1000.0001', kind: 'margin' }))[0]?.field).toBe('percent');
  });

  it('wants the window to run forwards', () => {
    const start = new Date('2026-03-05T00:00:00.000Z');
    const end = new Date('2026-03-20T23:59:59.999Z');
    expect(ruleNumberProblems(draft({ startsAt: start, endsAt: end }))).toEqual([]);
    expect(ruleNumberProblems(draft({ startsAt: end, endsAt: start }))).toEqual([
      { field: 'endsAt', message: 'The end date is before the start date.' },
    ]);
    expect(ruleNumberProblems(draft({ startsAt: start, endsAt: start }))[0]?.field).toBe('endsAt');
    expect(ruleNumberProblems(draft({ startsAt: start }))).toEqual([]);
    expect(ruleNumberProblems(draft({ endsAt: end }))).toEqual([]);
  });
});
