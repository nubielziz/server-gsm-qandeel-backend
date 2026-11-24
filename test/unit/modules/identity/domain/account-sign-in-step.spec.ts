// Unit tests of the sign-in steps of an account of any rank: a temporary password first, then the optional 2FA code, then a full session;
// and the rule that decides whether a sign-in may still open its session (it asks `canAct`, never a word).
import { describe, expect, it } from 'bun:test';
import {
  type AccountSignInState,
  accountStageOfStep,
  nextAccountStep,
  signInStillHolds,
} from '@src/modules/identity/domain/account-sign-in-step';

describe('the step after the password', () => {
  it('asks for a new password first, whether or not 2FA is on', () => {
    expect(nextAccountStep({ mustChangePassword: true, twofaEnabled: true })).toBe('password');
    expect(nextAccountStep({ mustChangePassword: true, twofaEnabled: false })).toBe('password');
  });

  it('asks for a code when 2FA is on and is done when it is off', () => {
    expect(nextAccountStep({ mustChangePassword: false, twofaEnabled: true })).toBe('totp');
    expect(nextAccountStep({ mustChangePassword: false, twofaEnabled: false })).toBe('done');
  });

  it('keeps a pending step in a pending session and opens a full one otherwise', () => {
    expect(accountStageOfStep('password')).toBe('pending_password');
    expect(accountStageOfStep('totp')).toBe('pending_totp');
    expect(accountStageOfStep('done')).toBe('active');
  });
});

describe('signInStillHolds', () => {
  const checked: AccountSignInState = {
    passwordHash: '$argon2id$checked',
    passwordChangedAt: new Date('2026-11-01T08:00:00.000Z'),
    twofaEnabled: false,
    mustChangePassword: false,
    status: 'active',
  };

  it('opens the session when the account is as it was when the password was checked', () => {
    expect(signInStillHolds(checked, { ...checked })).toBe(true);
    // Another sign-in of the same account upgraded the hash at a higher cost: the password is the same one.
    expect(signInStillHolds(checked, { ...checked, passwordHash: '$argon2id$upgraded' })).toBe(true);
    expect(
      signInStillHolds(
        { ...checked, passwordChangedAt: null },
        { ...checked, passwordChangedAt: null, passwordHash: '$argon2id$upgraded' },
      ),
    ).toBe(true);
  });

  it('refuses when the password, the two-step state or the forced change moved on', () => {
    const chosenSince = {
      passwordHash: '$argon2id$chosen-since',
      passwordChangedAt: new Date('2026-11-01T08:00:01.000Z'),
    };
    expect(signInStillHolds(checked, { ...checked, ...chosenSince })).toBe(false);
    expect(signInStillHolds({ ...checked, passwordChangedAt: null }, { ...checked, ...chosenSince })).toBe(false);
    expect(signInStillHolds(checked, { ...checked, passwordHash: null })).toBe(false);
    expect(signInStillHolds(checked, { ...checked, twofaEnabled: true })).toBe(false);
    expect(signInStillHolds({ ...checked, twofaEnabled: true }, checked)).toBe(false);
    expect(signInStillHolds(checked, { ...checked, mustChangePassword: true })).toBe(false);
    expect(signInStillHolds({ ...checked, mustChangePassword: true }, checked)).toBe(false);
  });

  it('refuses every status that may not act: suspended, blocked and anonymized, and a word it does not know (canAct)', () => {
    for (const status of ['suspended', 'blocked', 'anonymized'] as const) {
      expect(signInStillHolds(checked, { ...checked, status }), status).toBe(false);
    }
    // The retired status `pending` is not in the type any more; a row that still holds it (data written outside the application) acts as nobody.
    const unknown = 'pending' as unknown as AccountSignInState['status'];
    expect(signInStillHolds(checked, { ...checked, status: unknown })).toBe(false);
  });
});
