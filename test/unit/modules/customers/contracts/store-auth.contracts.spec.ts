// Unit tests of the shop's sign-in route contracts (decision 064): the next step now includes the code step, the link exchange takes the
// claim choice and answers its result, the password routes are aliases of the `/client/auth/*` ones, and the sign-out is open to every rank.
import { describe, expect, it } from 'bun:test';
import { STORE_ME_EXAMPLE } from '@src/modules/customers/contracts/store-account.contracts';
import {
  StoreNext,
  StoreVerifySchema,
  changeMyPassword,
  forgotCustomerPassword,
  loginCustomer,
  logoutCustomer,
  requestMagicLink,
  setCustomerPasswordByLink,
  verifyMagicLink,
} from '@src/modules/customers/contracts/store-auth.contracts';

describe('the next step of the shop sign-in', () => {
  it('includes the authenticator code step (two-step sign-in is for every account with a password)', () => {
    expect([...StoreNext.options].sort()).toEqual(['done', 'password', 'totp']);
  });
});

describe('POST /store/v1/auth/verify', () => {
  const answer = {
    ...STORE_ME_EXAMPLE,
    requestedHere: true,
    maskedEmail: 'da•••@example.com',
    next: 'done',
    claimedOrders: 0,
  };

  it('takes the token and an optional claim choice', () => {
    expect(verifyMagicLink.body.safeParse({ token: 'abc' }).success).toBe(true);
    expect(verifyMagicLink.body.safeParse({ token: 'abc', claimGuestOrders: true }).success).toBe(true);
    expect(verifyMagicLink.body.safeParse({ token: 'abc', claimGuestOrders: 'yes' }).success).toBe(false);
    expect(verifyMagicLink.access).toBe('link-token');
  });

  it('answers the account, the next step and the claim result, and knows the busy skip', () => {
    expect(StoreVerifySchema.safeParse(answer).success).toBe(true);
    expect(
      StoreVerifySchema.safeParse({ ...answer, next: 'totp', claimedOrders: 2, claimSkipped: 'busy' }).success,
    ).toBe(true);
    expect(StoreVerifySchema.safeParse({ ...answer, claimSkipped: 'slow' }).success).toBe(false);
    expect(StoreVerifySchema.safeParse({ ...answer, next: 'password' }).success).toBe(false);
    expect(StoreVerifySchema.safeParse({ ...answer, claimedOrders: undefined }).success).toBe(false);
  });
});

describe('the password routes of the shop', () => {
  it('answer the next step of the one sign-in, code step included', () => {
    expect(loginCustomer.success.schema.safeParse({ next: 'totp' }).success).toBe(true);
    expect(loginCustomer.turnstile).toBe(true);
  });

  it('send the reset link with Turnstile always on, and set a password through the link guard', () => {
    expect(forgotCustomerPassword.turnstile).toBe(true);
    expect(forgotCustomerPassword.turnstileRollout).toBeUndefined();
    expect(setCustomerPasswordByLink.access).toBe('link-token');
  });

  it('take a pending password session on the own change until the contract release', () => {
    expect(changeMyPassword.sessionStages).toEqual(['pending_password', 'active']);
    expect(changeMyPassword.rank).toBe('retail');
  });

  it('open the sign-out to every rank and at every step', () => {
    expect(logoutCustomer.rank).toBe('any');
    expect([...logoutCustomer.sessionStages].sort()).toEqual(['active', 'pending_password', 'pending_totp']);
  });

  it('keep the sign-in link for the retail rank: public, with the anti-bot token', () => {
    expect(requestMagicLink.access).toBe('public');
    expect(requestMagicLink.turnstile).toBe(true);
  });
});
