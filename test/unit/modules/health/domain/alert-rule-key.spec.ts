// Unit tests of the key the server makes for an alert rule (decision 077): from the name, in the format of a key, `rule` for a name with
// nothing usable in it. Characters that are not Latin are written with escapes only (decision 039).
import { describe, expect, it } from 'bun:test';
import {
  ALERT_KEY_MAX_LENGTH,
  ALERT_KEY_MIN_LENGTH,
  ALERT_KEY_PATTERN,
  madeAlertRuleKey,
} from '@src/modules/health/domain/alert-rule-key';

describe('madeAlertRuleKey', () => {
  it('is the name as an identifier', () => {
    expect(madeAlertRuleKey('Supplier timeouts')).toBe('supplier_timeouts');
    expect(madeAlertRuleKey('  API p95 > 800 ms!  ')).toBe('api_p95_800_ms');
    expect(madeAlertRuleKey('D\u00e9lai des commandes')).toBe('delai_des_commandes');
  });

  it('puts a name that starts with a digit or is too short behind rule_', () => {
    expect(madeAlertRuleKey('5xx rate')).toBe('rule_5xx_rate');
    expect(madeAlertRuleKey('A!!')).toBe('rule_a');
    expect(madeAlertRuleKey('CPU')).toBe('cpu');
  });

  it('is rule when the name has no letter or digit a-z in it', () => {
    expect(madeAlertRuleKey('\u062a\u0646\u0628\u064a\u0647 \u0627\u0644\u0645\u0648\u0631\u062f')).toBe('rule');
    expect(madeAlertRuleKey('!!!')).toBe('rule');
  });

  it('always satisfies the format of a key, cut to its longest length', () => {
    for (const name of ['abc', '123', '1', 'x'.repeat(80), 'a b '.repeat(40), '\u0628\u0646\u0643', '9'.repeat(80)]) {
      const key = madeAlertRuleKey(name);
      expect(key).toMatch(ALERT_KEY_PATTERN);
      expect(key.length).toBeGreaterThanOrEqual(ALERT_KEY_MIN_LENGTH);
      expect(key.length).toBeLessThanOrEqual(ALERT_KEY_MAX_LENGTH);
    }
  });
});
