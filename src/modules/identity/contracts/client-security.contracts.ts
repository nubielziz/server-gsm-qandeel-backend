// Route contracts of the staff security tools on an account (feature 20, plan section 4.2, routes of /admin/clients/:id, decision 064): send a
// password or invitation link, set a temporary password, reset 2FA, end all sessions, resend the verification email, and make an account of a guest.
import { z } from 'zod';
import { defineRoute, zIdParam } from '../../../common/contract';

const ID_PARAMS = z.object({ id: zIdParam });

/** `POST /admin/clients/:id/password`: a set-password link, a fresh invitation, or a temporary password. */
export const setClientPassword = defineRoute({
  key: 'POST /admin/clients/:id/password',
  summary: 'Reset the password of an account',
  description:
    '`reset_link` emails the account a one-hour, one-use link (purpose `invite` while the account has no password, else ' +
    '`reset`; it replaces an older invitation or reset link) and answers which mail was sent in `link`; the current password keeps ' +
    'working until the link is used. The answer never carries the link. `temporary_password` generates and stores a password ' +
    '(hash only), forces a change at the next sign-in (the account meets `next: password` on sign-in), cancels ' +
    'older links, ends every session of the account, emails the account a security notice and returns the password once in ' +
    '`temporaryPassword`. Always `Cache-Control: no-store`. `revokeSessions` (default false) ends every session of the account in the ' +
    '`reset_link` mode; a temporary password ends them whatever it says. It works on an account of any rank ' +
    'that has a login: a guest is `409 NO_ACCOUNT` ("Make an account first."), an anonymized account `409 ANONYMIZED`, a suspended or blocked ' +
    'account `409 NOT_ACTIVE`. The link mode counts against five mails an hour per account (`429 RATE_LIMITED`).' +
    ' A temporary password works for 72 hours; after that it is refused like a wrong password and a new one must be set. Setting one also lifts the lock that repeated failed sign-ins put on the email.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:security',
  params: ID_PARAMS,
  body: z.object({
    mode: z.enum(['reset_link', 'temporary_password']),
    revokeSessions: z
      .boolean()
      .default(false)
      .describe('Ends every session of the account in the reset_link mode; a temporary password always ends them.'),
  }),
  success: {
    status: 200,
    schema: z.object({
      temporaryPassword: z.string().optional(),
      link: z.enum(['invite', 'reset']).optional(),
    }),
  },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'NO_ACCOUNT',
    'ANONYMIZED',
    'NOT_ACTIVE',
    'RATE_LIMITED',
  ],
  examples: {
    request: { mode: 'temporary_password', revokeSessions: true },
    response: { temporaryPassword: 'Kq7mT2vNb8RxHc' },
  },
});

/** `POST /admin/clients/:id/reset-2fa`: turn two-factor sign-in off. */
export const resetClientTwoFactor = defineRoute({
  key: 'POST /admin/clients/:id/reset-2fa',
  summary: 'Reset two-factor sign-in of an account',
  description:
    'Turns 2FA off and clears the secret, ends every session of the account (a sign-in step in progress included) and emails the ' +
    'account a security notice. The person sets 2FA up again after signing in. A guest is `409 NO_ACCOUNT`, an anonymized account `409 ANONYMIZED`.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:security',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NO_ACCOUNT', 'ANONYMIZED', 'TWOFA_NOT_ENABLED'],
});

/** `POST /admin/clients/:id/sessions/revoke`: sign an account out everywhere. */
export const revokeClientSessions = defineRoute({
  key: 'POST /admin/clients/:id/sessions/revoke',
  summary: 'End all sessions of an account',
  description:
    'Ends every session of the account, including a sign-in step in progress. `204` also when there was none. The person is not ' +
    'mailed. A guest is `409 NO_ACCOUNT`, an anonymized account `409 ANONYMIZED`; a suspended or blocked account can still be signed out.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:security',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NO_ACCOUNT', 'ANONYMIZED'],
});

/** `POST /admin/clients/:id/verify-email/resend`: a new verification email. */
export const resendClientVerification = defineRoute({
  key: 'POST /admin/clients/:id/verify-email/resend',
  summary: 'Resend the verification email of an account',
  description:
    'Emails the account a new one-hour verification link; it replaces the older verification link. `409 CONFLICT` when the email is ' +
    'already verified, `409 NOT_ACTIVE` when the account is suspended or blocked, `409 NO_ACCOUNT` for a guest, `409 ANONYMIZED`, `429 RATE_LIMITED` after five mails an hour (the limiter is ' +
    "shared with the account's own resend).",
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:security',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'CONFLICT',
    'NO_ACCOUNT',
    'ANONYMIZED',
    'NOT_ACTIVE',
    'RATE_LIMITED',
  ],
});

/** `POST /admin/clients/:id/account`: make an account of a guest. */
export const makeClientAccount = defineRoute({
  key: 'POST /admin/clients/:id/account',
  summary: 'Make an account of a guest',
  description:
    'Gives a guest (a row a checkout, a support form or a link request left for an email address) a login on the retail rank; its orders stay ' +
    'on it. `reset_link` mails an invitation (a one-hour link to choose a password) and answers `link: invite`; `temporary_password` (which also ' +
    'needs `clients:security`) makes a password the server returns once in `temporaryPassword`, valid for 72 hours, and mails a security notice. ' +
    "The guest row's own open email links are voided. Always `Cache-Control: no-store`. `409 ACCOUNT_EXISTS` for a row that already has a login, " +
    '`409 EMAIL_TAKEN` with code `login_exists` when another account with a login uses the email, `409 ANONYMIZED`. A blocklisted email is ' +
    '`422` on `email`, as on a create.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:update',
  params: ID_PARAMS,
  body: z.object({
    mode: z.enum(['reset_link', 'temporary_password']).default('reset_link'),
  }),
  success: {
    status: 200,
    schema: z.object({
      temporaryPassword: z.string().optional(),
      link: z.literal('invite').optional(),
    }),
  },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'ACCOUNT_EXISTS',
    'EMAIL_TAKEN',
    'ANONYMIZED',
  ],
  examples: {
    request: { mode: 'reset_link' },
    response: { link: 'invite' },
  },
});
