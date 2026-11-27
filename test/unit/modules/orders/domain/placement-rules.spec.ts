// Unit tests of the placement rules: IMEI format and Luhn, quantity, custom field values and the order total.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { SERVICE_FIELD_TYPES } from '@src/modules/catalog/db/schema';
import {
  FIELD_TYPE_RULES,
  INVALID_IMEI_MESSAGE,
  MAX_FIELD_IMEIS,
  MAX_INPUT_LENGTH,
  MAX_RAW_INPUT_LENGTH,
  type PlacementField,
  type PlacementFieldType,
  fieldImeisOf,
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

/** A valid IMEI made of a 14-digit body and its Luhn check digit. */
function withCheckDigit(body: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    if (isValidImei(`${body}${digit}`)) return `${body}${digit}`;
  }
  throw new Error(`No check digit for ${body}.`);
}

/** `count` distinct valid IMEIs. */
const distinctImeis = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => withCheckDigit(`35290511${String(index).padStart(6, '0')}`));

/** One row of a type's table: the value as typed, its stored form, and the code of its problem (`undefined`: valid). */
type Sample = readonly [typed: string, stored: string, code: string | undefined];

/** The samples of each check type of decision 076 (and `imei`, unchanged): valid and invalid values and their stored forms. */
const SAMPLES: Readonly<Partial<Record<PlacementFieldType, readonly Sample[]>>> = {
  imei: [
    [' 3529 0511-2490 861 ', '352905112490861', undefined],
    ['352905112490860', '352905112490860', 'invalid_imei'],
  ],
  imei_bulk: [
    ['352905112490861', '352905112490861', undefined],
    [
      ' 3529 0511-2490 861 , 354607111076240;490154203237518\r\n867412052327342\n',
      '352905112490861\n354607111076240\n490154203237518\n867412052327342',
      undefined,
    ],
    ['352905112490861\n\n\n;;354607111076240', '352905112490861\n354607111076240', undefined],
    ['352905112490861\n352905112490860', '352905112490861\n352905112490860', 'invalid_imei'],
    ['352905112490861,352905112490861', '352905112490861\n352905112490861', 'duplicate_imei'],
    [',;,', '', 'invalid_imei'],
  ],
  imeisv: [
    [' 3529-0511 2490 8612 ', '3529051124908612', undefined],
    ['352905112490861', '352905112490861', 'invalid_imeisv'],
    ['35290511249086123', '35290511249086123', 'invalid_imeisv'],
    ['352905112490861A', '352905112490861A', 'invalid_imeisv'],
  ],
  serial: [
    [' f2lx k0ab cd12 ', 'F2LXK0ABCD12', undefined],
    ['abcde', 'ABCDE', undefined],
    ['A'.repeat(30), 'A'.repeat(30), undefined],
    ['ABCD', 'ABCD', 'invalid_serial'],
    ['A'.repeat(31), 'A'.repeat(31), 'invalid_serial'],
    ['F2L-XK0AB', 'F2L-XK0AB', 'invalid_serial'],
  ],
  iccid: [
    ['8944 1234-5678 9012 34', '894412345678901234', undefined],
    ['89441234567890123456', '89441234567890123456', undefined],
    ['8944123456789012345678', '8944123456789012345678', undefined],
    ['89441234567890123', '89441234567890123', 'invalid_iccid'],
    ['89441234567890123456789', '89441234567890123456789', 'invalid_iccid'],
    ['99441234567890123456', '99441234567890123456', 'invalid_iccid'],
  ],
  eid: [
    ['8904 9032-0000 0000 0000 0000 0000 0001', '89049032000000000000000000000001', undefined],
    ['8904903200000000000000000000000', '8904903200000000000000000000000', 'invalid_eid'],
    ['8904903200000000000000000000000A', '8904903200000000000000000000000A', 'invalid_eid'],
  ],
  meid: [
    ['a0 0000-1234 5678', 'A0000012345678', undefined],
    ['a00000123456789', 'A00000123456789', undefined],
    ['270113177609606400', '270113177609606400', undefined],
    ['A000001234567', 'A000001234567', 'invalid_meid'],
    ['A000001234567890', 'A000001234567890', 'invalid_meid'],
    ['G0000012345678', 'G0000012345678', 'invalid_meid'],
  ],
  ecid: [
    [' 0x 1a2b 3c4d 5e6f ', '0x1A2B3C4D5E6F', undefined],
    ['0X1a2b3c4d', '0x1A2B3C4D', undefined],
    ['1a2b3c4d5e6f7a8b', '1A2B3C4D5E6F7A8B', undefined],
    ['12345678901234567890', '12345678901234567890', undefined],
    ['0x1a2b3c4', '0x1A2B3C4', 'invalid_ecid'],
    ['1A2B3C4D5E6F7A8B9', '1A2B3C4D5E6F7A8B9', 'invalid_ecid'],
    ['123456789012345678901', '123456789012345678901', 'invalid_ecid'],
    ['1a2b-3c4d', '1A2B-3C4D', 'invalid_ecid'],
  ],
  mac_address: [
    ['aabbccddeeff', 'AA:BB:CC:DD:EE:FF', undefined],
    [' aa:bb:cc:dd:ee:0f ', 'AA:BB:CC:DD:EE:0F', undefined],
    ['AA-BB-CC-DD-EE-FF', 'AA:BB:CC:DD:EE:FF', undefined],
    ['aabb.ccdd.eeff', 'AA:BB:CC:DD:EE:FF', undefined],
    ['AA:BB:CC:DD:EE', 'AA:BB:CC:DD:EE', 'invalid_mac_address'],
    ['AA:BB-CC:DD:EE:FF', 'AA:BB-CC:DD:EE:FF', 'invalid_mac_address'],
    ['GG:BB:CC:DD:EE:FF', 'GG:BB:CC:DD:EE:FF', 'invalid_mac_address'],
    ['AABB:CCDD:EEFF', 'AABB:CCDD:EEFF', 'invalid_mac_address'],
  ],
  mi_lock_code: [
    [' Ab12-cd34 ', 'Ab12-cd34', undefined],
    ['abc123', 'abc123', undefined],
    ['a'.repeat(64), 'a'.repeat(64), undefined],
    ['abc12', 'abc12', 'invalid_mi_lock_code'],
    ['a'.repeat(65), 'a'.repeat(65), 'invalid_mi_lock_code'],
    ['abc 123', 'abc 123', 'invalid_mi_lock_code'],
    ['abc_123', 'abc_123', 'invalid_mi_lock_code'],
  ],
  box_sn: [
    [' bx-12 34 ', 'BX-1234', undefined],
    ['abcd', 'ABCD', undefined],
    ['A'.repeat(32), 'A'.repeat(32), undefined],
    ['ABC', 'ABC', 'invalid_box_sn'],
    ['A'.repeat(33), 'A'.repeat(33), 'invalid_box_sn'],
    ['AB_12', 'AB_12', 'invalid_box_sn'],
  ],
};

/** The message of each fixed code of decision 076. */
const MESSAGES: Readonly<Record<string, string>> = {
  invalid_imeisv: 'This IMEISV is not valid: it must be 16 digits.',
  invalid_serial: 'This serial number is not valid: 5 to 30 letters and digits.',
  invalid_iccid: 'This ICCID is not valid: 18 to 22 digits, starting with 89.',
  invalid_eid: 'This EID is not valid: it must be 32 digits.',
  invalid_meid: 'This MEID is not valid: 14 hexadecimal characters (0-9, A-F), or 18 digits.',
  invalid_ecid: 'This ECID is not valid: 8 to 16 hexadecimal characters, or up to 20 digits.',
  invalid_mac_address: 'This MAC address is not valid: 12 hexadecimal characters, like AA:BB:CC:DD:EE:FF.',
  invalid_mi_lock_code: 'This Mi lock code is not valid: 6 to 64 letters, digits and dashes.',
  invalid_box_sn: 'This box serial number is not valid: 4 to 32 letters, digits and dashes.',
};

describe('the field type table (decision 076)', () => {
  const typed = (fieldType: PlacementFieldType, over: Partial<PlacementField> = {}): PlacementField => ({
    id: 1,
    key: 'value',
    name: 'Value',
    label: 'Value',
    fieldType,
    options: [],
    required: true,
    regex: '',
    isMainInput: false,
    sort: 0,
    ...over,
  });

  it('has one row for every value of SERVICE_FIELD_TYPES, in its order, and nothing else', () => {
    expect(Object.keys(FIELD_TYPE_RULES)).toEqual([...SERVICE_FIELD_TYPES]);
    expect(SERVICE_FIELD_TYPES).toEqual([
      'text',
      'number',
      'select',
      'textarea',
      'imei',
      'imei_bulk',
      'imeisv',
      'serial',
      'iccid',
      'eid',
      'meid',
      'ecid',
      'mac_address',
      'mi_lock_code',
      'box_sn',
    ]);
  });

  for (const [fieldType, samples] of Object.entries(SAMPLES) as Array<[PlacementFieldType, readonly Sample[]]>) {
    describe(fieldType, () => {
      it.each(samples.map((sample) => [JSON.stringify(sample[0]), ...sample] as const))(
        'reads %s into its stored form and judges it',
        (_name, value, stored, code) => {
          expect(fieldValueOf({ fieldType }, value)).toBe(stored);
          const problems = inputProblems([typed(fieldType)], { value });
          expect(problems.map((problem) => problem.code)).toEqual(code === undefined ? [] : [code]);
          expect(problems.every((problem) => problem.field === 'inputs.value')).toBe(true);
          if (code !== undefined && MESSAGES[code] !== undefined) expect(problems[0]?.message).toBe(MESSAGES[code]);
        },
      );
    });
  }

  it('keeps Required, the 500-character cap and the pattern, which judges the stored form', () => {
    expect(inputProblems([typed('serial')], { value: '  ' }).map((p) => p.code)).toEqual(['required']);
    expect(inputProblems([typed('serial', { required: false })], {})).toEqual([]);
    expect(inputProblems([typed('mi_lock_code')], { value: 'a'.repeat(501) }).map((p) => p.code)).toEqual(['too_long']);
    const apple = typed('serial', { regex: '^F2[A-Z0-9]+$' });
    expect(inputProblems([apple], { value: ' f2lx k0ab cd12 ' })).toEqual([]);
    expect(inputProblems([apple], { value: 'C02XK0ABCD12' }).map((p) => p.code)).toEqual(['invalid_format']);
    const mac = typed('mac_address', { regex: '^AA:BB:' });
    expect(inputProblems([mac], { value: 'aabb.ccdd.eeff' })).toEqual([]);
    // A value its type refuses is reported once, for its type: the pattern is not run on it.
    expect(inputProblems([apple], { value: 'abc' }).map((p) => p.code)).toEqual(['invalid_serial']);
  });

  it('stores the read form of every checked type and leaves text, number, select and textarea as sent', () => {
    const fields = (['text', 'textarea', 'imei_bulk', 'serial', 'mac_address', 'mi_lock_code', 'ecid'] as const).map(
      (fieldType) => typed(fieldType, { key: fieldType }),
    );
    expect(
      normalizedInputs(fields, {
        text: ' a-b ',
        textarea: ' x\ny ',
        imei_bulk: '352905112490861, 354607111076240',
        serial: ' f2lx ',
        mac_address: 'aabbccddeeff',
        mi_lock_code: ' Ab-12cd ',
        ecid: '0X1a2b3c4d',
        gone: ' kept ',
      }),
    ).toEqual({
      text: ' a-b ',
      textarea: ' x\ny ',
      imei_bulk: '352905112490861\n354607111076240',
      serial: 'F2LX',
      mac_address: 'AA:BB:CC:DD:EE:FF',
      mi_lock_code: 'Ab-12cd',
      ecid: '0x1A2B3C4D',
      gone: ' kept ',
    });
  });
});

describe('a field of type imei_bulk (decision 076): one order, one list', () => {
  const bulk: PlacementField = {
    id: 1,
    key: 'imeis',
    name: 'IMEIs',
    label: 'IMEIs',
    fieldType: 'imei_bulk',
    options: [],
    required: true,
    regex: '',
    isMainInput: true,
    sort: 0,
  };
  const problemsOf = (value: string) => inputProblems([bulk], { imeis: value });

  it(`takes 1 to ${MAX_FIELD_IMEIS} IMEIs (30 joined are under the 500-character cap) and refuses one more`, () => {
    const thirty = distinctImeis(MAX_FIELD_IMEIS);
    expect(fieldValueOf(bulk, thirty.join('\n')).length).toBe(479);
    expect(problemsOf(thirty.join('\n'))).toEqual([]);
    expect(problemsOf([...thirty, withCheckDigit('35460711107624')].join(','))).toEqual([
      { field: 'inputs.imeis', code: 'too_many_imeis', message: 'Enter at most 30 IMEIs.' },
    ]);
  });

  it('reports only the first problem, counting the kept lines from 1', () => {
    expect(problemsOf('352905112490861\n\n,352905112490860\n352905112490861')).toEqual([
      {
        field: 'inputs.imeis',
        code: 'invalid_imei',
        message: 'Line 2 is not a valid IMEI: each line must be 15 digits with a correct check digit.',
      },
    ]);
    expect(problemsOf('354607111076240;352905112490861;354607111076240;35290')).toEqual([
      { field: 'inputs.imeis', code: 'duplicate_imei', message: 'Line 3 repeats an IMEI of this list.' },
    ]);
    expect(problemsOf('abc\n352905112490861\n352905112490861').map((p) => p.message)).toEqual([
      'Line 1 is not a valid IMEI: each line must be 15 digits with a correct check digit.',
    ]);
  });

  it('reports on the path the caller names (a list sent as imei)', () => {
    expect(inputProblems([bulk], { imeis: '1' }, { imeis: 'imei' })[0]?.field).toBe('imei');
  });

  it('counts a list before it measures it: 40 IMEIs are too_many_imeis, not too_long', () => {
    const forty = distinctImeis(40).join('\n');
    expect(forty.length).toBeGreaterThan(MAX_INPUT_LENGTH);
    expect(problemsOf(forty)).toEqual([
      { field: 'inputs.imeis', code: 'too_many_imeis', message: 'Enter at most 30 IMEIs.' },
    ]);
    // Counted in the stored form: the empty items of what was typed are not items.
    expect(problemsOf(`${distinctImeis(32).join(',\r\n')},,`).map((p) => p.code)).toEqual(['too_many_imeis']);
    expect(FIELD_TYPE_RULES.imei_bulk.countProblem?.(distinctImeis(30).join('\n'))).toBeUndefined();
  });

  it('still holds the stored form of a list of 30 items or fewer to the 500-character cap', () => {
    const long = ['1'.repeat(200), '2'.repeat(200), '3'.repeat(200)].join('\n');
    expect(problemsOf(long)).toEqual([{ field: 'inputs.imeis', code: 'too_long', message: 'IMEIs is too long.' }]);
  });

  it('takes 30 valid IMEIs however they are typed: CRLF, ", " or spaces and dashes inside each one are longer than 500 as typed, 479 stored', () => {
    const thirty = distinctImeis(MAX_FIELD_IMEIS);
    const dashed = thirty.map(
      (imei) => `${imei.slice(0, 2)}-${imei.slice(2, 8)} ${imei.slice(8, 14)}-${imei.slice(14)}`,
    );
    for (const typedList of [thirty.join('\r\n'), thirty.join(', '), dashed.join('\n'), dashed.join(', ')]) {
      expect(typedList.length).toBeGreaterThan(MAX_INPUT_LENGTH);
      expect(typedList.length).toBeLessThanOrEqual(MAX_RAW_INPUT_LENGTH);
      expect(problemsOf(typedList)).toEqual([]);
      expect(fieldValueOf(bulk, typedList)).toBe(thirty.join('\n'));
      expect(fieldValueOf(bulk, typedList).length).toBe(479);
    }
  });
});

describe('the cap of the stored form (decision 076)', () => {
  const plain = (fieldType: PlacementFieldType): PlacementField => ({
    id: 1,
    key: 'value',
    name: 'Value',
    label: 'Value',
    fieldType,
    options: [],
    required: true,
    regex: '',
    isMainInput: false,
    sort: 0,
  });

  it('comes first for every type but imei_bulk, the only one with a count', () => {
    expect(Object.entries(FIELD_TYPE_RULES).flatMap(([type, rule]) => (rule.countProblem ? [type] : []))).toEqual([
      'imei_bulk',
    ]);
    expect(inputProblems([plain('text')], { value: 'x'.repeat(600) }).map((p) => p.code)).toEqual(['too_long']);
    expect(inputProblems([plain('textarea')], { value: 'x'.repeat(MAX_INPUT_LENGTH + 1) }).map((p) => p.code)).toEqual([
      'too_long',
    ]);
    // Measured trimmed, as stored: white space typed around a value is not part of it.
    expect(inputProblems([plain('text')], { value: ` ${'x'.repeat(MAX_INPUT_LENGTH)}\n` })).toEqual([]);
    expect(inputProblems([plain('serial')], { value: 'A'.repeat(600) }).map((p) => p.code)).toEqual(['too_long']);
  });
});

describe('fieldImeisOf', () => {
  it('reads one IMEI of an imei field, each line of an imei_bulk field and none of another type', () => {
    expect(fieldImeisOf({ fieldType: 'imei' }, '3529 0511 2490 861')).toEqual(['352905112490861']);
    expect(fieldImeisOf({ fieldType: 'imei_bulk' }, '352905112490861; 3546-0711-1076-240')).toEqual([
      '352905112490861',
      '354607111076240',
    ]);
    expect(fieldImeisOf({ fieldType: 'imei_bulk' }, '')).toEqual([]);
    for (const fieldType of ['text', 'imeisv', 'serial', 'meid'] as const) {
      expect(fieldImeisOf({ fieldType }, '352905112490861')).toEqual([]);
    }
  });
});

describe('totalOf', () => {
  it('multiplies the unit price by the quantity exactly', () => {
    expect(totalOf(Money.of('17.28'), 3).toWire()).toBe('51.8400');
    expect(totalOf(Money.of('0.0900'), 100).toWire()).toBe('9.0000');
  });
});

describe('normalizedInputs: the stored cap', () => {
  it('stores a padded text value trimmed once it is longer than the stored cap, and a shorter one as sent', () => {
    const fields = [{ key: 'note', fieldType: 'text' as const }];
    const long = `${' '.repeat(700)}${'a'.repeat(500)}${' '.repeat(700)}`;
    expect(normalizedInputs(fields, { note: long }).note).toBe('a'.repeat(500));
    expect(normalizedInputs(fields, { note: ' kept as sent ' }).note).toBe(' kept as sent ');
  });
});
