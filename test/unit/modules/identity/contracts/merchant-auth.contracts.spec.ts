// Unit tests of the `/client/auth/*` route contracts (decision 064): the `AccountMe` shape both "me" routes share, the rank marks of the
// four routes every account may call, and the Turnstile rule of the password routes.
import { describe, expect, it } from 'bun:test';
import {
  ACCOUNT_ME_EXAMPLE,
  AccountMeShape,
  merchantChangeTemporaryPassword,
  merchantForgotPassword,
  merchantLogin,
  merchantLogout,
  merchantMe,
  merchantResendVerification,
  merchantVerifyTwoFactor,
} from '@src/modules/identity/contracts/merchant-auth.contracts';

/** The keys of `AccountMe`: the shared account keys plus the profile keys both routes send. */
const ACCOUNT_ME_KEYS = [
  'address',
  'company',
  'country',
  'createdAt',
  'currency',
  'email',
  'emailVerifiedAt',
  'hasPassword',
  'id',
  'marketingOptIn',
  'mustChangePassword',
  'name',
  'phone',
  'rank',
  'status',
  'taxId',
  'twofaEnabled',
  'username',
];

describe('AccountMeShape', () => {
  it('has exactly the keys of AccountMe, and no group', () => {
    expect(Object.keys(AccountMeShape.shape).sort()).toEqual(ACCOUNT_ME_KEYS);
    expect(Object.keys(AccountMeShape.shape.rank.shape).sort()).toEqual(['discountPercent', 'id', 'kind', 'name']);
  });

  it('accepts its example, and the example has no key the shape lacks', () => {
    expect(AccountMeShape.safeParse(ACCOUNT_ME_EXAMPLE).success).toBe(true);
    expect(Object.keys(ACCOUNT_ME_EXAMPLE).sort()).toEqual(ACCOUNT_ME_KEYS);
  });

  it('wants empty text, never null, for the username and the company', () => {
    expect(AccountMeShape.safeParse({ ...ACCOUNT_ME_EXAMPLE, username: null }).success).toBe(false);
    expect(AccountMeShape.safeParse({ ...ACCOUNT_ME_EXAMPLE, company: null }).success).toBe(false);
    expect(AccountMeShape.safeParse({ ...ACCOUNT_ME_EXAMPLE, username: '', company: '' }).success).toBe(true);
  });

  it('knows the two rank kinds and the four statuses, and no pending', () => {
    const rank = (kind: string) =>
      AccountMeShape.safeParse({ ...ACCOUNT_ME_EXAMPLE, rank: { id: 1, name: 'x', kind, discountPercent: '0.0000' } });
    expect(rank('merchant').success).toBe(true);
    expect(rank('retail').success).toBe(true);
    expect(rank('b2b').success).toBe(false);
    for (const status of ['active', 'suspended', 'blocked', 'anonymized']) {
      expect(AccountMeShape.safeParse({ ...ACCOUNT_ME_EXAMPLE, status }).success, status).toBe(true);
    }
    expect(AccountMeShape.safeParse({ ...ACCOUNT_ME_EXAMPLE, status: 'pending' }).success).toBe(false);
  });
});

describe('the rank marks of the routes every account may call', () => {
  it('opens the code step, the sign-out and the forced password change to every rank', () => {
    expect(merchantVerifyTwoFactor.rank).toBe('any');
    expect(merchantLogout.rank).toBe('any');
    expect(merchantChangeTemporaryPassword.rank).toBe('any');
  });

  it('keeps the other session routes of the family for the merchant ranks', () => {
    expect(merchantMe.rank).toBe('merchant');
    expect(merchantResendVerification.rank).toBe('merchant');
  });

  it('answers AccountMe on the merchant route', () => {
    expect(merchantMe.success.schema).toBe(AccountMeShape);
  });

  it('keeps the sign-out working at every step of the session', () => {
    expect([...merchantLogout.sessionStages].sort()).toEqual(['active', 'pending_password', 'pending_totp']);
    expect(merchantVerifyTwoFactor.sessionStages).toEqual(['pending_totp']);
    expect(merchantChangeTemporaryPassword.sessionStages).toEqual(['pending_password']);
  });
});

describe('Turnstile on the password routes', () => {
  it('always checks the forgot route: the merchant rollout switch no longer governs it', () => {
    expect(merchantForgotPassword.turnstile).toBe(true);
    expect(merchantForgotPassword.turnstileRollout).toBeUndefined();
  });

  it('keeps the rollout switch on the old login alias', () => {
    expect(merchantLogin.turnstile).toBe(true);
    expect(merchantLogin.turnstileRollout).toBe('merchant-auth');
  });
});
