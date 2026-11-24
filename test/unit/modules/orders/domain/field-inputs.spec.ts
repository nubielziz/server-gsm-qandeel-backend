// Unit tests of reading a Dhru call's custom field values by field Name (decision 065).
import { describe, expect, it } from 'bun:test';
import { inputsByFieldName } from '@src/modules/orders/domain/field-inputs';

const fields = [
  { key: 'account_id', name: 'Account ID', label: 'Your account' },
  { key: 'email', name: 'Email', label: 'Email address' },
  { key: 'imei_2', name: 'IMEI', label: 'Second IMEI' },
];

describe('inputsByFieldName', () => {
  it('matches a sent name to a field Name trimmed and without regard to letter case, and answers by key', () => {
    const read = inputsByFieldName(fields, { ' account id ': 'A1', EMAIL: 'a@mail.example' });
    expect(read.inputs).toEqual({ account_id: 'A1', email: 'a@mail.example' });
    expect(read.problems).toEqual([]);
  });

  it('matches a key exactly (trimmed) when no Name matches: a caller that kept the old fieldname still works', () => {
    expect(inputsByFieldName(fields, { account_id: 'A1', ' email ': 'x' }).inputs).toEqual({
      account_id: 'A1',
      email: 'x',
    });
    // Keys are exact: a different case of a key is not a key.
    const read = inputsByFieldName(fields, { ACCOUNT_ID: 'A1' });
    expect(read.inputs).toEqual({ ACCOUNT_ID: 'A1' });
  });

  it('prefers an exact Name to a key when they name different fields', () => {
    // "imei_2" is the Name of the first field and the key of the second: the exact Name wins.
    const clash = [
      { key: 'first', name: 'imei_2', label: 'First' },
      { key: 'imei_2', name: 'Other', label: 'Second' },
    ];
    expect(inputsByFieldName(clash, { imei_2: 'v' }).inputs).toEqual({ first: 'v' });
  });

  it('prefers an exact key to a Name that differs only in letter case: a field named like another field is keyed', () => {
    // The main box is named "SN"; another field has the key "sn". A caller that kept the old fieldname sends "sn" for the second.
    const clash = [
      { key: 'serial', name: 'SN', label: 'Serial' },
      { key: 'sn', name: 'Note', label: 'Note' },
    ];
    expect(inputsByFieldName(clash, { sn: 'note text' })).toEqual({ inputs: { sn: 'note text' }, problems: [] });
    expect(inputsByFieldName(clash, { SN: 'S1', sn: 'note text' })).toEqual({
      inputs: { serial: 'S1', sn: 'note text' },
      problems: [],
    });
    // Another spelling of the Name that is no key still finds the Name.
    expect(inputsByFieldName(clash, { ' Sn ': 'S1' }).inputs).toEqual({ serial: 'S1' });
  });

  it('leaves a name that matches no field under the name it was sent as, so placement answers unknown_field', () => {
    const read = inputsByFieldName(fields, { Nonsense: 'x', ' spaced ': 'y' });
    expect(read.inputs).toEqual({ Nonsense: 'x', ' spaced ': 'y' });
    expect(read.problems).toEqual([]);
  });

  it('refuses two entries for one field: the first is kept, the later one is a problem on its sent name', () => {
    const byNames = inputsByFieldName(fields, { Email: 'first@mail.example', email: 'second@mail.example' });
    expect(byNames.inputs).toEqual({ email: 'first@mail.example' });
    expect(byNames.problems).toEqual([
      { field: 'inputs.email', code: 'duplicate_field', message: 'Email address was sent twice.' },
    ]);
    const byNameAndKey = inputsByFieldName(fields, { 'Account ID': 'A1', account_id: 'A2' });
    expect(byNameAndKey.inputs).toEqual({ account_id: 'A1' });
    expect(byNameAndKey.problems.map((problem) => [problem.field, problem.code])).toEqual([
      ['inputs.account_id', 'duplicate_field'],
    ]);
  });

  it('keeps a name that is a property of every object as plain data', () => {
    const read = inputsByFieldName(fields, JSON.parse('{"__proto__":"x","constructor":"y"}') as Record<string, string>);
    expect(Object.keys(read.inputs).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(read.inputs)).toBe(Object.prototype);
  });

  it('answers nothing for nothing', () => {
    expect(inputsByFieldName(fields, {})).toEqual({ inputs: {}, problems: [] });
    expect(inputsByFieldName([], { a: '1' }).inputs).toEqual({ a: '1' });
  });
});
