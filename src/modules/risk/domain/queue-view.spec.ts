// Unit tests of the risk queue's wire rules (feature 18).
import { describe, expect, it } from 'bun:test';
import { deviceName, heldShare, queueMethodOf, refundReason, signalsOf, tacOfInput } from './queue-view';

describe('queueMethodOf', () => {
  it('keeps card, wallet and crypto, maps usdt to crypto and anything else to card', () => {
    expect(queueMethodOf('card')).toBe('card');
    expect(queueMethodOf('wallet')).toBe('wallet');
    expect(queueMethodOf('crypto')).toBe('crypto');
    expect(queueMethodOf('usdt')).toBe('crypto');
    expect(queueMethodOf('bank')).toBe('card');
    expect(queueMethodOf(null)).toBe('card');
  });
});

describe('deviceName', () => {
  it('uses the marketing name with the model in brackets, else brand and model, else null', () => {
    expect(deviceName({ brand: 'Xiaomi', model: '23021RAAEG', marketingName: 'Redmi Note 12' })).toBe(
      'Redmi Note 12 (23021RAAEG)',
    );
    expect(deviceName({ brand: 'Apple', model: 'iPhone 13', marketingName: '  ' })).toBe('Apple iPhone 13');
    expect(deviceName(undefined)).toBeNull();
  });
});

describe('tacOfInput', () => {
  it('reads the first 8 digits of an IMEI-like input', () => {
    expect(tacOfInput('353890113898412')).toBe('35389011');
    expect(tacOfInput('35 389011 3898412')).toBe('35389011');
    expect(tacOfInput('SN-1')).toBeNull();
    expect(tacOfInput(null)).toBeNull();
  });
});

describe('heldShare', () => {
  it('is a percent with one decimal, 0 without orders', () => {
    expect(heldShare(7, 120)).toBe(5.8);
    expect(heldShare(1, 3)).toBe(33.3);
    expect(heldShare(0, 0)).toBe(0);
  });
});

describe('refundReason and signalsOf', () => {
  it('uses the typed reason, else the first signal, else the demo fallback', () => {
    expect(refundReason(['Prepaid card BIN'], '  Owner did not match ')).toBe('Owner did not match');
    expect(refundReason(['Prepaid card BIN', 'x'], undefined)).toBe('Refunded after risk review: Prepaid card BIN');
    expect(refundReason([], '  ')).toBe('Refunded after risk review: high risk score');
  });

  it('reads only the string items of the stored signals', () => {
    expect(signalsOf(['a', 3, 'b', null])).toEqual(['a', 'b']);
    expect(signalsOf({})).toEqual([]);
  });
});
