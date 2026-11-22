// Unit tests of the risk inputs table (decision 050): every rule and signal says what it needs, and the gaps of an installation are named.
import { describe, expect, it } from 'bun:test';
import {
  NEEDED_INPUT,
  SIGNALS_WITHOUT_SWITCH,
  inputSourcesOf,
  rulesWithoutInput,
} from '@src/modules/risk/domain/risk-inputs';
import { RISK_RULE_IDS, defaultRuleSet, mergeRules } from '@src/modules/risk/domain/risk-rules';
import { CARD_DETAILS_MISSING_SIGNAL, SIGNAL_POINTS } from '@src/modules/risk/domain/risk-scoring';

describe('NEEDED_INPUT', () => {
  it('classifies every rule and every signal by the input it needs', () => {
    const expected = [...RISK_RULE_IDS, ...Object.keys(SIGNAL_POINTS)].sort();
    expect(Object.keys(NEEDED_INPUT).sort()).toEqual(expected);
  });

  it('keeps the prepaid-card signal on the card driver, which supplies the funding', () => {
    expect(NEEDED_INPUT.prepaidCard).toBeNull();
    expect(SIGNALS_WITHOUT_SWITCH.cardDetailsMissing).toBe(CARD_DETAILS_MISSING_SIGNAL);
  });
});

describe('rulesWithoutInput', () => {
  const rules = defaultRuleSet();

  it('names every switched-on rule and every signal whose input this installation lacks', () => {
    const gaps = rulesWithoutInput(rules, inputSourcesOf(undefined));
    expect(gaps.map((gap) => gap.name)).toEqual(['blockBlacklistedImei', 'reviewIpCountryMismatch', 'proxyIp']);
    expect(gaps).toEqual([
      {
        name: 'blockBlacklistedImei',
        label: 'Block blacklisted IMEIs before payment',
        reason: 'No IMEI blacklist lookup is connected: only an IMEI check stored as blacklisted matches.',
      },
      {
        name: 'reviewIpCountryMismatch',
        label: 'Hold when the IP country differs from the card country',
        reason: 'No visitor country: GEOIP_COUNTRY_HEADER is not set.',
      },
      { name: 'proxyIp', label: 'VPN or proxy IP', reason: 'No VPN or proxy lookup is connected.' },
    ]);
  });

  it('stops naming the IP-country rule once the visitor-country header is configured', () => {
    expect(rulesWithoutInput(rules, inputSourcesOf('cf-ipcountry')).map((gap) => gap.name)).toEqual([
      'blockBlacklistedImei',
      'proxyIp',
    ]);
  });

  it('does not name a rule that is switched off', () => {
    const merged = mergeRules(rules, [
      { id: 'reviewIpCountryMismatch', on: false, value: null },
      { id: 'blockBlacklistedImei', on: false, value: null },
    ]);
    if (!merged.ok) throw new Error('unexpected');
    expect(rulesWithoutInput(merged.next, inputSourcesOf(undefined)).map((gap) => gap.name)).toEqual(['proxyIp']);
  });
});
