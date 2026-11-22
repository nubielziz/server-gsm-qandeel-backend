// Route contracts of the storefront customer's sign-in (map domain I, stage 14, routes /store/v1/auth/* and /store/v1/me/password):
// sign-in link, link exchange, password sign-in, password reset by email, choosing a password and sign-out. The storefront is
// another frontend, so these shapes are the specs of docs/contract/MISMATCHES.md (feature 14b) and ALIGNMENT § 7.
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';
import { EmailField } from './shared';
import { StoreMeSchema, STORE_ME_EXAMPLE } from './store-account.contracts';

/** What the storefront does after the password: choose a new one (temporary password), or the sign-in is complete. */
export const StoreNext = z.enum(['password', 'done']);

const TokenField = z.string().min(1).max(512);

/** The answer of `POST /store/v1/auth/verify`: the customer's own details, whether this browser asked for the link, and whose account it opened. */
export const StoreVerifySchema = StoreMeSchema.extend({
  requestedHere: z
    .boolean()
    .describe(
      'True when this browser asked for the link (it carries the cookie of `POST /store/v1/auth/magic-link`); false for a link asked ' +
        'for in another browser or sent by the shop: the shop then shows whose account was opened (`maskedEmail`).',
    ),
  maskedEmail: z.string().describe('The address of the account the link opened, masked (`da•••@example.com`).'),
});

/** `POST /store/v1/auth/magic-link`. */
export const requestMagicLink = defineRoute({
  key: 'POST /store/v1/auth/magic-link',
  summary: 'Email a sign-in link',
  description:
    'Answers `204` whatever the email is, so it cannot be used to find out who has an account. An email the store does not know ' +
    'yet becomes a customer (self-signup); a suspended, blocked or anonymized customer, and a blocklisted email, get nothing. ' +
    'The link is valid one hour and works once; up to three such links work at once (a fourth replaces the oldest), and at most ' +
    'five are mailed an hour per customer; a request beyond that answers `204` and sends nothing. Counted per network and email, ' +
    'whether or not the email exists. Needs the anti-bot token (`X-Turnstile-Token`). Every answer sets an HttpOnly cookie that ' +
    'lives as long as the link and marks the browser that asked for it (`POST /store/v1/auth/verify` reads it).',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  csrf: false,
  body: z.object({ email: EmailField }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: { request: { email: 'daniel.whitmore@example.com' } },
});

/** `POST /store/v1/auth/verify`. */
export const verifyMagicLink = defineRoute({
  key: 'POST /store/v1/auth/verify',
  summary: 'Exchange a sign-in link for a session',
  description:
    'Spends the link (single use), marks the email verified on first use, turns the customer into an account holder and opens a ' +
    'session: the cookies and the `X-CSRF-Token` header come with the answer, which is the customer’s own details plus ' +
    '`requestedHere` and `maskedEmail`. In the browser that asked for the link (the cookie of `POST /store/v1/auth/magic-link`) ' +
    'it signs in as before (`requestedHere` true). Anywhere else, while the browser holds a live session of another customer, it is ' +
    '`409 CONFLICT` (sign out first): that session stays and the link is not spent; in a browser without such a session it signs in ' +
    'with `requestedHere` false, and the shop shows whose account was opened. A link that ' +
    'is unknown, used, expired or replaced, or belongs to a suspended customer, is `410 TOKEN_INVALID`. The verification link ' +
    'sent after an email change works the same way (it is never asked for in a browser). Accepted only with an `Origin` header ' +
    'that is one of the shop’s origins, like the public `/client` sign-in routes (`403 CSRF_FAILED` otherwise).',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'link-token',
  csrf: false,
  originCheck: true,
  body: z.object({ token: TokenField }),
  success: { status: 200, schema: StoreVerifySchema },
  errors: ['VALIDATION_FAILED', 'TOKEN_INVALID', 'CONFLICT', 'IP_NOT_ALLOWED', 'RATE_LIMITED', 'CSRF_FAILED'],
  examples: {
    request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM' },
    response: { ...STORE_ME_EXAMPLE, requestedHere: true, maskedEmail: 'da•••@example.com' },
  },
});

/** `POST /store/v1/auth/login`. */
export const loginCustomer = defineRoute({
  key: 'POST /store/v1/auth/login',
  summary: 'Sign in with email and password',
  description:
    'Opens a session: a full one, or a `pending_password` one when the customer must change a temporary password first (`next` ' +
    '`password`: only `POST /store/v1/me/password` and logout work until then). One `401` answers an unknown email, a wrong ' +
    'password and an account with no password yet. A correct password on a suspended or blocked account is `403 ' +
    'ACCOUNT_SUSPENDED`. Five attempts per email and network in 15 minutes, and ten failed attempts (a success in between does not cancel them) lock the email ' +
    '(known or not, so the answer never shows who has an account) for 15 minutes for every network its account has not signed in ' +
    'from: both answer `429 RATE_LIMITED` with `Retry-After`. While the lock runs, the attempts a network the account has signed in from is ' +
    'still allowed share one budget per network: five in 15 minutes, then `429 RATE_LIMITED` like any other attempt. A temporary password works for 72 hours after it was set; after that ' +
    'it is refused like a wrong password. ' +
    'Needs the anti-bot token (`X-Turnstile-Token`). Accepted only with an `Origin` header that is one of the shop’s origins, like the ' +
    'public `/client` sign-in routes (`403 CSRF_FAILED` otherwise).',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  csrf: false,
  originCheck: true,
  body: z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(1024) }),
  success: { status: 200, schema: z.object({ next: StoreNext }) },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'RATE_LIMITED', 'CSRF_FAILED'],
  examples: {
    request: { email: 'daniel.whitmore@example.com', password: 'a-long-password' },
    response: { next: 'done' },
  },
});

/** `POST /store/v1/auth/password/forgot`. */
export const forgotCustomerPassword = defineRoute({
  key: 'POST /store/v1/auth/password/forgot',
  summary: 'Send a password reset link',
  description:
    'Answers `204` whether or not the email belongs to an account, so no registered email is revealed. An account that is active ' +
    'gets a link valid one hour that works once; up to three such links work at once (a fourth replaces the oldest), and at most ' +
    'five are mailed an hour per customer; a request beyond that answers `204` and sends nothing. Needs the anti-bot token ' +
    '(`X-Turnstile-Token`).',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  csrf: false,
  body: z.object({ email: EmailField }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: { request: { email: 'daniel.whitmore@example.com' } },
});

/** `POST /store/v1/auth/password/set`. */
export const setCustomerPasswordByLink = defineRoute({
  key: 'POST /store/v1/auth/password/set',
  summary: 'Choose a password with an invitation or reset link',
  description:
    'Accepts the invitation of an account that staff created and a reset link. It sets the password, uses the link up, ends ' +
    'every session of the customer and signs nobody in; an invitation also marks the email verified. A weak password does not ' +
    'use the link up (`422 WEAK_PASSWORD` on `password`); an unknown, used, expired or replaced link, or a suspended customer, ' +
    'is `410 TOKEN_INVALID`.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'link-token',
  csrf: false,
  body: z.object({ token: TokenField, password: z.string().min(1).max(1024) }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'WEAK_PASSWORD', 'TOKEN_INVALID', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: { request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM', password: 'a-long-new-password' } },
});

/** `POST /store/v1/me/password`. */
export const changeMyPassword = defineRoute({
  key: 'POST /store/v1/me/password',
  summary: 'Change my password',
  description:
    'Needs the current password (a wrong one is `422` on `currentPassword`, never `401`). Ends the other devices and keeps this ' +
    'session; a `pending_password` session (after a temporary password) becomes a full one with new cookies. `422 ' +
    'WEAK_PASSWORD` on `newPassword` for a weak password or the one in use. Five tries per account in 15 minutes.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'customer-session',
  sessionStages: ['pending_password', 'active'],
  body: z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) }),
  success: { status: 204 },
  errors: [
    'VALIDATION_FAILED',
    'WEAK_PASSWORD',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'CSRF_FAILED',
    'IP_NOT_ALLOWED',
    'RATE_LIMITED',
  ],
  examples: { request: { currentPassword: 'Hk7mQ2wPzR9tNx', newPassword: 'a-long-new-password' } },
});

/** `POST /store/v1/auth/logout`. */
export const logoutCustomer = defineRoute({
  key: 'POST /store/v1/auth/logout',
  summary: 'Sign out and end the session',
  description: 'Ends the session whatever step it is at and clears both cookies.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'customer-session',
  sessionStages: ['pending_password', 'active'],
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED', 'IP_NOT_ALLOWED'],
});
