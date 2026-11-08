// Route contracts of the admin customer actions (map domain I, stage 14): create an account for a guest, set a password or send
// a link, sign out every device, suspend and reactivate. Block, export and anonymize are feature 18's.
import { z } from 'zod';
import { defineRoute, zIdParam } from '../../../common/contract';
import { MAX_SUSPEND_NOTE_LENGTH, SUSPEND_REASONS, type SuspendReason } from '../domain/customer-status';
import { PasswordModeField } from './shared';

/** The answer of the account and password routes: the temporary password, shown once, for the temporary mode only. */
export const PasswordResultSchema = z.object({ temporaryPassword: z.string().optional() });

/** `POST /admin/customers/:id/account`. */
export const createCustomerAccount = defineRoute({
  key: 'POST /admin/customers/:id/account',
  summary: 'Create an account for a guest',
  description:
    'Turns a customer who bought as a guest into an account; the earlier orders already belong to the customer. `mode` ' +
    '`reset_link` emails a one-hour, single-use invitation; `temporary_password` answers a 14-character password once ' +
    '(`Cache-Control: no-store`) that must be changed at the first sign-in. Audited without any password.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:update',
  params: z.object({ id: zIdParam }),
  body: z.object({ mode: PasswordModeField }),
  success: { status: 200, schema: PasswordResultSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ACCOUNT_EXISTS',
    'ANONYMIZED',
    'VALIDATION_FAILED',
  ],
  examples: { request: { mode: 'temporary_password' }, response: { temporaryPassword: 'Hk7mQ2wPzR9tNx' } },
});

/** `POST /admin/customers/:id/password`. */
export const setCustomerPassword = defineRoute({
  key: 'POST /admin/customers/:id/password',
  summary: 'Send a password link or set a temporary password',
  description:
    'For an account only (`409 NO_ACCOUNT` for a guest). `mode` `reset_link` emails a new one-hour, single-use link and voids ' +
    'the older ones; `temporary_password` sets a generated 14-character password that the answer shows once and that must be ' +
    'changed at the first sign-in, and voids outstanding links. `revokeSessions` ends every session of the customer. The ' +
    'current password is never shown and never enters the audit log.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:password',
  params: z.object({ id: zIdParam }),
  body: z.object({ mode: PasswordModeField, revokeSessions: z.boolean().default(false) }),
  success: { status: 200, schema: PasswordResultSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NO_ACCOUNT', 'ANONYMIZED', 'VALIDATION_FAILED'],
  examples: { request: { mode: 'reset_link', revokeSessions: true }, response: {} },
});

/** `POST /admin/customers/:id/sessions/revoke`. */
export const revokeCustomerSessions = defineRoute({
  key: 'POST /admin/customers/:id/sessions/revoke',
  summary: 'Sign the customer out of every device',
  description: 'Ends every live session of the customer. Audited with how many were ended.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:password',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ANONYMIZED'],
});

/** `POST /admin/customers/:id/suspend`. */
export const suspendCustomer = defineRoute({
  key: 'POST /admin/customers/:id/suspend',
  summary: 'Suspend a customer account',
  description:
    'Only an active customer can be suspended (`409 NOT_ACTIVE`). The customer cannot sign in or open a checkout, every ' +
    'session ends, and orders in progress still complete. `reason` is one of the five reasons of the console; `note` (at most ' +
    '200 characters) is stored as `reason: note`. A temporary suspension adds nothing to the blocklist.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:suspend',
  params: z.object({ id: zIdParam }),
  body: z.object({
    // A plain string like the console's body type; the refinement keeps the five reasons closed (422 on `reason`).
    reason: z
      .string()
      .refine((value): value is SuspendReason => (SUSPEND_REASONS as readonly string[]).includes(value), {
        error: 'Choose a reason for the audit log.',
      })
      .describe(`One of: ${SUSPEND_REASONS.join('; ')}.`),
    note: z
      .string()
      .trim()
      .max(MAX_SUSPEND_NOTE_LENGTH, `Use at most ${MAX_SUSPEND_NOTE_LENGTH} characters.`)
      .optional(),
  }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NOT_ACTIVE', 'ANONYMIZED', 'VALIDATION_FAILED'],
  examples: { request: { reason: 'Account may be compromised', note: 'Customer called support.' } },
});

/** `POST /admin/customers/:id/reactivate`. */
export const reactivateCustomer = defineRoute({
  key: 'POST /admin/customers/:id/reactivate',
  summary: 'Reactivate a suspended customer',
  description:
    'Moves a suspended customer back to active and clears the reason. `409 NOT_SUSPENDED` for any other status.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:suspend',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NOT_SUSPENDED', 'ANONYMIZED'],
});
