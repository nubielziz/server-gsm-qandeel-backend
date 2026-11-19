// Unit tests of the catalog of ready-made payment methods (feature 32): its order and entries, the top-up method each one stands for, the
// instruction templates, and the four refusals of a create request that names a preset.
import { describe, expect, it } from 'bun:test';
import { GATEWAY_PRESET_KEYS } from '@src/modules/money/db/schema';
import { driverFor } from '@src/modules/money/infra/gateway-drivers/drivers';
import {
  GATEWAY_PRESETS,
  presetOf,
  presetPinProblems,
  presetProblems,
} from '@src/modules/money/domain/gateway-presets';
import { GATEWAY_SLUG_PATTERN, checkGatewayFields, topupMethodOf } from '@src/modules/money/domain/gateway-rules';

describe('GATEWAY_PRESETS', () => {
  it('lists the eight methods of the plan in order, the same keys as the CHECK of the column', () => {
    expect(GATEWAY_PRESETS.map((preset) => preset.key)).toEqual([...GATEWAY_PRESET_KEYS]);
    expect(GATEWAY_PRESETS.map((preset) => [preset.key, preset.name, preset.kind, preset.available])).toEqual([
      ['bank_transfer', 'Bank transfer', 'manual', true],
      ['crypto_transfer', 'Crypto transfer', 'manual', true],
      ['vodafone_cash', 'Vodafone Cash', 'manual', true],
      ['fawry_transfer', 'Fawry', 'manual', true],
      ['instapay', 'InstaPay', 'manual', true],
      ['binance_pay', 'Binance Pay', 'manual', true],
      ['nowpayments', 'NOWPayments', 'automatic', false],
      ['binance_pay_auto', 'Binance Pay (automatic)', 'automatic', false],
    ]);
  });

  it('names the driver of each entry after its key and keeps it a valid slug', () => {
    for (const preset of GATEWAY_PRESETS) {
      expect(preset.driver).toBe(preset.key);
      expect(GATEWAY_SLUG_PATTERN.test(preset.driver)).toBe(true);
    }
  });

  it('gives each entry the top-up method of its driver, and no driver has code behind it yet', () => {
    expect(GATEWAY_PRESETS.map((preset) => [preset.key, preset.methodType])).toEqual([
      ['bank_transfer', 'bank'],
      ['crypto_transfer', 'usdt'],
      ['vodafone_cash', 'bank'],
      ['fawry_transfer', 'bank'],
      ['instapay', 'bank'],
      ['binance_pay', 'usdt'],
      ['nowpayments', 'usdt'],
      ['binance_pay_auto', 'usdt'],
    ]);
    for (const preset of GATEWAY_PRESETS) {
      expect(topupMethodOf(preset.driver, preset.kind === 'manual'), preset.key).toBe(preset.methodType);
      expect(driverFor(preset.driver), preset.key).toBeUndefined();
    }
  });

  it('gives a manual entry a template with blanks that passes the gateway field checks, and an automatic one none', () => {
    for (const preset of GATEWAY_PRESETS) {
      if (preset.kind === 'automatic') {
        expect(preset.instructions).toBe('');
        continue;
      }
      expect(preset.instructions).toContain('________');
      expect(preset.instructions.length).toBeLessThanOrEqual(2000);
      expect(preset.instructions).toMatch(/^[\x20-\x7e]+$/);
      expect(
        checkGatewayFields({
          name: preset.name,
          code: preset.key,
          driver: preset.driver,
          audience: 'both',
          feePercent: '0',
          feeFixed: '0',
          minAmount: '0',
          maxAmount: '0',
          holdHours: 24,
          instructions: preset.instructions,
        }),
        preset.key,
      ).toEqual([]);
    }
    expect(presetOf('vodafone_cash')!.instructions).toBe(
      'Send the amount to the Vodafone Cash number ________ and upload a screenshot of the transfer. Write your top-up number in the note.',
    );
  });

  it('turns on only the six manual transfers', () => {
    expect(GATEWAY_PRESETS.filter((preset) => preset.available).map((preset) => preset.key)).toEqual([
      'bank_transfer',
      'crypto_transfer',
      'vodafone_cash',
      'fawry_transfer',
      'instapay',
      'binance_pay',
    ]);
    expect(GATEWAY_PRESETS.every((preset) => preset.available === (preset.kind === 'manual'))).toBe(true);
  });
});

describe('presetOf', () => {
  it('finds an entry by its key and nothing for an unknown key, null or undefined', () => {
    expect(presetOf('instapay')?.name).toBe('InstaPay');
    expect(presetOf('paypal')).toBeUndefined();
    expect(presetOf('')).toBeUndefined();
    expect(presetOf(null)).toBeUndefined();
    expect(presetOf(undefined)).toBeUndefined();
  });
});

describe('presetProblems', () => {
  it('has nothing to say about a custom method', () => {
    expect(presetProblems({ preset: undefined, isManual: true, driver: 'anything' })).toEqual([]);
    expect(presetProblems({ preset: null, isManual: false, driver: 'card' })).toEqual([]);
  });

  it('accepts each available entry with its own kind and driver', () => {
    for (const preset of GATEWAY_PRESETS.filter((entry) => entry.available)) {
      expect(presetProblems({ preset: preset.key, isManual: true, driver: preset.driver }), preset.key).toEqual([]);
    }
  });

  it('refuses an unknown key with the one error on preset, whatever the other fields say', () => {
    const problems = presetProblems({ preset: 'paypal', isManual: false, driver: 'other' });
    expect(problems.map(({ field, code }) => ({ field, code }))).toEqual([{ field: 'preset', code: 'unknown' }]);
  });

  it('refuses the two automatic entries as unavailable, and only that when the request matches them', () => {
    for (const key of ['nowpayments', 'binance_pay_auto']) {
      const problems = presetProblems({ preset: key, isManual: false, driver: key });
      expect(
        problems.map(({ field, code }) => ({ field, code })),
        key,
      ).toEqual([{ field: 'preset', code: 'unavailable' }]);
    }
  });

  it('refuses a kind that is not the preset kind on isManual', () => {
    const manual = presetProblems({ preset: 'vodafone_cash', isManual: false, driver: 'vodafone_cash' });
    expect(manual.map(({ field, code }) => ({ field, code }))).toEqual([{ field: 'isManual', code: 'preset_kind' }]);
    const automatic = presetProblems({ preset: 'nowpayments', isManual: true, driver: 'nowpayments' });
    expect(automatic.map(({ field, code }) => `${field}:${code}`)).toEqual([
      'preset:unavailable',
      'isManual:preset_kind',
    ]);
  });

  it('refuses another driver name on driver, and reports every problem at once', () => {
    const wrongDriver = presetProblems({ preset: 'instapay', isManual: true, driver: 'bank' });
    expect(wrongDriver.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: 'driver', code: 'preset_driver' },
    ]);
    const both = presetProblems({ preset: 'instapay', isManual: false, driver: 'card' });
    expect(both.map(({ field, code }) => `${field}:${code}`)).toEqual(['isManual:preset_kind', 'driver:preset_driver']);
    expect(both.every((problem) => problem.message.length > 0)).toBe(true);
  });
});

describe('presetPinProblems', () => {
  const codes = (problems: Array<{ field: string; code: string }>) =>
    problems.map(({ field, code }) => `${field}:${code}`);

  it('has nothing to say about a custom method, whatever its kind and driver become', () => {
    expect(presetPinProblems(null, { isManual: false, driver: 'card' })).toEqual([]);
    expect(presetPinProblems(undefined, { isManual: true, driver: 'anything' })).toEqual([]);
  });

  it('lets a preset-made method keep its own kind and driver', () => {
    for (const preset of GATEWAY_PRESETS) {
      const merged = { isManual: preset.kind === 'manual', driver: preset.driver };
      expect(presetPinProblems(preset.key, merged), preset.key).toEqual([]);
    }
  });

  it('refuses another kind on isManual (preset_kind) and another driver on driver (preset_driver), each alone or both', () => {
    expect(codes(presetPinProblems('vodafone_cash', { isManual: false, driver: 'vodafone_cash' }))).toEqual([
      'isManual:preset_kind',
    ]);
    expect(codes(presetPinProblems('vodafone_cash', { isManual: true, driver: 'card' }))).toEqual([
      'driver:preset_driver',
    ]);
    const both = presetPinProblems('vodafone_cash', { isManual: false, driver: 'card' });
    expect(codes(both)).toEqual(['isManual:preset_kind', 'driver:preset_driver']);
    expect(both.every((problem) => problem.message.length > 0)).toBe(true);
  });

  it('never asks for an available entry or a known key: an existing row stays editable', () => {
    // An automatic entry that is not available yet (a row made before, or by hand) still only has its kind and driver pinned.
    expect(presetPinProblems('nowpayments', { isManual: false, driver: 'nowpayments' })).toEqual([]);
    // A stored key a later release dropped from the catalog pins nothing.
    expect(presetPinProblems('removed_entry', { isManual: false, driver: 'card' })).toEqual([]);
  });
});
