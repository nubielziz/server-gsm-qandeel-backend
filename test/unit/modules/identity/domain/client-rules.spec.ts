// Unit tests of the merchant rules: the status machine, the suspension reason, usernames and referral codes.
import { describe, expect, it } from 'bun:test';
import { CLIENT_STATUSES } from '@src/modules/identity/db/schema';
import {
  canMoveClient,
  referralCode,
  statusChangePermission,
  suspendReasonProblem,
  usernameBase,
  usernameCandidate,
} from '@src/modules/identity/domain/client-rules';

describe('canMoveClient', () => {
  it('allows exactly approve, reactivate, suspend and decline (suspend a pending applicant)', () => {
    const allowed = CLIENT_STATUSES.flatMap((from) => CLIENT_STATUSES.map((to) => [from, to] as const)).filter(
      ([from, to]) => canMoveClient(from, to),
    );
    expect(allowed).toEqual([
      ['active', 'suspended'],
      ['suspended', 'active'],
      ['pending', 'active'],
      ['pending', 'suspended'],
    ]);
  });

  it('never goes back to pending', () => {
    expect(canMoveClient('active', 'pending')).toBe(false);
    expect(canMoveClient('suspended', 'pending')).toBe(false);
    expect(canMoveClient('pending', 'pending')).toBe(false);
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

describe('referralCode', () => {
  it('is GSM plus six characters from the alphabet without look-alikes', () => {
    let n = 0;
    const code = referralCode((max) => n++ % max);
    expect(code).toMatch(/^GSM[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe('statusChangePermission', () => {
  it('asks clients:security to suspend, decline or reactivate, and nothing more to approve', () => {
    expect(statusChangePermission('active', 'suspended')).toBe('clients:security');
    expect(statusChangePermission('pending', 'suspended')).toBe('clients:security');
    expect(statusChangePermission('suspended', 'active')).toBe('clients:security');
    expect(statusChangePermission('pending', 'active')).toBeNull();
  });

  it('asks nothing for pairs that touch neither side of a suspension', () => {
    expect(statusChangePermission('active', 'pending')).toBeNull();
    expect(statusChangePermission('active', 'active')).toBeNull();
  });
});
