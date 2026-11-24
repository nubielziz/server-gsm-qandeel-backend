// Route contracts of the sign-in family `/client/auth/*` (map domain A, stage 2; decision 064): verify email, login (an alias of the one
// sign-in), the code step, logout, the password links and "me". The routes serve every account where they say so (the rank marks below); the
// merchant portal and the shop call them. The shapes follow docs/contract/MISMATCHES.md B121 to B129 and ALIGNMENT § 7.
import { z } from 'zod';
import { defineRoute, zDecimal, zId, zIsoDateTime } from '../../../common/contract';
import { CLIENT_STATUSES } from '../db/schema';

/**
 * What the caller does after the password: choose a new one (staff set a temporary password, feature 20), type a code, or the sign-in is
 * complete (B124).
 */
export const MerchantNext = z.enum(['password', 'totp', 'done']);

/** The email of an account: trimmed, lower-cased and shaped like an address (the account email is case-insensitive). */
export const MerchantEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** The six digits of an authenticator code. */
export const MerchantCode = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') });

/** An ISO 3166 alpha-2 country, written in upper case on the way in. */
export const MerchantCountry = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code, like JO.')
  .toUpperCase();

const LoginBody = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
});

/**
 * The account of the signed-in caller, as `GET /client/auth/me` and `GET /store/v1/me` answer it.
 *
 * Why: one shape for every rank (decision 064), so the shop reads the same keys from either family: the rank says which area it shows.
 * `username` and `company` are empty text when the account has none (a retail account has no username), never `null`. The store route
 * declares the same keys (`StoreMeSchema` of the customers module); a test keeps the two equal.
 */
export const AccountMeShape = z.object({
  id: zId,
  name: z.string(),
  email: z.string(),
  status: z.enum(CLIENT_STATUSES),
  rank: z.object({
    id: zId,
    name: z.string(),
    kind: z.enum(['retail', 'merchant']),
    discountPercent: zDecimal,
  }),
  hasPassword: z
    .boolean()
    .describe('True once the account has a password; false for an account that signs in by link.'),
  /** True after staff set a temporary password and until the owner chooses one: the shop sends them to the change form. */
  mustChangePassword: z.boolean(),
  twofaEnabled: z.boolean(),
  currency: z
    .string()
    .nullable()
    .describe('The ISO code of the currency prices are shown in; null when none is chosen.'),
  marketingOptIn: z.boolean(),
  company: z.string(),
  username: z.string().describe('The Dhru username of a merchant rank; empty for a retail account.'),
  phone: z.string(),
  country: z.string(),
  address: z.string(),
  taxId: z.string(),
  emailVerifiedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

/** An example `AccountMe` of a merchant rank for the docs. */
export const ACCOUNT_ME_EXAMPLE = {
  id: 12,
  name: 'Ali Hassan',
  email: 'ali@example.com',
  status: 'active',
  rank: { id: 1, name: 'Standard', kind: 'merchant', discountPercent: '0.0000' },
  hasPassword: true,
  mustChangePassword: false,
  twofaEnabled: false,
  currency: null,
  marketingOptIn: false,
  company: 'Hassan Mobile',
  username: 'ali48213',
  phone: '+962791234567',
  country: 'JO',
  address: '',
  taxId: '',
  emailVerifiedAt: null,
  createdAt: '2026-11-01T09:30:00.000Z',
} as const;

/** `POST /client/auth/verify-email`: the link of the verification email. */
export const merchantVerifyEmail = defineRoute({
  key: 'POST /client/auth/verify-email',
  summary: 'Verify the email with the token',
  description:
    'Marks the email verified for any account, and the call signs nobody in. The address and ' +
    'the holder of the password prove the account together: when the request carries no full session of that account, the password ' +
    'chosen before stops working, two-step sign-in is turned off, every session of the account ends and the address gets the ' +
    'password-reset mail to choose a new one. ' +
    'A full session of the account without its `X-CSRF-Token` is `403 CSRF_FAILED` and leaves the link usable. ' +
    'A link of an account that may not act (suspended, blocked or anonymized) is `410 TOKEN_INVALID`.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: z.object({ token: z.string().min(1).max(512) }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'TOKEN_INVALID', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: { request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM' } },
});

/**
 * `POST /client/auth/login`: email and password; answers whether a code follows and opens the session.
 *
 * Why: the map's own sign-in route stays as an alias of the one sign-in use case (`POST /client/auth/sign-in`) and answers only `next`;
 * the contract release retires it.
 */
export const merchantLogin = defineRoute({
  key: 'POST /client/auth/login',
  summary: 'Sign in',
  description:
    'An alias of `POST /client/auth/sign-in`: the same use case, the same budget and the same lock, answering only `next`. It opens a ' +
    'session: `pending_password` (10 minutes) when staff set a temporary password that is not replaced yet (`next: password`: ' +
    'the caller shows a new-password form and calls `POST /client/auth/password/change`), `pending_totp` (10 minutes) when the ' +
    'account has two-factor sign-in on, a full one otherwise. One `401` answers an unknown email, ' +
    'a wrong password and an account with no password yet.' +
    ' Five attempts per email and network (an IPv4 address or an IPv6 /64) in 15 minutes; ten failed attempts for one email (a success in between does not cancel them) lock it for 15 minutes for every network its account has not signed in from (the lock is shared with `POST /store/v1/auth/login` and `POST /client/auth/sign-in`): both answer `429 RATE_LIMITED` with `Retry-After`, the same for every email.' +
    ' While the lock runs, the attempts a network the account has signed in from is still allowed share one budget per network: five in 15 minutes, then `429 RATE_LIMITED` like any other attempt.' +
    ' A temporary password works for 72 hours after it was set; after that it is refused like a wrong password.' +
    ' Send `X-Turnstile-Token`: production requires it (`TURNSTILE_MERCHANT_AUTH`, on by default there).',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  turnstile: true,
  turnstileRollout: 'merchant-auth',
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
    'The last sign-in step of an account with two-factor sign-in on, of any rank: it turns the pending session into a full one (a new ' +
    'session token). Needs the `X-CSRF-Token` of the pending session. Twenty wrong codes of one account within 24 hours close the step: ' +
    'every code, the right one included, is then refused with `429 RATE_LIMITED`, whose `Retry-After` is the seconds until it ' +
    'opens. The step opens again after 24 hours (counted from the first wrong code), or sooner with a password link (reset or ' +
    'invitation) or a 2FA reset by staff (also a temporary password from staff); a correct code never resets the count.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  rank: 'any',
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
  description:
    'The one sign-out of every account, whatever its rank and whatever step the session is at. It ends the session and clears the session ' +
    'cookie, both CSRF cookies and the shop cookie of the time before accounts became one. A `401` here counts as a successful sign-out for the caller.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  rank: 'any',
  sessionStages: ['pending_password', 'pending_totp', 'active'],
  pendingMerchant: 'allow',
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED'],
});

/** `POST /client/auth/password/change`: replaces a temporary password during the sign-in (feature 20). */
export const merchantChangeTemporaryPassword = defineRoute({
  key: 'POST /client/auth/password/change',
  summary: 'Replace a temporary password',
  description:
    'The sign-in step after `next: password`, for an account of any rank: the pending session (needs its `X-CSRF-Token`) sets the password ' +
    'the account keeps. It ends every other session of the account, cancels open password links and continues the same sign-in: the ' +
    'answer is `{ next: totp }` when two-factor sign-in is on (continue with `POST /client/auth/2fa`) or `{ next: done }`; both come with new ' +
    'session cookies and a new `X-CSRF-Token`. `422 WEAK_PASSWORD` on `password` also when it is the password in use; `401` when ' +
    'the session is not a pending password step or the account no longer needs the change (sign in again).',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  rank: 'any',
  sessionStages: ['pending_password'],
  pendingMerchant: 'allow',
  body: z.object({ password: z.string().min(1).max(1024) }),
  success: { status: 200, schema: z.object({ next: z.enum(['totp', 'done']) }) },
  errors: [
    'VALIDATION_FAILED',
    'WEAK_PASSWORD',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
    'RATE_LIMITED',
  ],
  examples: { request: { password: 'a-long-new-password' }, response: { next: 'done' } },
});

/** `POST /client/auth/verify-email/resend`: a new verification email for the signed-in merchant (feature 20). */
export const merchantResendVerification = defineRoute({
  key: 'POST /client/auth/verify-email/resend',
  summary: 'Resend the verification email',
  description:
    'Emails the signed-in merchant a new one-hour verification link; it replaces the older one. `409 CONFLICT` when the email is already verified (refresh `me`), `429` after five mails an hour. There is no public ' +
    'resend route.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'CONFLICT', 'RATE_LIMITED'],
});

/** `POST /client/auth/password/forgot`: sends a reset link; the same answer for every email. */
export const merchantForgotPassword = defineRoute({
  key: 'POST /client/auth/password/forgot',
  summary: 'Send a password reset link',
  description:
    'The one forgot-password route of every account. Answers `204` whether or not the email belongs to an account with a login. An account that ' +
    'may act (it is active), including one that has ' +
    'no password yet, gets a link valid for one hour; up to three such links work at once (a fourth replaces the ' +
    'oldest), and at most five are mailed an hour per account; a request beyond that answers `204` and sends nothing. A guest, a suspended, ' +
    'blocked or anonymized account stays silent.' +
    ' Send `X-Turnstile-Token`: it is always required (the merchant rollout switch does not govern this route).',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  turnstile: true,
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
    'Accepts a reset link and the invitation link of an account that staff created, of any rank. It sets the password, uses the link up, ends ' +
    'every session of the account and signs nobody in; an invitation also marks the email verified. A weak ' +
    'password does not use the link up. On an account whose email is not verified yet it ' +
    'also turns two-factor sign-in off. A link of an account that may not act (suspended, blocked or anonymized) is `410 TOKEN_INVALID`.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: z.object({ token: z.string().min(1).max(512), password: z.string().min(1).max(1024) }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'WEAK_PASSWORD', 'TOKEN_INVALID', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: { request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM', password: 'a-long-new-password' } },
});

/** `GET /client/auth/me`: the merchant's account and rank, as `AccountMe`. */
export const merchantMe = defineRoute({
  key: 'GET /client/auth/me',
  summary: "The merchant's account and rank",
  description:
    'Full sessions only. Answers `AccountMe`, the same keys as `GET /store/v1/me`: the account and its rank (`rank.kind` is `merchant` here). ' +
    '`username` and `company` are empty text when the account has none. A retail account reads its own account from `GET /store/v1/me`: ' +
    'here it is `403 RANK_NOT_ALLOWED`. Never cached, and repeats the CSRF ' +
    'token in the `X-CSRF-Token` header (the first call after every reload).',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  success: { status: 200, schema: AccountMeShape },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'],
  examples: { response: ACCOUNT_ME_EXAMPLE },
});
