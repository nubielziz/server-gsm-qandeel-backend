// Unit tests of the Owner helpers (decision 018, MISMATCHES B113: an Owner is a staff member whose role contains *) and of the
// privilege ceiling and second-permission helpers (decision 046).
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import type { AccountPrincipal } from '@src/modules/identity/ports/account-principal';
import {
  CUSTOMER_CONTACT_PERMISSION,
  type MerchantPrincipal,
  type SessionPrincipal,
  assertOwnerTargetAllowed,
  assertWithinCeiling,
  customerContactOf,
  grantsPerPersonMoney,
  isOwner,
  missingPermission,
  requireOwner,
  requirePermission,
} from '@src/modules/identity/security/principal';

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

/** Runs a check that must refuse and returns the error it threw. */
function refusal(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a refusal');
}

describe('missingPermission', () => {
  it('answers 403 FORBIDDEN in the words of the permission guard', () => {
    const error = missingPermission('refunds:approve');
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(error.detail).toBe('You need the refunds:approve permission to do this.');
  });
});

describe('requirePermission', () => {
  it('passes a held permission, its area wildcard and *; refuses anything else naming it', () => {
    expect(() => requirePermission(holder('refunds:approve'), 'refunds:approve')).not.toThrow();
    expect(() => requirePermission(holder('refunds:*'), 'refunds:approve')).not.toThrow();
    expect(() => requirePermission(holder('*'), 'refunds:approve')).not.toThrow();
    expect(refusal(() => requirePermission(holder('refunds:read'), 'refunds:approve')).detail).toBe(
      'You need the refunds:approve permission to do this.',
    );
    expect(refusal(() => requirePermission(holder('risk:read'), 'risk:*')).detail).toBe(
      'You need the risk:* permission to do this.',
    );
  });
});

describe('requireOwner', () => {
  it('passes * and *:*, refuses every other role with the given detail', () => {
    expect(() => requireOwner(holder('*'), 'Owners only.')).not.toThrow();
    expect(() => requireOwner(holder('*:*'), 'Owners only.')).not.toThrow();
    const everyArea = [
      'staff',
      'roles',
      'access',
      'wallet',
      'orders',
      'clients',
      'payments',
      'catalog',
      'risk',
      'settings',
    ];
    const error = refusal(() => requireOwner(holder(...everyArea.map((area) => `${area}:*`)), 'Owners only.'));
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(error.detail).toBe('Owners only.');
  });
});

describe('assertWithinCeiling', () => {
  it('lets an Owner and a caller who holds everything asked pass', () => {
    expect(() => assertWithinCeiling(holder('*'), ['*', 'wallet:adjust'], 'list')).not.toThrow();
    expect(() =>
      assertWithinCeiling(holder('staff:*', 'orders:read'), ['staff:read', 'orders:read'], 'role'),
    ).not.toThrow();
    expect(() => assertWithinCeiling(holder('staff:read'), [], 'account')).not.toThrow();
  });

  it('names what a sent list asks for that the caller does not hold', () => {
    const error = refusal(() =>
      assertWithinCeiling(holder('staff:read'), ['staff:read', 'wallet:adjust', 'refunds:approve'], 'list'),
    );
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(error.detail).toBe(
      'You can only give permissions you hold yourself. Not yours: wallet:adjust, refunds:approve.',
    );
  });

  it('shows at most five names', () => {
    const seven = ['a:one', 'a:two', 'a:three', 'a:four', 'a:five', 'a:six', 'a:seven'];
    expect(refusal(() => assertWithinCeiling(holder('staff:read'), seven, 'list')).detail).toBe(
      'You can only give permissions you hold yourself. Not yours: a:one, a:two, a:three, a:four, a:five, and 2 more.',
    );
  });

  it('names nothing for a stored role or account', () => {
    const missing = ['wallet:adjust'];
    expect(refusal(() => assertWithinCeiling(holder('staff:read'), missing, 'role')).detail).toBe(
      'This role has permissions you do not hold yourself.',
    );
    expect(refusal(() => assertWithinCeiling(holder('staff:read'), missing, 'account')).detail).toBe(
      'This account has permissions you do not hold yourself.',
    );
  });
});

describe('customerContactOf (decisions 047 and 064)', () => {
  it('is full for clients:read, clients:* and *, masked otherwise: one permission for every account, whatever its rank', () => {
    expect(CUSTOMER_CONTACT_PERMISSION).toBe('clients:read');
    for (const permissions of [['clients:read'], ['clients:*'], ['*'], ['orders:read', 'clients:read']]) {
      expect(customerContactOf(holder(...permissions)), permissions.join()).toBe('full');
    }
    for (const permissions of [
      [],
      ['orders:read'],
      ['clients:update'],
      ['clients:block', 'clients:security'],
      // The old permission of the Customers pages no longer unmasks anything: the Accounts pages are one family.
      ['customers:read'],
      ['customers:*'],
      ['customers:privacy', 'support:*'],
      ['orders:*'],
    ]) {
      expect(customerContactOf(holder(...permissions)), permissions.join()).toBe('masked');
    }
  });
});

describe('the principals of a session (decision 064)', () => {
  it('has one account principal for every rank, and MerchantPrincipal is the same type', () => {
    const principal: AccountPrincipal = {
      kind: 'account',
      accountId: 7,
      clientId: 7,
      rank: { id: 2, kind: 'retail' },
      stage: 'active',
      ip: '203.0.113.7',
      session: { subject: { state: 'ok' } } as AccountPrincipal['session'],
    };
    // The old name keeps compiling for the merchant controllers; a retail account is the same shape.
    const asMerchant: MerchantPrincipal = principal;
    const asSession: SessionPrincipal = asMerchant;
    expect(asSession.kind).toBe('account');
    expect(asMerchant.clientId).toBe(asMerchant.accountId);
  });
});

describe('grantsPerPersonMoney (decision 049)', () => {
  it('is true for each money permission whose rules count per staff member, also through its area wildcard or *', () => {
    for (const permission of ['wallet:adjust', 'wallet:credit_limit', 'payments:approve', 'invoices:create']) {
      expect(grantsPerPersonMoney(['staff:read', permission])).toBe(true);
    }
    expect(grantsPerPersonMoney(['wallet:*'])).toBe(true);
    expect(grantsPerPersonMoney(['payments:*'])).toBe(true);
    expect(grantsPerPersonMoney(['invoices:*'])).toBe(true);
    expect(grantsPerPersonMoney(['*'])).toBe(true);
  });

  it('is false for roles without them, the read permissions of the same areas included', () => {
    expect(grantsPerPersonMoney([])).toBe(false);
    expect(grantsPerPersonMoney(['staff:*', 'roles:*', 'orders:*'])).toBe(false);
    expect(grantsPerPersonMoney(['wallet:read', 'payments:read', 'invoices:read', 'payments:gateways'])).toBe(false);
  });
});
