// Unit tests of the supplier's quantity rule reader (feature 25).
import { describe, expect, it } from 'bun:test';
import { quantityRuleProblems } from '@src/modules/catalog';
import { supplierQuantityRule } from '@src/modules/suppliers/domain/supplier-quantity';

const ONE = { minQty: 1, maxQty: 1, qtyOptions: [] };

describe('supplierQuantityRule: QNT', () => {
  it('is one per order when QNT is 0, no or false, whatever the other fields say', () => {
    for (const qnt of [0, '0', 'no', false, '1.5', 'yes']) {
      expect(supplierQuantityRule({ QNT: qnt, MINQNT: '2', MAXQNT: '9', QNTOPTIONS: '5,10' })).toEqual(ONE);
    }
  });
  it('takes a quantity when QNT is 1, "1", " 1 " or true', () => {
    for (const qnt of [1, '1', ' 1 ', true]) {
      expect(supplierQuantityRule({ QNT: qnt, MINQNT: '2', MAXQNT: '9' })).toEqual({
        minQty: 2,
        maxQty: 9,
        qtyOptions: [],
      });
    }
  });
  it('decides from the other fields when QNT is absent or empty', () => {
    expect(supplierQuantityRule({})).toEqual(ONE);
    expect(supplierQuantityRule({ QNT: '', MINQNT: '1', MAXQNT: '1' })).toEqual(ONE);
    expect(supplierQuantityRule({ MINQNT: '1', MAXQNT: '10' })).toEqual({ minQty: 1, maxQty: 10, qtyOptions: [] });
    expect(supplierQuantityRule({ QNTOPTIONS: '5,10' })).toEqual({ minQty: 5, maxQty: 10, qtyOptions: [5, 10] });
  });
  it('is one per order when QNT is 1 and nothing else is stated', () => {
    expect(supplierQuantityRule({ QNT: '1' })).toEqual(ONE);
  });
});

describe('supplierQuantityRule: range', () => {
  it('reads MINQNT and MAXQNT as text or numbers', () => {
    expect(supplierQuantityRule({ QNT: '1', MINQNT: '5', MAXQNT: '50' })).toEqual({
      minQty: 5,
      maxQty: 50,
      qtyOptions: [],
    });
    expect(supplierQuantityRule({ QNT: 1, MINQNT: 5, MAXQNT: 50 })).toEqual({ minQty: 5, maxQty: 50, qtyOptions: [] });
  });
  it('lifts a MAXQNT under MINQNT to MINQNT', () => {
    expect(supplierQuantityRule({ QNT: '1', MINQNT: '10', MAXQNT: '3' })).toEqual({
      minQty: 10,
      maxQty: 10,
      qtyOptions: [],
    });
  });
  it('caps a MAXQNT above 100000', () => {
    expect(supplierQuantityRule({ QNT: '1', MINQNT: '1', MAXQNT: '999999' })).toEqual({
      minQty: 1,
      maxQty: 100_000,
      qtyOptions: [],
    });
  });
  it('falls back to 1 and to the smallest for unreadable values', () => {
    expect(supplierQuantityRule({ QNT: '1', MINQNT: 'abc', MAXQNT: '-4' })).toEqual(ONE);
    expect(supplierQuantityRule({ QNT: '1', MINQNT: '0', MAXQNT: '7' })).toEqual({
      minQty: 1,
      maxQty: 7,
      qtyOptions: [],
    });
    expect(supplierQuantityRule({ QNT: '1', MINQNT: '200000', MAXQNT: '8' })).toEqual({
      minQty: 1,
      maxQty: 8,
      qtyOptions: [],
    });
    expect(supplierQuantityRule({ QNT: '1', MINQNT: { a: 1 }, MAXQNT: null })).toEqual(ONE);
  });
});

describe('supplierQuantityRule: packs', () => {
  it('splits on commas, semicolons, bars and spaces, sorts and takes the bounds from the packs', () => {
    expect(supplierQuantityRule({ QNT: '1', QNTOPTIONS: ' 25, 5 ;10|50  100', MINQNT: '1', MAXQNT: '1' })).toEqual({
      minQty: 5,
      maxQty: 100,
      qtyOptions: [5, 10, 25, 50, 100],
    });
  });
  it('drops repeats, zeros, text, decimals and values above 100000', () => {
    expect(supplierQuantityRule({ QNT: '1', QNTOPTIONS: '5,5,0,x,2.5,-3,100001,10' })).toEqual({
      minQty: 5,
      maxQty: 10,
      qtyOptions: [5, 10],
    });
  });
  it('is a range when no pack is readable', () => {
    expect(supplierQuantityRule({ QNT: '1', QNTOPTIONS: 'a,b,0', MINQNT: '2', MAXQNT: '4' })).toEqual({
      minQty: 2,
      maxQty: 4,
      qtyOptions: [],
    });
  });
  it('keeps the 50 smallest packs', () => {
    const rule = supplierQuantityRule({ QNT: '1', QNTOPTIONS: Array.from({ length: 80 }, (_, i) => 80 - i).join(',') });
    expect(rule.qtyOptions).toHaveLength(50);
    expect(rule.qtyOptions[0]).toBe(1);
    expect(rule.maxQty).toBe(50);
  });
  it('reads a number in QNTOPTIONS as one pack', () => {
    expect(supplierQuantityRule({ QNT: '1', QNTOPTIONS: 5 })).toEqual({ minQty: 5, maxQty: 5, qtyOptions: [5] });
  });
});

describe('supplierQuantityRule: always a storable rule', () => {
  it('passes quantityRuleProblems for 200 random entries', () => {
    const pool: unknown[] = [
      undefined,
      null,
      '',
      ' ',
      '0',
      '1',
      '2',
      '7',
      '10',
      '99999',
      '100000',
      '100001',
      '-1',
      '1.5',
      'abc',
      0,
      1,
      3,
      250000,
      true,
      false,
      {},
      [],
      '5,10',
      '10;5',
      '3 3 3',
      ' 1, 2 ,x',
    ];
    const pick = () => pool[Math.floor(Math.random() * pool.length)];
    for (let i = 0; i < 200; i += 1) {
      const raw: Record<string, unknown> = {};
      for (const key of ['QNT', 'MINQNT', 'MAXQNT', 'QNTOPTIONS']) {
        const value = pick();
        if (value !== undefined) raw[key] = value;
      }
      const rule = supplierQuantityRule(raw);
      expect({ raw, problems: quantityRuleProblems(rule) }).toEqual({ raw, problems: [] });
    }
  });
});
