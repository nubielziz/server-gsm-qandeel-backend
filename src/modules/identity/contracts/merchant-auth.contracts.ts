// Route contracts of the merchant portal's sign-in (map domain A, routes /client/auth/*, stage 2): register, verify email,
// login, the TOTP step, logout, the password links and "me". No console screen calls them (the portal is another frontend):
// the shapes follow docs/contract/MISMATCHES.md B121 to B129 and ALIGNMENT § 7.
import { z } from 'zod';
import { defineRoute, zDecimal, zId, zIsoDateTime } from '../../../common/contract';

/** What the portal does after the password: type a code, or the sign-in is complete (B124). */
export const MerchantNext = z.enum(['totp', 'done']);

/** The email of a merchant: trimmed, lower-cased and shaped like an address (the account email is case-insensitive). */
export const MerchantEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** The six digits of an authenticator code. */
export const MerchantCode = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') });

/** An ISO 3166 alpha-2 country, written in upper case on the way in. */
export const MerchantCountry = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code, like JO.')
  .toUpperCase();

/**
 * The registration form (B122).
 *
 * Why: the password's upper bound only keeps oversize input out; the policy itself is the server's (`WEAK_PASSWORD`).
 */
const RegisterBody = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(120),
  email: MerchantEmail,
  password: z.string().min(1).max(1024),
  company: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(40).optional(),
  country: MerchantCountry,
  referralCode: z.string().trim().min(1).max(32).optional(),
});

const LoginBody = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
});

/** The merchant's own account (B129). */
export const MerchantMeShape = z.object({
  id: zId,
  username: z.string(),
  email: z.string(),
  name: z.string(),
  company: z.string(),
  phone: z.string(),
  country: z.string(),
  status: z.enum(['pending', 'active', 'suspended']),
  kycStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  emailVerifiedAt: zIsoDateTime.nullable(),
  twofaEnabled: z.boolean(),
  referralCode: z.string(),
  group: z.object({ id: zId, name: z.string(), discountPercent: zDecimal }),
  createdAt: zIsoDateTime,
});

/** An example `Me` for the docs. */
export const MERCHANT_ME_EXAMPLE = {
  id: 12,
  username: 'ali48213',
  email: 'ali@example.com',
  name: 'Ali Hassan',
  company: 'Hassan Mobile',
  phone: '+962791234567',
  country: 'JO',
  status: 'pending',
  kycStatus: 'none',
  emailVerifiedAt: null,
  twofaEnabled: false,
  referralCode: 'GSM7K2QXD',
  group: { id: 1, name: 'Standard', discountPercent: '0.0000' },
  createdAt: '2026-11-01T09:30:00.000Z',
} as const;

/** `POST /client/auth/register`: a visitor becomes a pending merchant; the answer never says whether the email was known. */
export const merchantRegister = defineRoute({
  key: 'POST /client/auth/register',
  summary: 'Register a new merchant',
  description:
    'Answers `204` for a new and for an already registered email alike, so it cannot be used to find out who is registered. A ' +
    'new email creates a merchant that is `pending` until staff approve it, opens its wallet, and sends the verification email. ' +
    'An existing email changes nothing and sends nothing. Counted per address, whether or not the email exists.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: RegisterBody,
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'WEAK_PASSWORD', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: {
    request: {
      name: 'Ali Hassan',
      email: 'ali@example.com',
      password: 'a-long-password',
      company: 'Hassan Mobile',
      phone: '+962791234567',
      country: 'JO',
      referralCode: 'GSM0001',
    },
  },
});

/** `POST /client/auth/verify-email`: the link of the verification email. */
export const merchantVerifyEmail = defineRoute({
  key: 'POST /client/auth/verify-email',
  summary: 'Verify the email with the token',
  description:
    'Marks the email verified. The status stays `pending` until staff approve the merchant, and the call signs nobody in.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: z.object({ token: z.string().min(1).max(512) }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'TOKEN_INVALID', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: { request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM' } },
});

/** `POST /client/auth/login`: email and password; answers whether a code follows and opens the session. */
export const merchantLogin = defineRoute({
  key: 'POST /client/auth/login',
  summary: 'Sign in',
  description:
    'Opens a session: `pending_totp` (10 minutes) when the merchant has two-factor sign-in on, a full one otherwise. A merchant ' +
    'waiting for approval signs in too (it can read its status and manage its own account). One `401` answers an unknown email, ' +
    'a wrong password and a merchant with no password yet.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: LoginBody,
  success: { status: 200, schema: z.object({ next: MerchantNext }) },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: {
    request: { email: 'ali@example.com', password: 'a-long-password' },
    response: { next: 'totp' },
  },
});

/** `POST /client/auth/2fa`: the authenticator code; opens the full session. */
export const merchantVerifyTwoFactor = defineRoute({
  key: 'POST /client/auth/2fa',
  summary: 'Complete the sign-in with a TOTP code',
  description:
    'The last sign-in step of a merchant with two-factor sign-in on: it turns the pending session into a full one (a new session ' +
    'token). Needs the `X-CSRF-Token` of the pending session.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  sessionStages: ['pending_totp'],
  pendingMerchant: 'allow',
  body: MerchantCode,
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: { request: { code: '123456' } },
});

/** `POST /client/auth/logout`: ends the session whatever step it is at. */
export const merchantLogout = defineRoute({
  key: 'POST /client/auth/logout',
  summary: 'Sign out and end the session',
  description: 'Ends the session and clears both cookies. A `401` here counts as a successful sign-out for the portal.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  sessionStages: ['pending_totp', 'active'],
  pendingMerchant: 'allow',
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED'],
});

/** `POST /client/auth/password/forgot`: sends a reset link; the same answer for every email. */
export const merchantForgotPassword = defineRoute({
  key: 'POST /client/auth/password/forgot',
  summary: 'Send a password reset link',
  description:
    'Answers `204` whether or not the email belongs to a merchant. A merchant that is not suspended, including one waiting for ' +
    'approval that has no password yet, gets a link valid for one hour; a newer link replaces an older one.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: z.object({ email: MerchantEmail }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: { request: { email: 'ali@example.com' } },
});

/** `POST /client/auth/password/reset`: a new password from a reset or invite link. */
export const merchantResetPassword = defineRoute({
  key: 'POST /client/auth/password/reset',
  summary: 'Set a new password with the reset token',
  description:
    'Accepts a reset link and the invitation link of a merchant that staff created. It sets the password, uses the link up, ends ' +
    'every session of the merchant and signs nobody in; an invitation also marks the email verified. The status stays `pending` ' +
    'until staff approve the merchant. A weak password does not use the link up.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: z.object({ token: z.string().min(1).max(512), password: z.string().min(1).max(1024) }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'WEAK_PASSWORD', 'TOKEN_INVALID', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: { request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM', password: 'a-long-new-password' } },
});

/** `GET /client/auth/me`: the merchant's account, approval status and group. */
export const merchantMe = defineRoute({
  key: 'GET /client/auth/me',
  summary: "The merchant's details and client group",
  description:
    'Full sessions only. Works for a merchant waiting for approval: `status` says `pending`. Never cached, and repeats the CSRF ' +
    'token in the `X-CSRF-Token` header (the first call after every reload).',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  success: { status: 200, schema: MerchantMeShape },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'],
  examples: { response: MERCHANT_ME_EXAMPLE },
});
