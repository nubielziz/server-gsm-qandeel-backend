// Unit tests of how a supplier's amount text is read and judged against its range (decision 051).
import { describe, expect, it } from 'bun:test';
import {
  SUPPLIER_BALANCE_RANGE,
  SUPPLIER_PRICE_RANGE,
  amountText,
  supplierAmount,
} from '@src/modules/suppliers/domain/amount-text';

describe('amountText', () => {
  it('reads numbers exactly and refuses amounts written with an exponent', () => {
    expect(amountText(1e21)).toBe('1000000000000000000000.0000');
    expect(amountText(1e-7)).toBe('0.0000');
    expect(amountText(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(amountText(Number.NaN)).toBeUndefined();
    expect(amountText('1e21')).toBeUndefined();
    expect(amountText('2.5E+3')).toBeUndefined();
    expect(amountText('1 e 5')).toBeUndefined();
    expect(amountText('2.5 E - 3')).toBeUndefined();
    expect(amountText('5 each')).toBe('5.0000');
    expect(amountText('$1,200.50')).toBe('1200.5000');
    expect(amountText('5 Credits each')).toBe('5.0000');
    expect(amountText(3)).toBe('3.0000');
    expect(amountText({})).toBeUndefined();
  });

  it('judges a 20,000-character text with white space around an e in time proportional to its length', () => {
    // The shape that made the earlier exponent test take about 46 ms a string: a digit, white space, e, white space, no digit.
    const credit = `1${' '.repeat(9998)}e${' '.repeat(9999)}x`;
    expect(credit).toHaveLength(20_000);
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) expect(amountText(credit)).toBe('1.0000');
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('supplierAmount', () => {
  it('judges a supplier amount against its range', () => {
    expect(supplierAmount('-5', SUPPLIER_PRICE_RANGE)).toEqual({ kind: 'out_of_range' });
    expect(supplierAmount('0', SUPPLIER_PRICE_RANGE)).toEqual({ kind: 'ok', text: '0.0000' });
    expect(supplierAmount('-0', SUPPLIER_PRICE_RANGE)).toEqual({ kind: 'ok', text: '0.0000' });
    expect(supplierAmount('1000000000', SUPPLIER_PRICE_RANGE)).toEqual({ kind: 'ok', text: '1000000000.0000' });
    expect(supplierAmount('1000000000.0001', SUPPLIER_PRICE_RANGE)).toEqual({ kind: 'out_of_range' });
    expect(supplierAmount('abc', SUPPLIER_PRICE_RANGE)).toEqual({ kind: 'unreadable' });
    expect(supplierAmount('-1000000000', SUPPLIER_BALANCE_RANGE)).toEqual({ kind: 'ok', text: '-1000000000.0000' });
    expect(supplierAmount('-1000000000.0001', SUPPLIER_BALANCE_RANGE)).toEqual({ kind: 'out_of_range' });
    expect(supplierAmount(12.5, SUPPLIER_BALANCE_RANGE)).toEqual({ kind: 'ok', text: '12.5000' });
  });
});
