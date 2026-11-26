// Unit tests of the placement rules: IMEI format and Luhn, quantity, custom field values and the order total.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  INVALID_IMEI_MESSAGE,
  type PlacementField,
  fieldValueOf,
  inputProblems,
  isValidImei,
  normalizeImei,
  normalizedInputs,
  quantityProblem,
  totalOf,
} from '@src/modules/orders/domain/placement-rules';

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

  it('refuses Arabic-Indic digits on purpose: an IMEI is typed with Latin digits only', () => {
    expect(isValidImei('١٢٣٤٥٦٧٨٩٠١٢٣٤٥')).toBe(false);
    expect(isValidImei(normalizeImei('٣٥٢٩٠٥١١٢٤٩٠٨٦١'))).toBe(false);
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
    name: 'Username',
    isMainInput: false,
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

  it('refuses a key the service does not define, and does not run a pattern outside the supported form', () => {
    expect(inputProblems([field({})], { username: 'a', extra: 'b' }).map((p) => [p.field, p.code])).toEqual([
      ['inputs.extra', 'unknown_field'],
    ]);
    expect(inputProblems([field({ regex: '(' })], { username: 'a' })).toEqual([]);
  });

  it('reports the problems of a field on the path the caller names for it, and the others on inputs.<key>', () => {
    const box = field({ key: 'serial', label: 'Serial', regex: '^35[0-9]{13}$' });
    const other = field({ key: 'note', label: 'Note' });
    const problems = inputProblems([box, other], { serial: '86' }, { serial: 'imeis.2' });
    expect(problems.map((p) => [p.field, p.code])).toEqual([
      ['imeis.2', 'invalid_format'],
      ['inputs.note', 'required'],
    ]);
  });

  it('answers at once for a nested repeat and a long hard value: the field has no pattern', () => {
    const started = performance.now();
    const problems = inputProblems([field({ regex: '^(a+)+$' })], { username: `${'a'.repeat(30)}!` });
    expect(problems).toEqual([]);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('a field of type imei (decision 073)', () => {
  const imeiField = (over: Partial<PlacementField> = {}): PlacementField => ({
    id: 1,
    key: 'device',
    name: 'Device',
    label: 'Device IMEI',
    fieldType: 'imei',
    options: [],
    required: true,
    regex: '',
    isMainInput: false,
    sort: 0,
    ...over,
  });

  it('accepts one IMEI typed with spaces and dashes, on any field (main input or not)', () => {
    expect(inputProblems([imeiField()], { device: ' 3529 0511-2490 861 ' })).toEqual([]);
    expect(inputProblems([imeiField({ isMainInput: true })], { device: '352905112490861' })).toEqual([]);
  });

  it('refuses a bad check digit, a short value and letters with invalid_imei on its path', () => {
    for (const value of ['352905112490860', '35290511249086', 'ABCDEF012345678']) {
      expect(inputProblems([imeiField()], { device: value })).toEqual([
        { field: 'inputs.device', code: 'invalid_imei', message: INVALID_IMEI_MESSAGE },
      ]);
    }
    expect(inputProblems([imeiField()], { device: '352905112490860' }, { device: 'imeis.2' })[0]?.field).toBe(
      'imeis.2',
    );
  });

  it('keeps Required and the pattern: an optional one may be empty, a pattern is matched on the digits', () => {
    expect(inputProblems([imeiField()], {})).toEqual([
      { field: 'inputs.device', code: 'required', message: 'Device IMEI is required.' },
    ]);
    expect(inputProblems([imeiField({ required: false })], { device: '  ' })).toEqual([]);
    const apple = imeiField({ regex: '^35\\d{13}$' });
    expect(inputProblems([apple], { device: '35 2905 1124 90861' })).toEqual([]);
    expect(inputProblems([apple], { device: '490154203237518' })).toEqual([
      { field: 'inputs.device', code: 'invalid_format', message: 'Device IMEI is not in the expected format.' },
    ]);
  });

  it('stores the digits of an imei field and leaves every other value as sent', () => {
    expect(fieldValueOf({ fieldType: 'imei' }, ' 35-2905 112490861 ')).toBe('352905112490861');
    expect(fieldValueOf({ fieldType: 'text' }, ' 35-2905 ')).toBe('35-2905');
    expect(
      normalizedInputs([imeiField(), { ...imeiField(), key: 'note', fieldType: 'text' }], {
        device: '3529 0511 2490 861',
        note: ' 35-29 ',
        gone: 'x',
      }),
    ).toEqual({ device: '352905112490861', note: ' 35-29 ', gone: 'x' });
  });
});

describe('totalOf', () => {
  it('multiplies the unit price by the quantity exactly', () => {
    expect(totalOf(Money.of('17.28'), 3).toWire()).toBe('51.8400');
    expect(totalOf(Money.of('0.0900'), 100).toWire()).toBe('9.0000');
  });
});
