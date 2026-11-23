// Route contracts of the staff sign-in (map domain A, routes /admin/auth/*, stage 2): login, the TOTP steps, the password
// set, logout and "me". Shapes match what the console sends and reads (docs/contract/endpoints/identity.md, ALIGNMENT § 3).
import { z } from 'zod';
import { defineRoute, zId, zIsoDateTime } from '../../../common/contract';

/** Where the sign-in goes after the password (what the console's `LoginResult.next` accepts). */
export const SignInNext = z.enum(['totp', 'totp_setup', 'password']);

/** The email and password of the first sign-in step. */
const LoginBody = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
});

/** The six digits of an authenticator code. */
const TwoFactorBody = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') });

/** What the setup screen shows: the key to type, the link behind the QR code, and the QR code itself. */
const TwoFactorSetup = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrSvg: z.string(),
});

/**
 * The password to choose and, for an emailed link, its token.
 *
 * Why: B3: the same route serves the link (`token`) and the forced change after a temporary password (no token). The upper
 * bound only keeps oversize input out; the policy itself is the server's (`WEAK_PASSWORD`).
 */
const SetPasswordBody = z.object({
  token: z.string().min(1).max(512).optional(),
  password: z.string().min(1).max(1024),
});

/** The signed-in staff member, for the console's identity and permission gates. */
const Me = z.object({
  id: zId,
  email: z.string(),
  name: z.string(),
  status: z.enum(['invited', 'active', 'suspended']),
  role: z.object({ id: zId, name: z.string() }),
  permissions: z.array(z.string()),
  twofaEnabled: z.boolean(),
  mustChangePassword: z.boolean(),
  lastLoginAt: zIsoDateTime.nullable(),
  lastLoginIp: z.string().nullable(),
});

const SIGN_IN_STAGES = ['pending_password', 'pending_totp_setup', 'pending_totp', 'active'] as const;

/** `POST /admin/auth/login`: email and password; answers the next step and opens a pending session. */
export const staffLogin = defineRoute({
  key: 'POST /admin/auth/login',
  summary: 'Sign in with email and password',
  description:
    'The first sign-in step. It creates a pending session (10 minutes) and answers which step follows. A failed attempt is ' +
    'logged and rate-limited but writes no audit row; the sign-in is audited when the second step completes.' +
    ' Five attempts per email and network (an IPv4 address or an IPv6 /64) in 15 minutes; ten failed attempts for one email (a success in between does not cancel them) lock it for 15 minutes for every network its account has not signed in from: both answer `429 RATE_LIMITED` with `Retry-After`, the same for every email.' +
    ' While the lock runs, the attempts a network the account has signed in from is still allowed share one budget per network: five in 15 minutes, then `429 RATE_LIMITED` like any other attempt.' +
    ' A temporary password works for 72 hours after it was set; after that it is refused like a wrong password.',
  tags: ['auth'],
  surface: 'admin',
  access: 'public',
  csrf: false,
  audit: false,
  body: LoginBody,
  success: { status: 200, schema: z.object({ next: SignInNext }) },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: {
    request: { email: 'rami@gsm-supply.example', password: 'a-long-password' },
    response: { next: 'totp' },
  },
});

/** `POST /admin/auth/2fa`: the authenticator code; opens the full session. */
export const staffVerifyTwoFactor = defineRoute({
  key: 'POST /admin/auth/2fa',
  summary: 'Complete the sign-in with a TOTP code',
  description:
    'The last sign-in step: it turns the pending session into a full one (a new session token). The sign-in is recorded in the ' +
    'audit log by this step. Twenty wrong codes of one account within 24 hours close the step: every code, the right one included, ' +
    'is then refused with `429 RATE_LIMITED`, whose `Retry-After` is the seconds until it opens. The step opens again after 24 hours ' +
    '(counted from the first wrong code), or sooner with a password link or a 2FA reset (also a temporary password), from a member ' +
    'allowed to manage the account; the closing is audited, and a correct code never resets the count.',
  tags: ['auth'],
  surface: 'admin',
  access: 'staff-session',
  sessionStages: ['pending_totp', 'pending_totp_setup'],
  body: TwoFactorBody,
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: { request: { code: '123456' } },
});

/** `POST /admin/auth/2fa/setup`: a fresh pending TOTP secret for a member who has none. */
export const staffSetupTwoFactor = defineRoute({
  key: 'POST /admin/auth/2fa/setup',
  summary: 'Start the authenticator setup',
  description:
    'Only for a pending session whose account has two-factor sign-in off. Every call replaces the pending secret. It writes ' +
    'no audit row: the secret is not active until the first code confirms it, and that step is audited.',
  tags: ['auth'],
  surface: 'admin',
  access: 'staff-session',
  sessionStages: ['pending_totp_setup'],
  audit: false,
  success: { status: 200, schema: TwoFactorSetup },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED', 'TWOFA_ALREADY_ENABLED', 'RATE_LIMITED'],
  examples: {
    response: {
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUrl:
        'otpauth://totp/IMEI-HUB:rami%40gsm-supply.example?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=IMEI-HUB',
      qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"></svg>',
    },
  },
});

/** `POST /admin/auth/logout`: ends the session whatever step it is at. */
export const staffLogout = defineRoute({
  key: 'POST /admin/auth/logout',
  summary: 'Sign out',
  description:
    'Ends the session and clears both cookies. A full session writes a "logged out" audit row; a pending sign-in step ends ' +
    'without one, since nobody was signed in.',
  tags: ['auth'],
  surface: 'admin',
  access: 'staff-session',
  sessionStages: [...SIGN_IN_STAGES],
  audit: false,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED'],
});

/** `GET /admin/auth/me`: the signed-in member. */
export const staffMe = defineRoute({
  key: 'GET /admin/auth/me',
  summary: 'The signed-in staff member',
  description: 'Full sessions only. The answer is never cached and repeats the CSRF token in the X-CSRF-Token header.',
  tags: ['auth'],
  surface: 'admin',
  access: 'staff-session',
  success: { status: 200, schema: Me },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'],
  examples: {
    response: {
      id: 1,
      email: 'rami@gsm-supply.example',
      name: 'Rami K.',
      status: 'active',
      role: { id: 1, name: 'Owner' },
      permissions: ['*'],
      twofaEnabled: true,
      mustChangePassword: false,
      lastLoginAt: '2026-10-31T09:30:00.000Z',
      lastLoginIp: '203.0.113.24',
    },
  },
});

/** `POST /admin/auth/password/set`: a new password from an emailed link or after a temporary password. */
export const staffSetPassword = defineRoute({
  key: 'POST /admin/auth/password/set',
  summary: 'Choose a new password',
  description:
    'With `token`: the one-time link of an invitation or a reset (no session). Without it: the forced change on a ' +
    '`pending_password` session. Neither signs the member in; every session of the account ends.',
  tags: ['auth'],
  surface: 'admin',
  access: 'public',
  csrf: false,
  body: SetPasswordBody,
  success: { status: 204 },
  errors: [
    'VALIDATION_FAILED',
    'WEAK_PASSWORD',
    'TOKEN_INVALID',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'CSRF_FAILED',
    'RATE_LIMITED',
  ],
  examples: { request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM', password: 'a-long-new-password' } },
});
