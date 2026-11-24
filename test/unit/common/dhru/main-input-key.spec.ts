// Unit tests of the name a service field travels under towards a supplier (decisions 042 and 065): `supplierFieldName` is the rule the
// dispatch, the import and the sync use.
import { describe, expect, it } from 'bun:test';
import { supplierFieldName } from '@src/common/dhru/main-input-key';

describe('supplierFieldName', () => {
  it("takes the link's field map first, then the field's Name", () => {
    expect(supplierFieldName({ supplierKey: 'Account User' }, 'user_name')).toBe('user_name');
    expect(supplierFieldName({ supplierKey: 'Account User' })).toBe('Account User');
    expect(supplierFieldName({ supplierKey: 'Account User' }, undefined)).toBe('Account User');
  });

  it('ignores a field map value that is empty or is not text', () => {
    for (const mapped of ['', 7, null, true, ['x'], { a: 1 }]) {
      expect(supplierFieldName({ supplierKey: 'Account User' }, mapped), JSON.stringify(mapped)).toBe('Account User');
    }
  });

  it('keeps the Name as it is: no trimming, no change of case, and the text IMEI means nothing here', () => {
    expect(supplierFieldName({ supplierKey: ' Serial No ' })).toBe(' Serial No ');
    expect(supplierFieldName({ supplierKey: 'IMEI' })).toBe('IMEI');
    expect(supplierFieldName({ supplierKey: 'Device' }, 'imei')).toBe('imei');
  });
});
