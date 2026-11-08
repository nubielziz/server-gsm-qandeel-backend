// Unit tests of the risk rules (feature 18): the defaults, reading a damaged row, the merge and its refusals, and the change list.
import { describe, expect, it } from 'bun:test';
import {
  RISK_RULE_IDS,
  defaultRuleSet,
  isRiskRuleId,
  mergeRules,
  ruleChanges,
  ruleSetFromStored,
  storedRules,
} from './risk-rules';

describe('defaultRuleSet', () => {
  it('has the eight rules of the demo with its numbers', () => {
    const rules = defaultRuleSet();
    expect(RISK_RULE_IDS).toHaveLength(8);
    expect(rules.reviewThreshold).toEqual({ on: true, value: 50 });
    expect(rules.blockThreshold).toEqual({ on: true, value: 80 });
    expect(rules.maxOrdersPerEmail).toEqual({ on: true, value: 3 });
    expect(rules.reviewFirstOrderAbove).toEqual({ on: true, value: 40 });
    expect(rules.blockBlacklistedImei).toEqual({ on: true, value: null });
    expect(rules.blockDisposableEmail).toEqual({ on: false, value: null });
    expect(rules.require3ds).toEqual({ on: true, value: null });
  });
});

describe('ruleSetFromStored', () => {
  it('uses the stored switch and number, and the policy for require3ds', () => {
    const rules = ruleSetFromStored(
      { reviewThreshold: { on: false, value: 60 }, blockDisposableEmail: { on: true, value: null } },
      false,
    );
    expect(rules.reviewThreshold).toEqual({ on: false, value: 60 });
    expect(rules.blockDisposableEmail.on).toBe(true);
    expect(rules.require3ds.on).toBe(false);
    expect(rules.blockThreshold).toEqual({ on: true, value: 80 });
  });

  it('falls back to the default for anything damaged: a text, a negative or fractional number, a number on a switch', () => {
    const rules = ruleSetFromStored(
      {
        reviewThreshold: { on: 'yes', value: -5 },
        blockThreshold: { on: true, value: 7.5 },
        maxOrdersPerEmail: 'x',
        blockBlacklistedImei: { on: false, value: 9 },
      },
      'maybe',
    );
    expect(rules.reviewThreshold).toEqual({ on: true, value: 50 });
    expect(rules.blockThreshold).toEqual({ on: true, value: 80 });
    expect(rules.maxOrdersPerEmail).toEqual({ on: true, value: 3 });
    expect(rules.blockBlacklistedImei).toEqual({ on: false, value: null });
    expect(rules.require3ds.on).toBe(true);
    expect(ruleSetFromStored(null, undefined)).toEqual(defaultRuleSet());
    expect(ruleSetFromStored([], undefined)).toEqual(defaultRuleSet());
  });
});

describe('mergeRules', () => {
  const current = defaultRuleSet();

  it('applies the sent rules and keeps the ones left out', () => {
    const merged = mergeRules(current, [{ id: 'reviewThreshold', on: true, value: 40 }]);
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.next.reviewThreshold.value).toBe(40);
      expect(merged.next.blockThreshold.value).toBe(80);
    }
  });

  it('keeps the stored number of a numeric rule sent with null', () => {
    const merged = mergeRules(current, [{ id: 'maxOrdersPerEmail', on: false, value: null }]);
    expect(merged.ok && merged.next.maxOrdersPerEmail).toEqual({ on: false, value: 3 });
  });

  it('refuses an unknown id, a repeated id, a number on a switch and a bad number, each on its own id', () => {
    const merged = mergeRules(current, [
      { id: 'nope', on: true, value: null },
      { id: 'require3ds', on: true, value: 5 },
      { id: 'reviewThreshold', on: true, value: 1.5 },
      { id: 'blockThreshold', on: true, value: -1 },
      { id: 'blockThreshold', on: true, value: 70 },
    ]);
    expect(merged.ok).toBe(false);
    if (!merged.ok) {
      expect(merged.errors.map((error) => error.field)).toEqual([
        'nope',
        'require3ds',
        'reviewThreshold',
        'blockThreshold',
        'blockThreshold',
      ]);
    }
  });

  it('requires the review threshold below the block threshold, whether or not the switches are on', () => {
    const equal = mergeRules(current, [
      { id: 'reviewThreshold', on: false, value: 80 },
      { id: 'blockThreshold', on: false, value: 80 },
    ]);
    expect(equal).toEqual({
      ok: false,
      errors: [
        {
          field: 'reviewThreshold',
          code: 'review_not_below_block',
          message: 'The review threshold must be lower than the block threshold.',
        },
      ],
    });
    // Lowering only the block threshold under the stored review threshold is judged on the merged set too.
    expect(mergeRules(current, [{ id: 'blockThreshold', on: true, value: 40 }]).ok).toBe(false);
    expect(mergeRules(current, [{ id: 'blockThreshold', on: true, value: 51 }]).ok).toBe(true);
  });
});

describe('ruleChanges and storedRules', () => {
  it('names a switch change and a number change separately', () => {
    const before = defaultRuleSet();
    const merged = mergeRules(before, [
      { id: 'reviewThreshold', on: false, value: 45 },
      { id: 'blockDisposableEmail', on: true, value: null },
    ]);
    if (!merged.ok) throw new Error('unexpected');
    const changes = ruleChanges(before, merged.next);
    expect(changes.map((change) => [change.id, change.kind])).toEqual([
      ['reviewThreshold', 'turned_off'],
      ['reviewThreshold', 'value'],
      ['blockDisposableEmail', 'turned_on'],
    ]);
    expect(ruleChanges(before, before)).toEqual([]);
  });

  it('stores every rule except require3ds, which is the storefront policy', () => {
    const stored = storedRules(defaultRuleSet());
    expect(Object.keys(stored)).toHaveLength(7);
    expect('require3ds' in stored).toBe(false);
  });

  it('knows its ids', () => {
    expect(isRiskRuleId('blockThreshold')).toBe(true);
    expect(isRiskRuleId('nope')).toBe(false);
  });
});
