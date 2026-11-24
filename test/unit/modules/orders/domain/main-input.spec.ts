// Unit tests of the main input of an order (RESOLUTIONS orders-suppliers-2): one value for every service type.
import { describe, expect, it } from 'bun:test';
import { carriedImeiInputs, mainInputOf } from '@src/modules/orders/domain/main-input';

const fields = [
  { id: 3, key: 'serial', isMainInput: false, required: false, sort: 1 },
  { id: 1, key: 'username', isMainInput: false, required: true, sort: 2 },
  { id: 2, key: 'account', isMainInput: false, required: true, sort: 2 },
];

describe('mainInputOf', () => {
  it('an IMEI service stores the IMEI, trimmed', () => {
    expect(mainInputOf({ type: 'imei', imei: ' 352905112490861 ', inputs: {}, fields: [] })).toBe('352905112490861');
    expect(mainInputOf({ type: 'imei', imei: '  ', inputs: {}, fields: [] })).toBeNull();
    expect(mainInputOf({ type: 'imei', inputs: {}, fields: [] })).toBeNull();
  });

  it('a server or remote service stores the first required field by sort, then by id', () => {
    const inputs = { serial: 'S1', username: 'amir92', account: 'acc-1' };
    // `serial` is first by sort but optional; `account` (id 2) comes before `username` (id 1)? No: ties break by id, so username (1).
    expect(mainInputOf({ type: 'server', inputs, fields })).toBe('amir92');
    expect(mainInputOf({ type: 'remote', inputs, fields })).toBe('amir92');
    expect(mainInputOf({ type: 'server', inputs: { serial: 'S1' }, fields })).toBeNull();
    expect(mainInputOf({ type: 'server', inputs, fields: [] })).toBeNull();
  });

  it('a server, remote or file service stores the flagged field first, as the dispatch sends it as IMEI (decision 065)', () => {
    // `serial` is optional and first by sort, `username` is the first required field; the flag on `account` decides.
    const flagged = fields.map((field) => ({ ...field, isMainInput: field.key === 'account' }));
    const inputs = { serial: 'S1', username: 'amir92', account: 'acc-1' };
    for (const type of ['server', 'remote', 'file'] as const) {
      expect(mainInputOf({ type, inputs, fields: flagged }), type).toBe('acc-1');
    }
    // A flagged field without a value leaves the old order: the first required field (server, remote), the first field (file).
    expect(mainInputOf({ type: 'server', inputs: { username: 'amir92', account: ' ' }, fields: flagged })).toBe(
      'amir92',
    );
    expect(mainInputOf({ type: 'file', inputs: { serial: 'S1' }, fields: flagged, fileName: 'input.zip' })).toBe('S1');
    // An IMEI service stores the typed IMEI, whatever is flagged.
    expect(mainInputOf({ type: 'imei', imei: '352905112490861', inputs, fields: flagged })).toBe('352905112490861');
  });

  it("a file service stores the first field's value when it has fields, else the file name", () => {
    expect(mainInputOf({ type: 'file', inputs: { serial: 'SM-S911B' }, fields, fileName: 'input.zip' })).toBe(
      'SM-S911B',
    );
    expect(mainInputOf({ type: 'file', inputs: {}, fields: [], fileName: ' input.zip ' })).toBe('input.zip');
    expect(mainInputOf({ type: 'file', inputs: {}, fields: [] })).toBeNull();
    // With fields, the file name is not the input even when the first field is empty.
    expect(mainInputOf({ type: 'file', inputs: {}, fields, fileName: 'input.zip' })).toBeNull();
  });
});

describe('carriedImeiInputs (decision 042, decision 065)', () => {
  // The box is the flagged field, whatever its key or Name; `ecid` is first by form order, `serial` is flagged by mistake in the list too.
  const box = [
    { id: 7, key: 'model', isMainInput: false, sort: 1 },
    { id: 5, key: 'ecid', isMainInput: true, sort: 0 },
    { id: 9, key: 'serial', isMainInput: true, sort: 2 },
  ];

  it('puts the IMEI under the first flagged field by form order, trimmed', () => {
    expect(carriedImeiInputs({ type: 'server', imei: ' ABCDEF0123456 ', inputs: { model: 'X' }, fields: box })).toEqual(
      {
        model: 'X',
        ecid: 'ABCDEF0123456',
      },
    );
  });

  it('reads the flag, never the key: a field keyed imei that is not flagged is not the box', () => {
    const keyed = [{ id: 1, key: 'imei', isMainInput: false, sort: 0 }];
    const inputs = { model: 'X' };
    expect(carriedImeiInputs({ type: 'server', imei: 'A1', inputs, fields: keyed })).toBe(inputs);
    const flagged = [{ id: 1, key: 'imei', isMainInput: true, sort: 0 }];
    expect(carriedImeiInputs({ type: 'server', imei: 'A1', inputs: {}, fields: flagged })).toEqual({ imei: 'A1' });
  });

  it('keeps a value the buyer gave the box field', () => {
    expect(carriedImeiInputs({ type: 'server', imei: 'A1', inputs: { ecid: 'OWN' }, fields: box })).toEqual({
      ecid: 'OWN',
    });
  });

  it('changes nothing for an IMEI service, without an IMEI, or without a box field', () => {
    const inputs = { model: 'X' };
    expect(carriedImeiInputs({ type: 'imei', imei: 'A1', inputs, fields: box })).toBe(inputs);
    expect(carriedImeiInputs({ type: 'server', imei: undefined, inputs, fields: box })).toBe(inputs);
    expect(carriedImeiInputs({ type: 'server', imei: '  ', inputs, fields: box })).toBe(inputs);
    expect(carriedImeiInputs({ type: 'server', imei: 'A1', inputs, fields: [box[0]!] })).toBe(inputs);
  });
});
