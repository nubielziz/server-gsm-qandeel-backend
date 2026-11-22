// Unit tests of the role rules: cleaning the permission list, the catalog check and the editor words.
import { describe, expect, it } from 'bun:test';
import {
  areaOf,
  cleanPermissions,
  describePermission,
  samePermissions,
  unknownPermissions,
} from '@src/modules/identity/domain/role-rules';

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

describe('samePermissions', () => {
  it('is true for the same entries in any order, and for two empty lists', () => {
    expect(samePermissions(['staff:read', 'orders:*'], ['orders:*', 'staff:read'])).toBe(true);
    expect(samePermissions([], [])).toBe(true);
  });

  it('is false when an entry was added, taken away or swapped', () => {
    expect(samePermissions(['staff:read'], ['staff:read', 'orders:read'])).toBe(false);
    expect(samePermissions(['staff:read', 'orders:read'], ['staff:read'])).toBe(false);
    expect(samePermissions(['staff:read'], ['staff:update'])).toBe(false);
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
