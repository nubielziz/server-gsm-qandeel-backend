// Unit tests of the one rule for "this field is the supplier's main box" (decision 042): the dispatcher and the sync's adoption both use it.
import { describe, expect, it } from 'bun:test';
import { MAIN_INPUT_SUPPLIER_KEY, isMainInputKey, resolvedSupplierKey } from './main-input-key';

describe('resolvedSupplierKey', () => {
  it("takes the link's field map first, then the field's supplier key, then its key", () => {
    expect(resolvedSupplierKey({ key: 'ecid', supplierKey: 'Ecid' }, 'IMEI')).toBe('IMEI');
    expect(resolvedSupplierKey({ key: 'ecid', supplierKey: 'Ecid' })).toBe('Ecid');
    expect(resolvedSupplierKey({ key: 'imei', supplierKey: '' })).toBe('imei');
    expect(resolvedSupplierKey({ key: 'ecid', supplierKey: 'Ecid' }, '')).toBe('Ecid');
    expect(resolvedSupplierKey({ key: 'ecid', supplierKey: 'Ecid' }, 7)).toBe('Ecid');
  });
});

describe('isMainInputKey', () => {
  it('is IMEI in any case, spaces around ignored, and nothing else', () => {
    for (const key of ['IMEI', 'imei', ' Imei ', MAIN_INPUT_SUPPLIER_KEY]) expect(isMainInputKey(key), key).toBe(true);
    for (const key of ['IMEI2', 'IMEI NO', 'SN', '', 'I MEI']) expect(isMainInputKey(key), key).toBe(false);
  });
});
