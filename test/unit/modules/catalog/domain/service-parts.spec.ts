// Unit tests of the replace-all list checks: the problems and the plan of a custom field list, and repeated option values (the
// pattern check lives in field-pattern.spec.ts).
import { describe, expect, it } from 'bun:test';
import {
  type FieldDraft,
  duplicateOptionValues,
  fieldListProblems,
  plannedFieldRows,
} from '@src/modules/catalog/domain/service-parts';

describe('fieldListProblems', () => {
  const saved = new Set(['imei', 'account']);

  it('finds nothing in a list of new fields and saved fields with distinct Names', () => {
    expect(
      fieldListProblems(
        [{ key: 'imei', name: 'IMEI' }, { key: 'account', name: 'Account' }, { name: 'Note' }, { name: 'Region' }],
        saved,
      ),
    ).toEqual([]);
  });

  it('refuses a key that no saved field has', () => {
    expect(
      fieldListProblems(
        [
          { key: 'imei', name: 'IMEI' },
          { key: 'gone', name: 'Gone' },
        ],
        saved,
      ),
    ).toEqual([{ field: 'fields.1.key', message: 'This field no longer exists. Reload the page.' }]);
  });

  it('names the later occurrence of a repeated key', () => {
    expect(
      fieldListProblems(
        [
          { key: 'imei', name: 'IMEI' },
          { key: 'account', name: 'Account' },
          { key: 'imei', name: 'IMEI two' },
        ],
        saved,
      ),
    ).toEqual([{ field: 'fields.2.key', message: 'The key imei is used twice.' }]);
  });

  it('names the later occurrence of a Name repeated without regard to letter case and spaces', () => {
    expect(
      fieldListProblems([{ name: 'Email' }, { name: 'Phone' }, { name: ' email ' }, { name: 'EMAIL' }], saved),
    ).toEqual([
      { field: 'fields.2.name', message: 'The name email is used by an earlier field.' },
      { field: 'fields.3.name', message: 'The name EMAIL is used by an earlier field.' },
    ]);
  });

  it('refuses an empty Name', () => {
    expect(fieldListProblems([{ name: '   ' }], saved)).toEqual([{ field: 'fields.0.name', message: 'Enter a name.' }]);
  });

  it('names the later of two main inputs', () => {
    expect(
      fieldListProblems(
        [
          { name: 'A', isMainInput: true },
          { name: 'B', isMainInput: false },
          { name: 'C', isMainInput: true },
        ],
        saved,
      ),
    ).toEqual([{ field: 'fields.2.isMainInput', message: 'Only one field can be the main input.' }]);
  });

  it('counts a saved main input that the row leaves unsaid, and not one that the row turns off', () => {
    const main = new Set(['imei']);
    expect(
      fieldListProblems(
        [
          { key: 'imei', name: 'IMEI' },
          { name: 'Serial', isMainInput: true },
        ],
        saved,
        main,
      ),
    ).toEqual([{ field: 'fields.1.isMainInput', message: 'Only one field can be the main input.' }]);
    expect(
      fieldListProblems(
        [
          { key: 'imei', name: 'IMEI', isMainInput: false },
          { name: 'Serial', isMainInput: true },
        ],
        saved,
        main,
      ),
    ).toEqual([]);
  });
});

describe('plannedFieldRows', () => {
  const draft = (name: string, extra: Partial<FieldDraft> = {}): FieldDraft => ({
    name,
    fieldType: 'text',
    required: false,
    options: [],
    regex: '',
    ...extra,
  });
  const saved = [
    { key: 'imei', label: 'Device IMEI', isMainInput: true },
    { key: 'account', label: 'Account', isMainInput: false },
  ];

  it('makes the key of a new field from its Name and stores the Name in supplierKey', () => {
    expect(plannedFieldRows([draft(' Account User ')], [])).toEqual([
      {
        key: 'account_user',
        supplierKey: 'Account User',
        label: 'Account User',
        fieldType: 'text',
        required: false,
        options: [],
        regex: '',
        isMainInput: false,
      },
    ]);
  });

  it('numbers a key that clashes with a saved key or with a key planned earlier in the same list', () => {
    const planned = plannedFieldRows(
      [draft('User-Name'), draft('User Name'), draft('Account')],
      [{ key: 'user_name', label: 'User name', isMainInput: false }],
    );
    expect(planned.map((row) => row.key)).toEqual(['user_name_2', 'user_name_3', 'account']);
  });

  it('does not give a new field the key of a field that the same save deletes', () => {
    const planned = plannedFieldRows([draft('Account')], saved);
    expect(planned.map((row) => row.key)).toEqual(['account_2']);
  });

  it('gives a Name with nothing usable the key field', () => {
    expect(plannedFieldRows([draft('###'), draft('***')], []).map((row) => row.key)).toEqual(['field', 'field_2']);
  });

  it('keeps the key of a saved field when its Name changes', () => {
    const [row] = plannedFieldRows([draft('IMEI number', { key: 'imei' })], saved);
    expect(row).toMatchObject({ key: 'imei', supplierKey: 'IMEI number' });
  });

  it('keeps the saved label when the row leaves it out, stores the Name for an empty label and the typed label otherwise', () => {
    const rows = plannedFieldRows(
      [
        draft('IMEI', { key: 'imei' }),
        draft('Account', { key: 'account', label: '' }),
        draft('Note', { label: 'Your note' }),
        draft('Region'),
      ],
      saved,
    );
    expect(rows.map((row) => row.label)).toEqual(['Device IMEI', 'Account', 'Your note', 'Region']);
  });

  it('keeps the saved main-input flag when the row leaves it out and lets a given value win', () => {
    const rows = plannedFieldRows(
      [
        draft('IMEI', { key: 'imei' }),
        draft('Account', { key: 'account', isMainInput: true }),
        draft('Serial'),
        draft('Other', { isMainInput: true }),
      ],
      saved,
    );
    expect(rows.map((row) => row.isMainInput)).toEqual([true, true, false, true]);
    expect(plannedFieldRows([draft('IMEI', { key: 'imei', isMainInput: false })], saved)[0]?.isMainInput).toBe(false);
  });

  it('flags the first field named IMEI in any letter case on an IMEI service when the list leaves none flagged', () => {
    const flags = (rows: FieldDraft[], imeiService: boolean) =>
      plannedFieldRows(rows, saved, imeiService).map((row) => row.isMainInput);
    expect(flags([draft('Model'), draft(' imei '), draft('IMEI 2')], true)).toEqual([false, true, false]);
    // Also when the row itself turned the flag off: on an IMEI service that field is the IMEI.
    expect(flags([draft('IMEI', { key: 'imei', isMainInput: false })], true)).toEqual([true]);
    // Another flagged field keeps the flag; a service of another type flags nothing by Name; no field named IMEI, no flag.
    expect(flags([draft('Serial', { isMainInput: true }), draft('IMEI')], true)).toEqual([true, false]);
    expect(flags([draft('IMEI'), draft('Model')], false)).toEqual([false, false]);
    expect(flags([draft('IMEI number'), draft('Model')], true)).toEqual([false, false]);
  });
});

describe('duplicateOptionValues', () => {
  it('names the later occurrence within one list and allows the same value in another list', () => {
    const problems = duplicateOptionValues([
      { list: 'model', value: 'iphone15' },
      { list: 'network', value: 'iphone15' },
      { list: 'model', value: 'iphone15' },
    ]);
    expect(problems).toEqual([{ field: 'options.2.value', message: 'Duplicate in the model list' }]);
  });
});
