// Unit tests of the role rules: cleaning the permission list, the catalog check and the editor words.
import { describe, expect, it } from 'bun:test';
import { areaOf, cleanPermissions, describePermission, unknownPermissions } from './role-rules';

const CATALOG = ['staff:read', 'staff:update', 'wallet:credit_limit', 'orders:read'];

describe('cleanPermissions', () => {
  it('trims, writes *:* as *, and drops repeats in first-seen order', () => {
    expect(cleanPermissions([' staff:read ', 'orders:*', 'staff:read', '*:*', '*'])).toEqual([
      'staff:read',
      'orders:*',
      '*',
    ]);
  });

  it('keeps an empty list empty', () => {
    expect(cleanPermissions([])).toEqual([]);
  });
});

describe('unknownPermissions', () => {
  it('accepts concrete catalog entries, the star, and wildcards of known areas', () => {
    expect(unknownPermissions(['staff:read', 'wallet:*', '*', 'orders:*'], CATALOG)).toEqual([]);
  });

  it('names what is not in the catalog, malformed, or a wildcard of an unknown area', () => {
    expect(unknownPermissions(['staff:delete', 'Staff:read', 'nothing:*', 'staff', 'staff:read'], CATALOG)).toEqual([
      'staff:delete',
      'Staff:read',
      'nothing:*',
      'staff',
    ]);
  });
});

describe('describePermission', () => {
  it('uses the area as group and the humanised action as label', () => {
    expect(describePermission('wallet:credit_limit')).toEqual({
      key: 'wallet:credit_limit',
      label: 'Credit limit',
      group: 'wallet',
    });
    expect(areaOf('staff:read')).toBe('staff');
  });
});
