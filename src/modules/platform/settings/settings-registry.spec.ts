// Unit tests of the settings allow-list: which keys the generic settings route accepts and how it judges their values.
import { describe, expect, it } from 'bun:test';
import {
  CUSTOMER_WALLET_SETTINGS,
  CUSTOMER_WALLET_SETTING_RANGES,
  PRICE_CHANGE_TOLERANCE_KEY,
  imeiRetentionDaysProblem,
  priceChangeTolerancePercentProblem,
  settingsPatchProblems,
} from './settings-registry';

describe('imeiRetentionDaysProblem', () => {
  it('accepts whole numbers from 0 to 3650', () => {
    for (const value of [0, 1, 90, 3650]) expect(imeiRetentionDaysProblem(value)).toBeUndefined();
  });

  it('refuses anything else', () => {
    for (const value of [-1, 3651, 1.5, '90', null, true, undefined, Number.NaN]) {
      expect(imeiRetentionDaysProblem(value)).toBeString();
    }
  });
});

describe('priceChangeTolerancePercentProblem', () => {
  it('accepts whole numbers from 0 to 100', () => {
    for (const value of [0, 1, 10, 100]) expect(priceChangeTolerancePercentProblem(value)).toBeUndefined();
  });

  it('refuses anything else', () => {
    for (const value of [-1, 101, 2.5, '10', null, true, undefined, Number.NaN]) {
      expect(priceChangeTolerancePercentProblem(value)).toBeString();
    }
  });
});

describe('settingsPatchProblems', () => {
  it('accepts a patch of allowed keys', () => {
    expect(settingsPatchProblems({ imeiRetentionDays: 30 })).toEqual([]);
    expect(settingsPatchProblems({ [PRICE_CHANGE_TOLERANCE_KEY]: 15 })).toEqual([]);
  });

  it('judges the price change tolerance like any registry key', () => {
    expect(settingsPatchProblems({ [PRICE_CHANGE_TOLERANCE_KEY]: 150 }).map((problem) => problem.key)).toEqual([
      PRICE_CHANGE_TOLERANCE_KEY,
    ]);
  });

  it('names every key that is unknown, guarded by another route, or has a bad value', () => {
    const problems = settingsPatchProblems({
      adminAllowlistOnly: true,
      maintenance: { enabled: true },
      madeUpKey: 1,
      imeiRetentionDays: 9999,
    });
    expect(problems.map((problem) => problem.key)).toEqual([
      'adminAllowlistOnly',
      'maintenance',
      'madeUpKey',
      'imeiRetentionDays',
    ]);
  });
});

describe('the supplier settings', () => {
  it('accept the whole numbers and the boolean the supplier jobs read', () => {
    expect(
      settingsPatchProblems({
        'catalog.importDefaultSlaMinutes': 1440,
        'orders.poll_slow_after_hours': 24,
        'suppliers.allowPlainHttp': true,
      }),
    ).toEqual([]);
  });

  it('refuse values outside their range or of another type', () => {
    expect(
      settingsPatchProblems({
        'catalog.importDefaultSlaMinutes': 0,
        'orders.poll_slow_after_hours': 9000,
        'suppliers.allowPlainHttp': 'yes',
      }).map((problem) => problem.key),
    ).toEqual(['catalog.importDefaultSlaMinutes', 'orders.poll_slow_after_hours', 'suppliers.allowPlainHttp']);
    expect(settingsPatchProblems({ 'catalog.importDefaultSlaMinutes': 1.5 })).toHaveLength(1);
  });
});

describe('customer wallet settings (feature 21)', () => {
  it('accept the two switches as booleans only', () => {
    for (const key of [CUSTOMER_WALLET_SETTINGS.enabled, CUSTOMER_WALLET_SETTINGS.cardTopUps]) {
      expect(settingsPatchProblems({ [key]: true })).toEqual([]);
      expect(settingsPatchProblems({ [key]: false })).toEqual([]);
      for (const value of ['true', 1, null]) expect(settingsPatchProblems({ [key]: value })).toHaveLength(1);
    }
  });

  it('accept each whole-number setting at its bounds and refuse outside them, decimals and text', () => {
    for (const [key, range] of Object.entries(CUSTOMER_WALLET_SETTING_RANGES)) {
      expect(settingsPatchProblems({ [key]: range.min }), key).toEqual([]);
      expect(settingsPatchProblems({ [key]: range.max }), key).toEqual([]);
      for (const value of [range.min - 1, range.max + 1, 5.5, '5', null]) {
        expect(settingsPatchProblems({ [key]: value }), `${key} ${String(value)}`).toHaveLength(1);
      }
    }
    expect(Object.keys(CUSTOMER_WALLET_SETTING_RANGES)).toHaveLength(6);
  });

  it('cap the approval limit at $10,000 and allow 0', () => {
    expect(CUSTOMER_WALLET_SETTING_RANGES[CUSTOMER_WALLET_SETTINGS.adjustApprovalLimit]).toEqual({
      min: 0,
      max: 10_000,
    });
  });
});
