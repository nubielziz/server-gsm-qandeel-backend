// Unit tests of the main input of an order (RESOLUTIONS orders-suppliers-2): one value for every service type.
import { describe, expect, it } from 'bun:test';
import { carriedImeiInputs, mainInputOf } from '@src/modules/orders/domain/main-input';

const fields = [
  { id: 3, key: 'serial', required: false, sort: 1 },
  { id: 1, key: 'username', required: true, sort: 2 },
  { id: 2, key: 'account', required: true, sort: 2 },
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

describe('carriedImeiInputs (decision 042)', () => {
  const box = [
    { id: 7, key: 'model', supplierKey: 'Model', sort: 1 },
    { id: 5, key: 'ecid', supplierKey: 'imei', sort: 0 },
    { id: 9, key: 'serial', supplierKey: 'IMEI', sort: 2 },
  ];

  it('puts the IMEI under the first field by form order that is sent as IMEI, trimmed', () => {
    expect(carriedImeiInputs({ type: 'server', imei: ' ABCDEF0123456 ', inputs: { model: 'X' }, fields: box })).toEqual(
      {
        model: 'X',
        ecid: 'ABCDEF0123456',
      },
    );
  });

  it('reads a field keyed imei with no supplier key as the box, and keeps a value the buyer gave that field', () => {
    const keyed = [{ id: 1, key: 'imei', supplierKey: '', sort: 0 }];
    expect(carriedImeiInputs({ type: 'server', imei: 'A1', inputs: {}, fields: keyed })).toEqual({ imei: 'A1' });
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
