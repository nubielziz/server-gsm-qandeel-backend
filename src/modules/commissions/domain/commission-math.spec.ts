// Unit tests of the commission arithmetic (feature 11): the amount of an accrual, its period and the audit text of an amount.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { accrualAmount, moneyText, periodOf } from './commission-math';

describe('accrualAmount', () => {
  it('is revenue times the rate, with the demo numbers (16.26 at 3 percent is 0.4878)', () => {
    expect(accrualAmount(Money.of('16.26'), '3.0000').toWire()).toBe('0.4878');
    expect(accrualAmount(Money.of('20.99'), '5.0000').toWire()).toBe('1.0495');
  });

  it('rounds half up at the fourth decimal', () => {
    // 0.0150 x 0.5 / 100 = 0.000075 -> 0.0001
    expect(accrualAmount(Money.of('0.015'), '0.5000').toWire()).toBe('0.0001');
    expect(accrualAmount(Money.of('0.001'), '0.5000').toWire()).toBe('0.0000');
  });

  it('keeps a fractional percent exactly (3.55 percent of 100)', () => {
    expect(accrualAmount(Money.of('100'), '3.5500').toWire()).toBe('3.5500');
  });
});

describe('periodOf', () => {
  it('is the completion month in UTC', () => {
    expect(periodOf(new Date('2026-11-07T08:00:00.000Z'))).toBe('2026-11');
  });

  it('puts the last millisecond of a month in that month and the next one in the next', () => {
    expect(periodOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
    expect(periodOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
  });
});

describe('moneyText', () => {
  it('writes a dollar sign and at least two decimals, without needless zeros', () => {
    expect(moneyText(Money.of('1.05'))).toBe('$1.05');
    expect(moneyText(Money.of('3'))).toBe('$3.00');
    expect(moneyText(Money.of('0.2166'))).toBe('$0.2166');
    expect(moneyText(Money.of('12.5'))).toBe('$12.50');
  });
});
