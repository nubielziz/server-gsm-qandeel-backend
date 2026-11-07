// Unit tests of the gateway rules: field checks, the secret hint, the top-up method, the fee and the amount limits.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import {
  type GatewayFields,
  checkDepositAmount,
  checkGatewayFields,
  depositFee,
  effectiveMaxAmount,
  secretHintOf,
  topupMethodOf,
} from './gateway-rules';

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
