// Unit tests for the Money value type (decision 011): parsing, exact arithmetic, half-up rounding, wire form.
import { describe, expect, it } from 'bun:test';
import { Money } from './money';

describe('Money.of', () => {
  it('parses decimal strings with 0 to 4 fraction digits', () => {
    expect(Money.of('12').toWire()).toBe('12.0000');
    expect(Money.of('12.5').toWire()).toBe('12.5000');
    expect(Money.of('12.4900').toWire()).toBe('12.4900');
    expect(Money.of('-0.0001').toWire()).toBe('-0.0001');
    expect(Money.of('0').toWire()).toBe('0.0000');
  });

  it('accepts safe integers and bigints', () => {
    expect(Money.of(5).toWire()).toBe('5.0000');
    expect(Money.of(-7).toWire()).toBe('-7.0000');
    expect(Money.of(123456789n).toWire()).toBe('123456789.0000');
  });

  it('returns a Money unchanged', () => {
    const value = Money.of('1.5');
    expect(Money.of(value)).toBe(value);
  });

  it('rejects floats, NaN and Infinity', () => {
    for (const bad of [0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => Money.of(bad)).toThrow(TypeError);
    }
  });

  it('rejects malformed strings and more than 4 fraction digits', () => {
    for (const bad of ['', ' 1', '1 ', '+1', '.5', '1.', '1e3', '0x10', 'NaN', 'Infinity', '1,5', '1.23456', '--1']) {
      expect(() => Money.of(bad)).toThrow(TypeError);
    }
  });

  it('rejects other types', () => {
    expect(() => Money.of(null as never)).toThrow(TypeError);
    expect(() => Money.of({} as never)).toThrow(TypeError);
  });

  it('rejects values that do not fit numeric(18,4)', () => {
    expect(Money.of('99999999999999.9999').toWire()).toBe('99999999999999.9999');
    expect(() => Money.of('100000000000000')).toThrow(RangeError);
    expect(() => Money.of('99999999999999.9999').add(Money.of('0.0001'))).toThrow(RangeError);
  });
});

describe('Money.fromWire', () => {
  it('accepts exactly 4 fraction digits', () => {
    expect(Money.fromWire('12.4900').toWire()).toBe('12.4900');
    expect(Money.fromWire('-3.0000').toWire()).toBe('-3.0000');
  });

  it('rejects every other shape', () => {
    for (const bad of ['12', '12.49', '12.49000', '1e2', '', ' 12.4900', '12,4900']) {
      expect(() => Money.fromWire(bad)).toThrow(TypeError);
    }
    expect(() => Money.fromWire(12.49 as never)).toThrow(TypeError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly where floats would drift', () => {
    expect(Money.of('0.1').add(Money.of('0.2')).toWire()).toBe('0.3000');
    expect(Money.of('0.3').sub(Money.of('0.1')).toWire()).toBe('0.2000');
    expect(Money.of('10').sub(Money.of('12.5')).toWire()).toBe('-2.5000');
  });

  it('sums a list', () => {
    expect(Money.sum([Money.of('0.1'), Money.of('0.2'), Money.of('0.3')]).toWire()).toBe('0.6000');
    expect(Money.sum([]).toWire()).toBe('0.0000');
  });

  it('multiplies by rates and quantities', () => {
    expect(Money.of('10.00').mul('1.19').toWire()).toBe('11.9000');
    expect(Money.of('4.25').mul(3).toWire()).toBe('12.7500');
    expect(Money.of('100').mul('3.67250000').toWire()).toBe('367.2500');
    expect(Money.of('2').mul(0).toWire()).toBe('0.0000');
  });

  it('rounds half away from zero at 4 decimals', () => {
    expect(Money.of('0.0001').mul('0.5').toWire()).toBe('0.0001');
    expect(Money.of('0.0001').mul('0.49').toWire()).toBe('0.0000');
    expect(Money.of('-0.0001').mul('0.5').toWire()).toBe('-0.0001');
    expect(Money.of('1.2345').mul('0.5').toWire()).toBe('0.6173');
    expect(Money.of('1.2347').mul('0.5').toWire()).toBe('0.6174');
  });

  it('takes percentages', () => {
    expect(Money.of('100.00').pct('19').toWire()).toBe('19.0000');
    expect(Money.of('49.99').pct('2.9000').toWire()).toBe('1.4497');
    expect(Money.of('0.0050').pct('2.5').toWire()).toBe('0.0001');
    expect(Money.of('-100').pct('10').toWire()).toBe('-10.0000');
  });

  it('refuses float factors', () => {
    expect(() => Money.of('1').mul(1.19)).toThrow(TypeError);
    expect(() => Money.of('1').pct(Number.NaN)).toThrow(TypeError);
    expect(() => Money.of('1').mul('1e2')).toThrow(TypeError);
    expect(() => Money.of('1').mul('abc')).toThrow(TypeError);
  });

  it('is immutable', () => {
    const base = Money.of('5');
    base.add(Money.of('1'));
    base.neg();
    expect(base.toWire()).toBe('5.0000');
  });
});

describe('sign and comparison', () => {
  it('negates and takes the absolute value', () => {
    expect(Money.of('5').neg().toWire()).toBe('-5.0000');
    expect(Money.of('-5').neg().toWire()).toBe('5.0000');
    expect(Money.of('-5').abs().toWire()).toBe('5.0000');
  });

  it('never prints negative zero', () => {
    expect(Money.zero().neg().toWire()).toBe('0.0000');
    expect(Money.of('-0.0000').toWire()).toBe('0.0000');
    expect(Money.of('0.0001').sub(Money.of('0.0001')).toWire()).toBe('0.0000');
    expect(Money.of('-0.0001').mul('0.4').toWire()).toBe('0.0000');
  });

  it('compares', () => {
    expect(Money.of('1').cmp(Money.of('2'))).toBe(-1);
    expect(Money.of('2').cmp(Money.of('2.0000'))).toBe(0);
    expect(Money.of('3').cmp(Money.of('2'))).toBe(1);
    expect(Money.of('2').eq(Money.of('2.0'))).toBe(true);
  });

  it('classifies zero, positive and negative', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.zero().isPositive()).toBe(false);
    expect(Money.zero().isNegative()).toBe(false);
    expect(Money.of('0.0001').isPositive()).toBe(true);
    expect(Money.of('-0.0001').isNegative()).toBe(true);
    expect(Money.of('0.0001').isZero()).toBe(false);
  });
});

describe('serialisation', () => {
  it('serialises to the 4-decimal wire string in JSON', () => {
    expect(JSON.stringify({ balance: Money.of('7') })).toBe('{"balance":"7.0000"}');
    expect(String(Money.of('1.5'))).toBe('1.5000');
  });
});
