// Unit tests of the permission grammar (decision 018, ALIGNMENT § 4): wildcards, the required x:* rule, validity, Owner.
import { describe, expect, it } from 'bun:test';
import { grants, grantsEverything, isValidPermission } from './permission-grammar';

describe('grants', () => {
  it('grants an exact permission', () => {
    expect(grants(['staff:read'], 'staff:read')).toBe(true);
    expect(grants(['orders:read', 'staff:read'], 'staff:read')).toBe(true);
    expect(grants(['staff:read'], 'staff:update')).toBe(false);
    expect(grants([], 'staff:read')).toBe(false);
  });

  it('lets area:* cover every action of that area and nothing else', () => {
    expect(grants(['staff:*'], 'staff:read')).toBe(true);
    expect(grants(['staff:*'], 'staff:suspend')).toBe(true);
    expect(grants(['staff:*'], 'orders:read')).toBe(false);
    // The area must match as a whole: "staff" does not cover "staffing".
    expect(grants(['staff:*'], 'staffing:read')).toBe(false);
    expect(grants(['staffing:*'], 'staff:read')).toBe(false);
  });

  it('lets * and *:* cover everything', () => {
    for (const required of ['staff:read', 'risk:*', 'a_b:c1']) {
      expect(grants(['*'], required), required).toBe(true);
      expect(grants(['*:*'], required), required).toBe(true);
      expect(grants(['orders:read', '*'], required), required).toBe(true);
    }
  });

  it('needs area:* or * for a required area:*, never a single action', () => {
    expect(grants(['risk:*'], 'risk:*')).toBe(true);
    expect(grants(['*'], 'risk:*')).toBe(true);
    expect(grants(['risk:read'], 'risk:*')).toBe(false);
    expect(grants(['risk:read', 'risk:update', 'risk:create', 'risk:delete'], 'risk:*')).toBe(false);
    expect(grants(['orders:*'], 'risk:*')).toBe(false);
  });

  it('does not treat odd strings as wildcards', () => {
    expect(grants(['*staff'], 'staff:read')).toBe(false);
    expect(grants(['staff:'], 'staff:read')).toBe(false);
    expect(grants([':*'], 'staff:read')).toBe(false);
    expect(grants(['STAFF:*'], 'staff:read')).toBe(false);
  });
});

describe('grantsEverything', () => {
  it('is true for * and *:* only', () => {
    expect(grantsEverything(['*'])).toBe(true);
    expect(grantsEverything(['staff:read', '*:*'])).toBe(true);
    expect(grantsEverything(['staff:*'])).toBe(false);
    expect(grantsEverything([])).toBe(false);
  });
});

describe('isValidPermission', () => {
  it('accepts *, *:*, area:* and area:action', () => {
    for (const value of ['*', '*:*', 'staff:*', 'staff:read', 'api_keys:revoke', 'a1:b2']) {
      expect(isValidPermission(value), value).toBe(true);
    }
  });

  it('refuses everything else', () => {
    for (const value of [
      '',
      'staff',
      'staff:',
      ':read',
      'Staff:read',
      'staff:Read',
      'staff read',
      'staff:read:x',
      '1a:b',
      'staff-x:read',
      '**',
      '*:read',
    ]) {
      expect(isValidPermission(value), JSON.stringify(value)).toBe(false);
    }
  });
});
