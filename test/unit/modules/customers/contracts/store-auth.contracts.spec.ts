// Unit tests of the shop's sign-in route contracts (decisions 064 and 079): the next step now includes the code step, the link exchange takes
// the claim choice and answers its result (and, for a sign-up link, whether its form was applied or the details to confirm), the sign-up and
// its finish clean and judge their fields with one set of rules, the password routes are aliases of the `/client/auth/*` ones, and the
// sign-out is open to every rank.
import { describe, expect, it } from 'bun:test';
import { STORE_ME_EXAMPLE } from '@src/modules/customers/contracts/store-account.contracts';
import {
  StoreNext,
  StoreVerifySchema,
  changeMyPassword,
  finishCustomerSignUp,
  forgotCustomerPassword,
  loginCustomer,
  logoutCustomer,
  requestMagicLink,
  setCustomerPasswordByLink,
  signUpCustomer,
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

  it('says whether the password of a sign-up was set, and only as a boolean', () => {
    expect(StoreVerifySchema.safeParse({ ...answer, passwordSet: true }).success).toBe(true);
    expect(StoreVerifySchema.safeParse({ ...answer, passwordSet: false }).success).toBe(true);
    expect(StoreVerifySchema.safeParse({ ...answer, passwordSet: 'yes' }).success).toBe(false);
  });

  it('shows the details to confirm next to passwordSet false, and never a password', () => {
    const pendingDetails = { firstName: 'Daniel', lastName: 'Whitmore', country: 'GB', phone: '+447700900123' };
    const parsed = StoreVerifySchema.parse({
      ...answer,
      passwordSet: false,
      pendingDetails: { ...pendingDetails, password: 'x' },
    });
    expect(parsed.pendingDetails).toEqual(pendingDetails);
    expect(StoreVerifySchema.safeParse({ ...answer, pendingDetails: { firstName: 'Daniel' } }).success).toBe(false);
  });
});

describe('POST /store/v1/auth/sign-up', () => {
  const form = {
    email: ' Daniel.Whitmore@Example.com ',
    password: 'a-long-password',
    firstName: '  Daniel ',
    lastName: 'Whitmore',
    country: 'gb',
    phone: '+44 (7700) 900-123',
  };
  const fieldsOf = (body: unknown): string[] => {
    const parsed = signUpCustomer.body.safeParse(body);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')).sort();
  };

  it('is public, needs the anti-bot token like the sign-in link, and answers 204', () => {
    expect(signUpCustomer.access).toBe('public');
    expect(signUpCustomer.turnstile).toBe(true);
    expect(signUpCustomer.csrf).toBe(false);
    expect(signUpCustomer.surface).toBe('store');
    expect(signUpCustomer.success.status).toBe(204);
    expect(signUpCustomer.errors).toContain('WEAK_PASSWORD');
  });

  it('cleans what it accepts: the email, the names trimmed, the country in upper case, the phone without its separators', () => {
    const parsed = signUpCustomer.body.parse(form);
    expect(parsed).toEqual({
      email: 'daniel.whitmore@example.com',
      password: 'a-long-password',
      firstName: 'Daniel',
      lastName: 'Whitmore',
      country: 'GB',
      phone: '+447700900123',
    });
  });

  it('keeps the password exactly as typed', () => {
    expect(signUpCustomer.body.parse({ ...form, password: '  spaced password  ' }).password).toBe(
      '  spaced password  ',
    );
  });

  it('requires every field', () => {
    expect(fieldsOf({})).toEqual(['country', 'email', 'firstName', 'lastName', 'password', 'phone']);
  });

  it('names the field it refuses', () => {
    expect(fieldsOf({ ...form, firstName: '   ' })).toEqual(['firstName']);
    expect(fieldsOf({ ...form, lastName: 'x'.repeat(61) })).toEqual(['lastName']);
    expect(fieldsOf({ ...form, lastName: 'Whit\nmore' })).toEqual(['lastName']);
    expect(fieldsOf({ ...form, phone: '12-34' })).toEqual(['phone']);
    expect(fieldsOf({ ...form, phone: '+44 7700 900123 ext 4' })).toEqual(['phone']);
    expect(fieldsOf({ ...form, country: 'GBR' })).toEqual(['country']);
    expect(fieldsOf({ ...form, email: 'not-an-email' })).toEqual(['email']);
    expect(fieldsOf({ ...form, password: '' })).toEqual(['password']);
    expect(fieldsOf({ ...form, password: 'x'.repeat(1025) })).toEqual(['password']);
  });

  it('parses its own example', () => {
    expect(signUpCustomer.body.safeParse(signUpCustomer.examples?.request).success).toBe(true);
  });

  it('refuses on lastName two names that together pass the 120 characters of an account name (the review, S4)', () => {
    expect(fieldsOf({ ...form, firstName: 'x'.repeat(60), lastName: 'y'.repeat(59) })).toEqual([]);
    expect(fieldsOf({ ...form, firstName: 'x'.repeat(60), lastName: 'y'.repeat(60) })).toEqual(['lastName']);
  });

  it('refuses invisible direction marks in the names and tabs or marks in the phone (the review, S4)', () => {
    expect(fieldsOf({ ...form, firstName: 'Dan\u202eiel' })).toEqual(['firstName']);
    expect(fieldsOf({ ...form, lastName: 'Whit\u2066more' })).toEqual(['lastName']);
    expect(fieldsOf({ ...form, phone: '+44\t7700900123' })).toEqual(['phone']);
    expect(fieldsOf({ ...form, phone: '+44\u200f7700900123' })).toEqual(['phone']);
  });
});

describe('POST /store/v1/auth/sign-up/finish', () => {
  const form = {
    password: 'a-long-password',
    firstName: ' Daniel ',
    lastName: 'Whitmore',
    country: 'jo',
    phone: '+962 79 123 4567',
  };
  const fieldsOf = (body: unknown): string[] => {
    const parsed = finishCustomerSignUp.body.safeParse(body);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')).sort();
  };

  it('is a session route of the retail rank, with CSRF, at the active step, answering the account', () => {
    expect(finishCustomerSignUp.access).toBe('customer-session');
    expect(finishCustomerSignUp.rank).toBe('retail');
    expect(finishCustomerSignUp.csrf).not.toBe(false);
    expect(finishCustomerSignUp.sessionStages).toEqual(['active']);
    expect(finishCustomerSignUp.success.status).toBe(200);
    expect(finishCustomerSignUp.errors).toEqual(expect.arrayContaining(['WEAK_PASSWORD', 'CONFLICT', 'RATE_LIMITED']));
    expect(finishCustomerSignUp.success.schema.safeParse(finishCustomerSignUp.examples?.response).success).toBe(true);
  });

  it('has exactly the rules of the sign-up, without the email', () => {
    expect(finishCustomerSignUp.body.parse(form)).toEqual({
      password: 'a-long-password',
      firstName: 'Daniel',
      lastName: 'Whitmore',
      country: 'JO',
      phone: '+962791234567',
    });
    expect(fieldsOf({})).toEqual(['country', 'firstName', 'lastName', 'password', 'phone']);
    expect(fieldsOf({ ...form, lastName: 'Whit\nmore' })).toEqual(['lastName']);
    expect(fieldsOf({ ...form, firstName: 'x'.repeat(60), lastName: 'y'.repeat(60) })).toEqual(['lastName']);
    expect(fieldsOf({ ...form, phone: '12-34' })).toEqual(['phone']);
    expect(fieldsOf({ ...form, country: 'GBR' })).toEqual(['country']);
    expect(finishCustomerSignUp.body.safeParse(finishCustomerSignUp.examples?.request).success).toBe(true);
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
