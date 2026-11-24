// Route contracts of the two-step sign-in of a retail account (decision 064; routes beyond the map, scripts/map-additions/48-accounts.mjs):
// POST /store/v1/me/2fa/setup, /enable and /disable. They run the use case of `/client/security/2fa/*` (one authenticator setup for every
// account with a password), so the shop offers two-step sign-in to a retail account on its own family of routes. The shop is their caller.
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';

/** The six digits of an authenticator code. */
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') });

/** What the setup screen shows: the key to type, the link behind the QR code, and the QR code itself. */
const TwoFactorSetupSchema = z.object({ secret: z.string(), otpauthUrl: z.string(), qrSvg: z.string() });

/** The errors every one of the three routes can answer. */
const COMMON_ERRORS = [
  'UNAUTHORIZED',
  'ACCOUNT_SUSPENDED',
  'IP_NOT_ALLOWED',
  'CSRF_FAILED',
  'CONFLICT',
  'RATE_LIMITED',
] as const;

/** `POST /store/v1/me/2fa/setup`: a new pending authenticator secret with a QR code. */
export const storeSetupTwoFactor = defineRoute({
  key: 'POST /store/v1/me/2fa/setup',
  summary: 'A new authenticator secret with a QR code',
  description:
    'Stores the secret as pending (two-step sign-in stays off) and answers it once. Every call replaces the pending secret; ' +
    '`POST /store/v1/me/2fa/enable` confirms it with a code. It is the same use case as `POST /client/security/2fa/setup`. Two-step sign-in can be ' +
    'switched on only for a confirmed email address: while the email is not confirmed yet the call is `409 CONFLICT` and nothing is stored. ' +
    'An account that has no password yet is `409 CONFLICT` too ("Choose a password first."): two-step sign-in is for an account that signs in ' +
    'with a password; a link-only account gets its first password from a mailed link.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  success: { status: 200, schema: TwoFactorSetupSchema },
  errors: [...COMMON_ERRORS, 'TWOFA_ALREADY_ENABLED'],
  examples: {
    response: {
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUrl:
        'otpauth://totp/IMEI-HUB:daniel.whitmore%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=IMEI-HUB',
      qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"></svg>',
    },
  },
});

/** `POST /store/v1/me/2fa/enable`: confirms the pending secret with a code. */
export const storeEnableTwoFactor = defineRoute({
  key: 'POST /store/v1/me/2fa/enable',
  summary: 'Turn on two-step sign-in after confirming a code',
  description:
    "Turns two-step sign-in on and ends the account's other sessions (this one stays). The same use case as " +
    '`POST /client/security/2fa/enable`: `409 CONFLICT` for an account without a password or with an unconfirmed email, `422` on `code` for a ' +
    'wrong or used code.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  body: CodeBody,
  success: { status: 204 },
  errors: [...COMMON_ERRORS, 'VALIDATION_FAILED', 'TWOFA_ALREADY_ENABLED'],
  examples: { request: { code: '123456' } },
});

/** `POST /store/v1/me/2fa/disable`: turns two-step sign-in off with a current code. */
export const storeDisableTwoFactor = defineRoute({
  key: 'POST /store/v1/me/2fa/disable',
  summary: 'Turn off two-step sign-in with a code',
  description:
    "Turns two-step sign-in off, forgets the secret and ends the account's other sessions (this one stays). The same use case as " +
    '`POST /client/security/2fa/disable`. A code that was just used to sign in is refused; wait for the next one.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  body: CodeBody,
  success: { status: 204 },
  errors: [...COMMON_ERRORS, 'VALIDATION_FAILED', 'TWOFA_NOT_ENABLED'],
  examples: { request: { code: '123456' } },
});
