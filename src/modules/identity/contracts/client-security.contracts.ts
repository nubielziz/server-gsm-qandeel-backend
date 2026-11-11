// Route contracts of the staff security tools on a merchant (feature 20, plan section 4.2, routes R1-R4 of /admin/clients/:id):
// send a password or invitation link, set a temporary password, reset 2FA, end all sessions, resend the verification email.
import { z } from 'zod';
import { defineRoute, zIdParam } from '../../../common/contract';

const ID_PARAMS = z.object({ id: zIdParam });

/** `POST /admin/clients/:id/password`: a set-password link, a fresh invitation, or a temporary password. */
export const setClientPassword = defineRoute({
  key: 'POST /admin/clients/:id/password',
  summary: 'Reset a merchant password',
  description:
    '`reset_link` emails the merchant a one-hour, one-use link (purpose `invite` while the merchant has no password, else ' +
    '`reset`; it replaces an older invitation or reset link) and answers which mail was sent in `link`; the current password keeps ' +
    'working until the link is used. The answer never carries the link. `temporary_password` generates and stores a password ' +
    '(hash only), forces a change at the next sign-in (the merchant meets `next: password` on `POST /client/auth/login`), cancels ' +
    'older links, emails the merchant a security notice and returns the password once in `temporaryPassword`. Always ' +
    '`Cache-Control: no-store`. `revokeSessions` (default false) ends every session of the merchant. A suspended merchant is ' +
    '`409 NOT_ACTIVE`. The link mode counts against five mails an hour per merchant (`429 RATE_LIMITED`).',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:security',
  params: ID_PARAMS,
  body: z.object({
    mode: z.enum(['reset_link', 'temporary_password']),
    revokeSessions: z.boolean().default(false),
  }),
  success: {
    status: 200,
    schema: z.object({
      temporaryPassword: z.string().optional(),
      link: z.enum(['invite', 'reset']).optional(),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'NOT_ACTIVE', 'RATE_LIMITED'],
  examples: {
    request: { mode: 'temporary_password', revokeSessions: true },
    response: { temporaryPassword: 'Kq7mT2vNb8RxHc' },
  },
});

/** `POST /admin/clients/:id/reset-2fa`: turn two-factor sign-in off. */
export const resetClientTwoFactor = defineRoute({
  key: 'POST /admin/clients/:id/reset-2fa',
  summary: 'Reset two-factor sign-in of a merchant',
  description:
    'Turns 2FA off and clears the secret, ends every session of the merchant (a sign-in step in progress included) and emails the ' +
    'merchant a security notice. The merchant sets 2FA up again from the portal.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:security',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'TWOFA_NOT_ENABLED'],
});

/** `POST /admin/clients/:id/sessions/revoke`: sign a merchant out everywhere. */
export const revokeClientSessions = defineRoute({
  key: 'POST /admin/clients/:id/sessions/revoke',
  summary: 'End all sessions of a merchant',
  description:
    'Ends every session of the merchant, including a sign-in step in progress. `204` also when there was none. The merchant is not ' +
    'mailed.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:security',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});

/** `POST /admin/clients/:id/verify-email/resend`: a new verification email. */
export const resendClientVerification = defineRoute({
  key: 'POST /admin/clients/:id/verify-email/resend',
  summary: 'Resend the verification email of a merchant',
  description:
    'Emails the merchant a new one-hour verification link; it replaces the older verification link. `409 CONFLICT` when the email is ' +
    'already verified, `409 NOT_ACTIVE` when the merchant is suspended, `429 RATE_LIMITED` after five mails an hour (the limiter is ' +
    "shared with the merchant's own resend).",
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:security',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'CONFLICT', 'NOT_ACTIVE', 'RATE_LIMITED'],
});
