// Unit tests of the settings allow-list: which keys the generic settings route accepts and how it judges their values.
import { describe, expect, it } from 'bun:test';
import {
  BROADCAST_EMAIL_PER_SECOND_KEY,
  BROADCAST_TELEGRAM_PER_SECOND_KEY,
  broadcastRateProblem,
  CUSTOMER_WALLET_SETTING_RANGES,
  CUSTOMER_WALLET_SETTINGS,
  EDITABLE_SETTINGS,
  FX_GUARD_SETTINGS,
  imeiRetentionDaysProblem,
  INBOX_READ_RETENTION_DAYS_KEY,
  INBOX_RETENTION_DAYS_KEY,
  inboxReadRetentionDaysProblem,
  inboxRetentionDaysProblem,
  LOG_RETENTION_DAYS_KEY,
  logRetentionDaysProblem,
  PRICE_CHANGE_TOLERANCE_KEY,
  ownerOnlySettingKeys,
  priceChangeTolerancePercentProblem,
  settingsPatchProblems,
} from '@src/modules/platform/settings/settings-registry';

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

describe('broadcastRateProblem', () => {
  it('accepts whole numbers from 1 to 30', () => {
    for (const value of [1, 5, 20, 30]) expect(broadcastRateProblem(value)).toBeUndefined();
  });

  it('refuses anything else', () => {
    for (const value of [0, 31, 2.5, '5', null, true, undefined, Number.NaN]) {
      expect(broadcastRateProblem(value)).toBeString();
    }
  });

  it('is the validator of both broadcast rate keys', () => {
    expect(
      settingsPatchProblems({ [BROADCAST_EMAIL_PER_SECOND_KEY]: 10, [BROADCAST_TELEGRAM_PER_SECOND_KEY]: 25 }),
    ).toEqual([]);
    expect(settingsPatchProblems({ [BROADCAST_EMAIL_PER_SECOND_KEY]: 0 })).toHaveLength(1);
  });
});

describe('the notification retention settings', () => {
  it('accept whole days inside their bounds: 7-3650 for read items, 30-3650 for all items and the log', () => {
    for (const value of [7, 90, 3650]) expect(inboxReadRetentionDaysProblem(value)).toBeUndefined();
    for (const value of [30, 365, 3650]) {
      expect(inboxRetentionDaysProblem(value)).toBeUndefined();
      expect(logRetentionDaysProblem(value)).toBeUndefined();
    }
  });

  it('refuse a number below the minimum, above 3650, a fraction and a non-number', () => {
    for (const value of [6, 3651, 1.5, '90', null, undefined])
      expect(inboxReadRetentionDaysProblem(value)).toBeString();
    for (const value of [29, 3651, 1.5, '90', null, undefined]) {
      expect(inboxRetentionDaysProblem(value)).toBeString();
      expect(logRetentionDaysProblem(value)).toBeString();
    }
  });

  it('are the validators of their three keys in the settings route', () => {
    expect(
      settingsPatchProblems({
        [INBOX_READ_RETENTION_DAYS_KEY]: 30,
        [INBOX_RETENTION_DAYS_KEY]: 400,
        [LOG_RETENTION_DAYS_KEY]: 365,
      }),
    ).toEqual([]);
    expect(settingsPatchProblems({ [LOG_RETENTION_DAYS_KEY]: 7 })).toHaveLength(1);
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

describe('owner-only settings (decisions 051 and 049)', () => {
  const OWNER_ONLY = [
    'suppliers.allowPlainHttp',
    'fx.max_refresh_move_percent',
    'fx.max_rate_age_hours',
    'wallet.customer.adjust_approval_limit',
  ];

  it('reserves exactly four keys to Owners', () => {
    expect(
      EDITABLE_SETTINGS.filter((setting) => setting.ownerOnly === true)
        .map((setting) => setting.key)
        .sort(),
    ).toEqual([...OWNER_ONLY].sort());
    expect(FX_GUARD_SETTINGS.maxRefreshMovePercent.key).toBe('fx.max_refresh_move_percent');
    expect(FX_GUARD_SETTINGS.maxRateAgeHours.key).toBe('fx.max_rate_age_hours');
    expect(CUSTOMER_WALLET_SETTINGS.adjustApprovalLimit).toBe('wallet.customer.adjust_approval_limit');
    expect(ownerOnlySettingKeys(Object.fromEntries(OWNER_ONLY.map((key) => [key, 1])))).toEqual(OWNER_ONLY);
  });

  it('names a reserved key whether it comes alone or beside ordinary keys, and none of the others', () => {
    expect(ownerOnlySettingKeys({ 'suppliers.allowPlainHttp': true, imeiRetentionDays: 30 })).toEqual([
      'suppliers.allowPlainHttp',
    ]);
    expect(ownerOnlySettingKeys({ imeiRetentionDays: 30, 'fx.max_rate_age_hours': 72 })).toEqual([
      'fx.max_rate_age_hours',
    ]);
    expect(ownerOnlySettingKeys({ imeiRetentionDays: 30 })).toEqual([]);
    expect(ownerOnlySettingKeys({ 'wallet.customer.max_topup': 500, 'fx.unknown': 1 })).toEqual([]);
    expect(ownerOnlySettingKeys({ 'not.a.setting': 1 })).toEqual([]);
    // The validator still judges the value first: the keys stay ordinary registry entries.
    expect(settingsPatchProblems({ 'suppliers.allowPlainHttp': 'yes' })).toHaveLength(1);
    expect(settingsPatchProblems({ 'fx.max_refresh_move_percent': 0, 'fx.max_rate_age_hours': 721 })).toHaveLength(2);
    expect(settingsPatchProblems({ 'wallet.customer.adjust_approval_limit': 10_001 })).toHaveLength(1);
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

describe('the exchange-rate guards (decision 049)', () => {
  it('accept the two guards within their ranges and refuse outside them', () => {
    const move = FX_GUARD_SETTINGS.maxRefreshMovePercent.key;
    const age = FX_GUARD_SETTINGS.maxRateAgeHours.key;
    expect(move).toBe('fx.max_refresh_move_percent');
    expect(age).toBe('fx.max_rate_age_hours');
    expect(settingsPatchProblems({ [move]: 1, [age]: 1 })).toEqual([]);
    expect(settingsPatchProblems({ [move]: 100, [age]: 720 })).toEqual([]);
    for (const bad of [0, 101, 20.5, '20', null]) expect(settingsPatchProblems({ [move]: bad })).toHaveLength(1);
    for (const bad of [0, 721, 1.5, true]) expect(settingsPatchProblems({ [age]: bad })).toHaveLength(1);
  });

  it('default to 20 percent and 48 hours', () => {
    expect(FX_GUARD_SETTINGS.maxRefreshMovePercent.fallback).toBe(20);
    expect(FX_GUARD_SETTINGS.maxRateAgeHours.fallback).toBe(48);
  });
});
