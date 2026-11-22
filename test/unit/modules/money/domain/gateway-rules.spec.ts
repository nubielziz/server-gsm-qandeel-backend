// Unit tests of the gateway rules: field checks, the secret hint, the top-up method, the fee and the amount limits.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  type GatewayFields,
  changesAutomaticSetup,
  changesCredentials,
  checkDepositAmount,
  checkGatewayFields,
  depositFee,
  effectiveMaxAmount,
  nextWebhookSecrets,
  secretHintOf,
  topupMethodOf,
} from '@src/modules/money/domain/gateway-rules';

const fields = (overrides: Partial<GatewayFields> = {}): GatewayFields => ({
  name: 'Card gateway',
  code: 'card',
  driver: 'card',
  audience: 'both',
  feePercent: '2.9',
  feeFixed: '0.30',
  minAmount: '5',
  maxAmount: '2000',
  holdHours: 0,
  instructions: '',
  ...overrides,
});

describe('checkGatewayFields', () => {
  it('accepts the console defaults and edge values', () => {
    expect(checkGatewayFields(fields())).toEqual([]);
    expect(checkGatewayFields(fields({ feePercent: '0', maxAmount: '0', minAmount: '0', holdHours: 720 }))).toEqual([]);
    expect(checkGatewayFields(fields({ feePercent: '100', maxAmount: '5', minAmount: '5' }))).toEqual([]);
  });

  it('names each bad field', () => {
    const names = (overrides: Partial<GatewayFields>) =>
      checkGatewayFields(fields(overrides)).map((error) => error.field);
    expect(names({ name: '  ' })).toEqual(['name']);
    expect(names({ code: 'Has Space' })).toEqual(['code']);
    expect(names({ code: '' })).toEqual(['code']);
    expect(names({ driver: '-x' })).toEqual(['driver']);
    expect(names({ audience: 'everyone' })).toEqual(['audience']);
    expect(names({ feePercent: '100.1' })).toEqual(['feePercent']);
    expect(names({ feePercent: '1.23456' })).toEqual(['feePercent']);
    expect(names({ feeFixed: '-1' })).toEqual(['feeFixed']);
    expect(names({ minAmount: 'abc' })).toEqual(['minAmount']);
    expect(names({ minAmount: '50', maxAmount: '10' })).toEqual(['maxAmount']);
    expect(names({ holdHours: 721 })).toEqual(['holdHours']);
    expect(names({ holdHours: 1.5 })).toEqual(['holdHours']);
  });
});

describe('nextWebhookSecrets', () => {
  it('replaces the first secret and keeps the second', () => {
    expect(nextWebhookSecrets(['a', 'b'], { webhookSecret: 'c' })).toEqual({ secrets: ['c', 'b'], changed: true });
    expect(nextWebhookSecrets(['a'], { webhookSecret: 'c' })).toEqual({ secrets: ['c'], changed: true });
    expect(nextWebhookSecrets([], { webhookSecret: 'c' })).toEqual({ secrets: ['c'], changed: true });
  });

  it('sets, keeps and removes the second secret', () => {
    expect(nextWebhookSecrets(['a'], { secondaryWebhookSecret: 'b' })).toEqual({ secrets: ['a', 'b'], changed: true });
    expect(nextWebhookSecrets(['a', 'b'], {})).toEqual({ secrets: ['a', 'b'], changed: false });
    expect(nextWebhookSecrets(['a', 'b'], { webhookSecret: '' })).toEqual({ secrets: ['a', 'b'], changed: false });
    expect(nextWebhookSecrets(['a', 'b'], { secondaryWebhookSecret: null })).toEqual({ secrets: ['a'], changed: true });
    expect(nextWebhookSecrets(['a'], { secondaryWebhookSecret: null })).toEqual({ secrets: ['a'], changed: false });
    expect(nextWebhookSecrets([], { webhookSecret: 'a', secondaryWebhookSecret: 'b' })).toEqual({
      secrets: ['a', 'b'],
      changed: true,
    });
  });

  it('refuses a second secret without a first', () => {
    expect(nextWebhookSecrets([], { secondaryWebhookSecret: 'b' })).toMatchObject({
      field: 'secondaryWebhookSecret',
      code: 'requires_first',
    });
    expect(nextWebhookSecrets([], {})).toEqual({ secrets: [], changed: false });
  });
});

describe('secretHintOf', () => {
  it('shows four bullets and the last four characters, or nothing', () => {
    expect(secretHintOf('sk_live_abcdef4f2a')).toBe('••••4f2a');
    expect(secretHintOf('abc')).toBe('••••abc');
    expect(secretHintOf(undefined)).toBeNull();
    expect(secretHintOf('')).toBeNull();
  });
});

describe('topupMethodOf', () => {
  it('reads the method from the driver and falls back on whether staff review the payments', () => {
    expect(topupMethodOf('card', false)).toBe('card');
    expect(topupMethodOf('Stripe', false)).toBe('card');
    expect(topupMethodOf('crypto', false)).toBe('usdt');
    expect(topupMethodOf('bank', true)).toBe('bank');
    expect(topupMethodOf('wise', true)).toBe('wise');
    expect(topupMethodOf('mystery', true)).toBe('bank');
    expect(topupMethodOf('mystery', false)).toBe('card');
  });

  it('reads usdt from the drivers of the ready-made crypto methods and bank from the other ready-made ones (feature 32)', () => {
    for (const driver of ['crypto_transfer', 'binance_pay', 'nowpayments', 'binance_pay_auto']) {
      expect(topupMethodOf(driver, true), driver).toBe('usdt');
    }
    for (const driver of ['bank_transfer', 'vodafone_cash', 'fawry_transfer', 'instapay']) {
      expect(topupMethodOf(driver, true), driver).toBe('bank');
    }
  });
});

describe('depositFee and effectiveMaxAmount', () => {
  it('takes a percent of the amount plus the fixed fee, rounded half up', () => {
    expect(depositFee(Money.of('100'), '2.9', '0.30').toWire()).toBe('3.2000');
    expect(depositFee(Money.of('0.50'), '2.9', '0').toWire()).toBe('0.0145');
    expect(depositFee(Money.of('100'), '0', '0').toWire()).toBe('0.0000');
  });

  it('lets a zero on one side leave the other alone', () => {
    expect(effectiveMaxAmount('5000', '1000')).toBe('1000.0000');
    expect(effectiveMaxAmount('300', '1000')).toBe('300.0000');
    expect(effectiveMaxAmount('0', '1000')).toBe('1000.0000');
    expect(effectiveMaxAmount('5000', '0')).toBe('5000.0000');
    expect(effectiveMaxAmount('0', '0')).toBe('0.0000');
  });
});

describe('checkDepositAmount', () => {
  const limits = { minAmount: '50', maxAmount: '5000', depositLimit: '1000', feePercent: '1', feeFixed: '0.5' };

  it('accepts an amount inside every limit, the edges included', () => {
    for (const amount of ['50', '1000', '123.45']) expect(checkDepositAmount(Money.of(amount), limits)).toBeUndefined();
  });

  it('refuses below the minimum, above the maximum, above the group limit, a fee that eats the amount and zero', () => {
    expect(checkDepositAmount(Money.of('49.99'), limits)?.code).toBe('min');
    expect(checkDepositAmount(Money.of('1000.01'), limits)?.code).toBe('deposit_limit');
    expect(checkDepositAmount(Money.of('6000'), { ...limits, depositLimit: '0' })?.code).toBe('max');
    expect(checkDepositAmount(Money.of('1'), { ...limits, minAmount: '0', feeFixed: '5' })?.code).toBe('fee');
    expect(checkDepositAmount(Money.zero(), limits)?.code).toBe('range');
    expect(
      checkDepositAmount(Money.of('5'), { ...limits, minAmount: '0', maxAmount: '0', depositLimit: '0' }),
    ).toBeUndefined();
  });
});

describe('changesCredentials', () => {
  it('is true for a sent secret, webhook secret or second webhook secret (also null), false for empty and absent ones', () => {
    expect(changesCredentials({ secret: 'sk_live_1' })).toBe(true);
    expect(changesCredentials({ webhookSecret: 'whsec_1' })).toBe(true);
    expect(changesCredentials({ secondaryWebhookSecret: 'whsec_2' })).toBe(true);
    expect(changesCredentials({ secondaryWebhookSecret: null })).toBe(true);
    expect(changesCredentials({})).toBe(false);
    expect(changesCredentials({ secret: '', webhookSecret: '', secondaryWebhookSecret: undefined })).toBe(false);
  });

  it('does not count removing a second webhook secret that the stored method does not have', () => {
    expect(changesCredentials({ secondaryWebhookSecret: null }, [])).toBe(false);
    expect(changesCredentials({ secondaryWebhookSecret: null }, ['whsec_1'])).toBe(false);
    expect(changesCredentials({ secondaryWebhookSecret: null }, ['whsec_1', 'whsec_2'])).toBe(true);
    // Every other value is still a change, whatever is stored.
    expect(changesCredentials({ secondaryWebhookSecret: 'whsec_2' }, ['whsec_1'])).toBe(true);
    expect(changesCredentials({ webhookSecret: 'whsec_3', secondaryWebhookSecret: null }, ['whsec_1'])).toBe(true);
    expect(changesCredentials({ secret: 'sk_1', secondaryWebhookSecret: null }, [])).toBe(true);
    expect(changesCredentials({}, ['whsec_1', 'whsec_2'])).toBe(false);
  });
});

describe('changesAutomaticSetup', () => {
  const manual = { isManual: true, driver: 'bank' };
  const automatic = { isManual: false, driver: 'card' };

  it('is true when a manual method becomes automatic, and when an automatic method becomes manual', () => {
    expect(changesAutomaticSetup(manual, { isManual: false, driver: 'bank' })).toBe(true);
    expect(changesAutomaticSetup(automatic, { ...automatic, isManual: true })).toBe(true);
  });

  it('is true when the driver changes while the method is automatic before or after the change', () => {
    expect(changesAutomaticSetup(automatic, { ...automatic, driver: 'wise' })).toBe(true);
    expect(changesAutomaticSetup(automatic, { isManual: true, driver: 'bank' })).toBe(true);
    expect(changesAutomaticSetup(manual, { isManual: false, driver: 'card' })).toBe(true);
  });

  it('is false for a manual method that stays manual, and for an automatic one that keeps its driver', () => {
    expect(changesAutomaticSetup(manual, { ...manual, driver: 'cash' })).toBe(false);
    expect(changesAutomaticSetup(manual, manual)).toBe(false);
    expect(changesAutomaticSetup(automatic, automatic)).toBe(false);
  });
});
