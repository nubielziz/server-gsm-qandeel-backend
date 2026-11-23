// Unit tests of the merchant sign-in steps: a temporary password first, then the optional 2FA code, then a full session.
import { describe, expect, it } from 'bun:test';
import {
  type MerchantSignInAccount,
  merchantShadowsCustomer,
  merchantStageOfStep,
  nextMerchantStep,
  signInStillHolds,
} from '@src/modules/identity/domain/merchant-sign-in-step';

describe('the step after the password', () => {
  it('asks for a new password first, whether or not 2FA is on', () => {
    expect(nextMerchantStep({ mustChangePassword: true, twofaEnabled: true })).toBe('password');
    expect(nextMerchantStep({ mustChangePassword: true, twofaEnabled: false })).toBe('password');
  });

  it('asks for a code when 2FA is on and is done when it is off', () => {
    expect(nextMerchantStep({ mustChangePassword: false, twofaEnabled: true })).toBe('totp');
    expect(nextMerchantStep({ mustChangePassword: false, twofaEnabled: false })).toBe('done');
  });

  it('keeps a pending step in a pending session and opens a full one otherwise', () => {
    expect(merchantStageOfStep('password')).toBe('pending_password');
    expect(merchantStageOfStep('totp')).toBe('pending_totp');
    expect(merchantStageOfStep('done')).toBe('active');
  });
});

describe('merchantShadowsCustomer', () => {
  it('lets a merchant take precedence over a customer only once its email is verified (decision 052)', () => {
    expect(merchantShadowsCustomer({ emailVerifiedAt: new Date('2026-11-07T10:00:00.000Z') })).toBe(true);
    expect(merchantShadowsCustomer({ emailVerifiedAt: null })).toBe(false);
  });
});

describe('signInStillHolds', () => {
  const checked: MerchantSignInAccount = {
    passwordHash: '$argon2id$checked',
    passwordChangedAt: new Date('2026-11-01T08:00:00.000Z'),
    twofaEnabled: false,
    mustChangePassword: false,
    status: 'active',
  };

  it('opens the session when the account is as it was when the password was checked', () => {
    expect(signInStillHolds(checked, { ...checked })).toBe(true);
    // A merchant waiting for approval signs in like any other (B153).
    expect(signInStillHolds({ ...checked, status: 'pending' }, { ...checked, status: 'pending' })).toBe(true);
    // Approval in between changes nothing the sign-in was decided on.
    expect(signInStillHolds({ ...checked, status: 'pending' }, checked)).toBe(true);
    // Another sign-in of the same merchant upgraded the hash at a higher cost: the password is the same one.
    expect(signInStillHolds(checked, { ...checked, passwordHash: '$argon2id$upgraded' })).toBe(true);
    expect(
      signInStillHolds(
        { ...checked, passwordChangedAt: null },
        { ...checked, passwordChangedAt: null, passwordHash: '$argon2id$upgraded' },
      ),
    ).toBe(true);
  });

  it('refuses when the password, the two-step state or the forced change moved on, or the merchant was suspended', () => {
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
    expect(signInStillHolds(checked, { ...checked, status: 'suspended' })).toBe(false);
  });
});
