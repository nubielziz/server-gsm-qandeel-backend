// Unit tests of the low-balance rule (feature 7b): the merchant's threshold, the available balance and the crossing.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { availableOf, crossedBelow, thresholdFrom } from './low-balance';

const m = (amount: string) => Money.of(amount);

describe('thresholdFrom', () => {
  it('reads a money string from the preferences', () => {
    expect(thresholdFrom({ lowBalanceThreshold: '50.0000' })?.toWire()).toBe('50.0000');
    expect(thresholdFrom({ lowBalanceThreshold: ' 12.5 ' })?.toWire()).toBe('12.5000');
  });

  it('is none when missing, zero, negative, a number or malformed', () => {
    for (const prefs of [
      undefined,
      null,
      {},
      { lowBalanceThreshold: '0' },
      { lowBalanceThreshold: '-5' },
      { lowBalanceThreshold: 50 },
      { lowBalanceThreshold: 'fifty' },
      { lowBalanceThreshold: '1.23456' },
      { lowBalanceThreshold: null },
    ]) {
      expect(thresholdFrom(prefs as Record<string, unknown> | null | undefined), JSON.stringify(prefs)).toBeUndefined();
    }
  });
});

describe('availableOf', () => {
  it('is the balance plus the credit limit', () => {
    expect(availableOf(m('42.5'), m('0')).toWire()).toBe('42.5000');
    expect(availableOf(m('-30'), m('500')).toWire()).toBe('470.0000');
  });
});

describe('crossedBelow', () => {
  const threshold = m('50');

  it('is true when a posting takes the balance from the threshold or above to below it', () => {
    expect(crossedBelow(m('60'), m('49.9999'), threshold)).toBe(true);
    expect(crossedBelow(m('50'), m('10'), threshold)).toBe(true);
  });

  it('is false while the balance stays under the threshold: once per crossing, not per posting', () => {
    expect(crossedBelow(m('40'), m('30'), threshold)).toBe(false);
  });

  it('is false while the balance stays at or above it, and when it rises back', () => {
    expect(crossedBelow(m('80'), m('50'), threshold)).toBe(false);
    expect(crossedBelow(m('20'), m('90'), threshold)).toBe(false);
  });

  it('crosses again after the balance was back at the threshold', () => {
    expect(crossedBelow(m('50'), m('49.9999'), threshold)).toBe(true);
  });
});
