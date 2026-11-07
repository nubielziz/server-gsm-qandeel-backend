// Unit tests of the service figures: default minimum profit, floor, margin, below-floor and the delivery time text.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import {
  defaultMinProfit,
  deliveryTimeText,
  dollars,
  effectiveMinProfit,
  floorPrice,
  isBelowFloor,
  marginPercent,
} from './service-figures';

describe('defaultMinProfit', () => {
  it('is 6 % of the cost rounded half-up to cents, never below 0.02', () => {
    expect(defaultMinProfit(Money.of('0')).toWire()).toBe('0.0200');
    expect(defaultMinProfit(Money.of('0.08')).toWire()).toBe('0.0200');
    expect(defaultMinProfit(Money.of('13.5')).toWire()).toBe('0.8100');
    expect(defaultMinProfit(Money.of('9.8')).toWire()).toBe('0.5900');
    expect(defaultMinProfit(Money.of('19.8')).toWire()).toBe('1.1900');
    expect(defaultMinProfit(Money.of('100')).toWire()).toBe('6.0000');
  });

  it('rounds once, from the exact product (0.4159 x 6 % = 0.024954 is 0.02)', () => {
    expect(defaultMinProfit(Money.of('0.4159')).toWire()).toBe('0.0200');
    // The exact half goes up: 0.4167 x 6 % = 0.025002 is 0.03, and 8.25 x 6 % = 0.495 is 0.50.
    expect(defaultMinProfit(Money.of('0.4167')).toWire()).toBe('0.0300');
    expect(defaultMinProfit(Money.of('8.25')).toWire()).toBe('0.5000');
  });

  it('refuses a negative cost', () => {
    expect(() => defaultMinProfit(Money.of('-1'))).toThrow(RangeError);
  });
});

describe('floor, margin and below-floor', () => {
  it('uses the own minimum profit when set, else the default', () => {
    expect(effectiveMinProfit(Money.of('0.5'), Money.of('10')).toWire()).toBe('0.5000');
    expect(effectiveMinProfit(null, Money.of('10')).toWire()).toBe('0.6000');
  });

  it('adds the minimum profit to the cost', () => {
    expect(floorPrice(Money.of('13.5'), Money.of('0.81')).toWire()).toBe('14.3100');
  });

  it('works out the margin on the price, half-up at four digits', () => {
    expect(marginPercent(Money.of('17.28'), Money.of('13.5')).toString()).toBe('21.8750');
    expect(marginPercent(Money.of('3'), Money.of('1')).toString()).toBe('66.6667');
    expect(marginPercent(Money.of('19.5'), Money.of('19.8')).toString()).toBe('-1.5385');
    expect(() => marginPercent(Money.zero(), Money.of('1'))).toThrow(RangeError);
  });

  it('is below the floor only when strictly under it', () => {
    expect(isBelowFloor(Money.of('14.30'), Money.of('14.31'))).toBe(true);
    expect(isBelowFloor(Money.of('14.31'), Money.of('14.31'))).toBe(false);
  });
});

describe('dollars', () => {
  it('shows at least two and at most four decimals', () => {
    expect(dollars(Money.of('12.5'))).toBe('$12.50');
    expect(dollars(Money.of('0.0825'))).toBe('$0.0825');
    expect(dollars(Money.of('7'))).toBe('$7.00');
  });
});

describe('deliveryTimeText', () => {
  it('writes minutes, hours and days', () => {
    expect(deliveryTimeText(1)).toBe('1 min');
    expect(deliveryTimeText(45)).toBe('45 min');
    expect(deliveryTimeText(60)).toBe('1 hour');
    expect(deliveryTimeText(120)).toBe('2 hours');
    expect(deliveryTimeText(90)).toBe('1 h 30 min');
    expect(deliveryTimeText(1440)).toBe('1 day');
    expect(deliveryTimeText(2880)).toBe('2 days');
    expect(deliveryTimeText(1800)).toBe('1 d 6 h');
    expect(deliveryTimeText(1830)).toBe('1 d 6 h 30 min');
  });

  it('refuses a value that is not a whole number from 1', () => {
    expect(() => deliveryTimeText(0)).toThrow(RangeError);
    expect(() => deliveryTimeText(1.5)).toThrow(RangeError);
  });
});
