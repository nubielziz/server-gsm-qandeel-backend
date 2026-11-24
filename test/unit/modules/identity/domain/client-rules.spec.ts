// Unit tests of the account rules of staff status writes: the status machine, the suspension reason and usernames.
import { describe, expect, it } from 'bun:test';
import { CLIENT_STATUSES } from '@src/modules/identity/db/schema';
import {
  NEVER_APPROVED_REASON,
  canMoveClient,
  reactivationNeedsOwner,
  statusChangePermission,
  suspendReasonProblem,
  usernameBase,
  usernameCandidate,
} from '@src/modules/identity/domain/client-rules';

describe('canMoveClient', () => {
  it('allows exactly suspend and reactivate: blocked and anonymized accounts move only through their own routes', () => {
    const allowed = CLIENT_STATUSES.flatMap((from) => CLIENT_STATUSES.map((to) => [from, to] as const)).filter(
      ([from, to]) => canMoveClient(from, to),
    );
    expect(allowed).toEqual([
      ['active', 'suspended'],
      ['suspended', 'active'],
    ]);
  });

  it('never leaves blocked or anonymized, and never stays where it is', () => {
    for (const to of CLIENT_STATUSES) {
      expect(canMoveClient('blocked', to)).toBe(false);
      expect(canMoveClient('anonymized', to)).toBe(false);
      expect(canMoveClient(to, to)).toBe(false);
    }
  });
});

describe('suspendReasonProblem', () => {
  it('needs 3 to 140 characters', () => {
    expect(suspendReasonProblem(undefined)).toContain('at least 3');
    expect(suspendReasonProblem('ab')).toContain('at least 3');
    expect(suspendReasonProblem('abc')).toBeUndefined();
    expect(suspendReasonProblem('x'.repeat(140))).toBeUndefined();
    expect(suspendReasonProblem('x'.repeat(141))).toContain('at most 140');
  });
});

describe('usernameBase and usernameCandidate', () => {
  it('slugs the name to lower case letters, digits and single hyphens', () => {
    expect(usernameBase('Zain Mobile Hub')).toBe('zain-mobile-hub');
    expect(usernameBase('  Al-Noor   Telecom!! ')).toBe('al-noor-telecom');
    expect(usernameBase('Café Électrique')).toBe('cafe-electrique');
  });

  it('falls back to "merchant" and caps the length', () => {
    expect(usernameBase('مرحبا')).toBe('merchant');
    expect(usernameBase('a'.repeat(80))).toHaveLength(30);
  });

  it('numbers collisions from 2', () => {
    expect(usernameCandidate('acme', 1)).toBe('acme');
    expect(usernameCandidate('acme', 2)).toBe('acme-2');
  });
});

describe('statusChangePermission', () => {
  it('asks clients:security to suspend or reactivate', () => {
    expect(statusChangePermission('active', 'suspended')).toBe('clients:security');
    expect(statusChangePermission('suspended', 'active')).toBe('clients:security');
  });

  it('asks nothing for pairs that touch neither side of a suspension', () => {
    expect(statusChangePermission('active', 'blocked')).toBeNull();
    expect(statusChangePermission('blocked', 'active')).toBeNull();
    expect(statusChangePermission('active', 'active')).toBeNull();
  });
});

describe('reactivationNeedsOwner', () => {
  const neverApproved = {
    status: 'suspended',
    rankKind: 'merchant',
    suspendedBy: null,
    suspendedReason: NEVER_APPROVED_REASON,
  } as const;

  it('asks for the Owner to make active a merchant rank that the retirement of the approval step suspended', () => {
    expect(reactivationNeedsOwner(neverApproved, 'active')).toBe(true);
  });

  it('leaves every other case to the usual permissions: a staff suspension, another reason, a retail rank, another move', () => {
    expect(reactivationNeedsOwner({ ...neverApproved, suspendedBy: 7 }, 'active')).toBe(false);
    expect(reactivationNeedsOwner({ ...neverApproved, suspendedReason: 'Unpaid debt' }, 'active')).toBe(false);
    expect(reactivationNeedsOwner({ ...neverApproved, rankKind: 'retail' }, 'active')).toBe(false);
    expect(reactivationNeedsOwner({ ...neverApproved, status: 'active' }, 'suspended')).toBe(false);
  });
});
