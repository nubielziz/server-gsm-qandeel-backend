// Route contracts of the merchant portal's account area (map domain A, stage 2): profile, password, two-factor sign-in and the
// merchant's own sessions. Shapes follow docs/contract/MISMATCHES.md B130 to B136; every route is open to a merchant waiting for
// approval (B153) because it manages the merchant's own account.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { MERCHANT_ME_EXAMPLE, MerchantCode, MerchantCountry, MerchantMeShape } from './merchant-auth.contracts';

/** The fields of the profile; a missing key stays as it is. */
const ProfileBody = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(120).optional(),
  company: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(40).optional(),
  country: MerchantCountry.optional(),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

/** What the setup screen shows: the key to type, the link behind the QR code, and the QR code itself. */
const TwoFactorSetup = z.object({ secret: z.string(), otpauthUrl: z.string(), qrSvg: z.string() });

/** One live session of the merchant (never the token). */
const SessionRow = z.object({
  id: zId,
  ip: z.string(),
  userAgent: z.string(),
  lastSeenAt: zIsoDateTime,
  createdAt: zIsoDateTime,
  expiresAt: zIsoDateTime,
  current: z.boolean(),
});

/** `PATCH /client/profile`: name, company, phone and country. */
export const merchantUpdateProfile = defineRoute({
  key: 'PATCH /client/profile',
  summary: 'Update name, company, phone and country',
  description: 'A partial body: a missing key stays as it is. The email, username and group cannot be changed here.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  body: ProfileBody,
  success: { status: 200, schema: MerchantMeShape },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED'],
  examples: { request: { company: 'Hassan Mobile', country: 'JO' }, response: MERCHANT_ME_EXAMPLE },
});

/** `POST /client/security/password`: change the password with the current one. */
export const merchantChangePassword = defineRoute({
  key: 'POST /client/security/password',
  summary: 'Change the password',
  description:
    "Ends the merchant's other sessions (this one stays). A wrong current password is `422` on `currentPassword`, never `401`, " +
    'which would sign the caller out.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  body: ChangePasswordBody,
  success: { status: 204 },
  errors: [
    'VALIDATION_FAILED',
    'WEAK_PASSWORD',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
    'RATE_LIMITED',
  ],
  examples: { request: { currentPassword: 'a-long-password', newPassword: 'a-long-new-password' } },
});

/** `POST /client/security/2fa/setup`: a new pending TOTP secret with a QR code. */
export const merchantSetupTwoFactor = defineRoute({
  key: 'POST /client/security/2fa/setup',
  summary: 'A new TOTP secret with a QR code',
  description:
    'Stores the secret as pending (two-factor sign-in stays off) and answers it once. Every call replaces the pending secret; ' +
    '`/client/security/2fa/enable` confirms it with a code.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  success: { status: 200, schema: TwoFactorSetup },
  errors: [
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
    'TWOFA_ALREADY_ENABLED',
    'RATE_LIMITED',
  ],
  examples: {
    response: {
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUrl:
        'otpauth://totp/GSM%20Supply:ali%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=GSM%20Supply',
      qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"></svg>',
    },
  },
});

/** `POST /client/security/2fa/enable`: confirms the pending secret with a code. */
export const merchantEnableTwoFactor = defineRoute({
  key: 'POST /client/security/2fa/enable',
  summary: 'Enable 2FA after confirming a code',
  description: "Turns two-factor sign-in on and ends the merchant's other sessions (this one stays).",
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  body: MerchantCode,
  success: { status: 204 },
  errors: [
    'VALIDATION_FAILED',
    'TWOFA_ALREADY_ENABLED',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
    'RATE_LIMITED',
  ],
  examples: { request: { code: '123456' } },
});

/** `POST /client/security/2fa/disable`: turns two-factor sign-in off with a current code. */
export const merchantDisableTwoFactor = defineRoute({
  key: 'POST /client/security/2fa/disable',
  summary: 'Disable 2FA with a code',
  description:
    "Turns two-factor sign-in off, forgets the secret and ends the merchant's other sessions (this one stays). A code that " +
    'was just used to sign in is refused; wait for the next one.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  body: MerchantCode,
  success: { status: 204 },
  errors: [
    'VALIDATION_FAILED',
    'TWOFA_NOT_ENABLED',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
    'RATE_LIMITED',
  ],
  examples: { request: { code: '123456' } },
});

/** `GET /client/sessions`: the merchant's live devices. */
export const merchantListSessions = defineRoute({
  key: 'GET /client/sessions',
  summary: 'Active devices and sessions',
  description:
    'Live, fully signed-in sessions of the caller, newest first: not revoked, not past their end, and used within the idle limit ' +
    '(`sessions.client_idle_minutes`). `current` marks the calling session. Never the token.',
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  query: listQuery({
    sorts: ['createdAt', 'lastSeenAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
  }),
  success: { status: 200, schema: SessionRow },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'],
  examples: {
    response: [
      {
        id: 41,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        lastSeenAt: '2026-11-01T09:45:00.000Z',
        createdAt: '2026-11-01T09:30:00.000Z',
        expiresAt: '2026-12-01T09:30:00.000Z',
        current: true,
      },
    ],
  },
});

/** `DELETE /client/sessions/:id`: ends one of the merchant's sessions. */
export const merchantEndSession = defineRoute({
  key: 'DELETE /client/sessions/:id',
  summary: 'End a session',
  description:
    "Revokes the session when it is the caller's and live. Ending the calling session signs the caller out (the cookies are " +
    "cleared). Another merchant's, an unknown and an ended session are all `404`.",
  tags: ['auth'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['NOT_FOUND', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED'],
});
