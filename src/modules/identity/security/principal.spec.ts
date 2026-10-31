// Unit tests of the Owner helpers (decision 018, MISMATCHES B113): an Owner is a staff member whose role contains *.
import { describe, expect, it } from 'bun:test';
import { AppError } from '../../../common/errors';
import { assertOwnerTargetAllowed, isOwner } from './principal';

const holder = (...permissions: string[]) => ({ permissions });

describe('isOwner', () => {
  it('is true when the role holds * (or *:*), whatever else it holds', () => {
    expect(isOwner(holder('*'))).toBe(true);
    expect(isOwner(holder('*:*'))).toBe(true);
    expect(isOwner(holder('staff:read', '*'))).toBe(true);
  });

  it('is false for roles that only hold area wildcards, even all of them', () => {
    expect(isOwner(holder('staff:*', 'roles:*', 'access:*'))).toBe(false);
    expect(isOwner(holder())).toBe(false);
  });
});

describe('assertOwnerTargetAllowed', () => {
  it('lets an Owner act on an Owner and on anybody else', () => {
    expect(() => assertOwnerTargetAllowed(holder('*'), holder('*'))).not.toThrow();
    expect(() => assertOwnerTargetAllowed(holder('*'), holder('staff:read'))).not.toThrow();
  });

  it('lets anybody act on a target who is not an Owner', () => {
    expect(() => assertOwnerTargetAllowed(holder('staff:*'), holder('orders:read'))).not.toThrow();
  });

  it('refuses a caller without * acting on an Owner with 403 FORBIDDEN', () => {
    for (const caller of [holder('staff:*', 'roles:*'), holder()]) {
      try {
        assertOwnerTargetAllowed(caller, holder('*'));
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
      }
    }
  });
});
