// Unit tests of the placement rules: IMEI format and Luhn, quantity, custom field values and the order total.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import {
  type PlacementField,
  inputProblems,
  isValidImei,
  normalizeImei,
  quantityProblem,
  totalOf,
} from './placement-rules';

describe('IMEI', () => {
  it('accepts 15 digits with a valid Luhn check digit and refuses everything else', () => {
    for (const imei of ['352905112490861', '354607111076240', '490154203237518', '867412052327342']) {
      expect(isValidImei(imei)).toBe(true);
    }
    for (const imei of [
      '352905112490860',
      '35290511249086',
      '3529051124908611',
      'abcdefghijklmno',
      '',
      '35290511249086x',
    ]) {
      expect(isValidImei(imei)).toBe(false);
    }
  });

  it('removes the spaces and dashes a merchant pastes', () => {
    expect(normalizeImei(' 3529 0511-2490 861 ')).toBe('352905112490861');
    expect(isValidImei(normalizeImei('35-290511-249086-1'))).toBe(true);
  });
});

describe('quantityProblem', () => {
  const range = { minQty: 1, maxQty: 5, qtyOptions: [] };
  it('accepts a whole quantity inside the range and names the range otherwise', () => {
    expect(quantityProblem(1, range)).toBeUndefined();
    expect(quantityProblem(5, range)).toBeUndefined();
    expect(quantityProblem(6, range)).toBe('Enter a quantity from 1 to 5.');
    expect(quantityProblem(0, range)).toBe('Enter a whole quantity of 1 or more.');
    expect(quantityProblem(1.5, range)).toBe('Enter a whole quantity of 1 or more.');
  });

  it('accepts only the packs a service sells when it lists them', () => {
    const packs = { minQty: 1, maxQty: 100, qtyOptions: [10, 20] };
    expect(quantityProblem(10, packs)).toBeUndefined();
    expect(quantityProblem(15, packs)).toBe('Choose one of the quantities this service sells: 10, 20.');
  });
});

describe('inputProblems', () => {
  const field = (overrides: Partial<PlacementField>): PlacementField => ({
    id: 1,
    key: 'username',
    label: 'Username',
    required: true,
    sort: 1,
    fieldType: 'text',
    options: [],
    regex: '',
    ...overrides,
  });

  it('requires a required field and accepts an optional one left empty', () => {
    expect(inputProblems([field({})], {}).map((p) => [p.field, p.code])).toEqual([['inputs.username', 'required']]);
    expect(inputProblems([field({})], { username: '   ' }).map((p) => p.code)).toEqual(['required']);
    expect(inputProblems([field({ required: false })], {})).toEqual([]);
  });

  it('checks a select against its options, a number, a pattern and the length', () => {
    const select = field({ key: 'network', label: 'Network', fieldType: 'select', options: ['AT&T', 'T-Mobile'] });
    expect(inputProblems([select], { network: 'AT&T' })).toEqual([]);
    expect(inputProblems([select], { network: 'Sprint' }).map((p) => p.code)).toEqual(['invalid_option']);
    const number = field({ key: 'count', label: 'Count', fieldType: 'number' });
    expect(inputProblems([number], { count: '12.5' })).toEqual([]);
    expect(inputProblems([number], { count: 'twelve' }).map((p) => p.code)).toEqual(['not_a_number']);
    const pattern = field({ regex: '^[A-Z]{2}\\d{4}$' });
    expect(inputProblems([pattern], { username: 'AB1234' })).toEqual([]);
    expect(inputProblems([pattern], { username: 'ab1234' }).map((p) => p.code)).toEqual(['invalid_format']);
    expect(inputProblems([field({})], { username: 'x'.repeat(501) }).map((p) => p.code)).toEqual(['too_long']);
  });

  it('refuses a key the service does not define, and treats a broken pattern as a mismatch instead of failing', () => {
    expect(inputProblems([field({})], { username: 'a', extra: 'b' }).map((p) => [p.field, p.code])).toEqual([
      ['inputs.extra', 'unknown_field'],
    ]);
    expect(inputProblems([field({ regex: '(' })], { username: 'a' }).map((p) => p.code)).toEqual(['invalid_format']);
  });
});

describe('totalOf', () => {
  it('multiplies the unit price by the quantity exactly', () => {
    expect(totalOf(Money.of('17.28'), 3).toWire()).toBe('51.8400');
    expect(totalOf(Money.of('0.0900'), 100).toWire()).toBe('9.0000');
  });
});
