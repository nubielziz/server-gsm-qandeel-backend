// Route contracts of staff management (map domain A, routes /admin/staff, stage 2): list, show, add by invitation or
// temporary password, edit, password, sessions, suspension and 2FA reset. Shapes match the console's StaffMember.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { EmailField, NameField, PersonRef } from './shared';

/** A staff member as the console reads it. Never carries a password hash or any TOTP data. */
const StaffMember = z.object({
  id: zId,
  createdAt: zIsoDateTime,
  name: z.string(),
  email: z.string(),
  twofaEnabled: z.boolean(),
  mustChangePassword: z.boolean(),
  passwordChangedAt: zIsoDateTime.nullable(),
  suspendedAt: zIsoDateTime.nullable(),
  lastLoginAt: zIsoDateTime.nullable(),
  role: PersonRef,
  status: z.enum(['invited', 'active', 'suspended']),
  lastLoginIp: z.string().nullable(),
  activeSessions: z.number().int().min(0),
  createdBy: PersonRef.nullable(),
  suspendedReason: z.string().nullable(),
  suspendedBy: PersonRef.nullable(),
  resetSentAt: zIsoDateTime.nullable(),
});

/** The new account; the temporary password is present once, only for the temporary-password onboarding. */
const CreatedStaffMember = StaffMember.extend({ temporaryPassword: z.string().optional() });

const MEMBER_EXAMPLE = {
  id: 5,
  createdAt: '2026-10-30T09:30:00.000Z',
  name: 'Nadia H.',
  email: 'nadia@gsm-supply.example',
  twofaEnabled: false,
  mustChangePassword: false,
  passwordChangedAt: null,
  suspendedAt: null,
  lastLoginAt: null,
  role: { id: 2, name: 'Admin' },
  status: 'invited',
  lastLoginIp: null,
  activeSessions: 0,
  createdBy: { id: 1, name: 'Rami K.' },
  suspendedReason: null,
  suspendedBy: null,
  resetSentAt: '2026-10-30T09:30:00.000Z',
} as const;

const ID_PARAMS = z.object({ id: zIdParam });

/** `GET /admin/staff`: the staff list (also feeds the audit person filter and the support assignee picker). */
export const listStaff = defineRoute({
  key: 'GET /admin/staff',
  summary: 'List staff members',
  description:
    'Staff of any status. `activeSessions` counts live, fully signed-in sessions (the same rule as `GET /admin/sessions`). ' +
    '`resetSentAt` is when the latest invite or reset link was issued; it is `null` when none exists or a temporary password ' +
    'was set after it. Default order: oldest first.',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:read',
  query: listQuery({
    sorts: ['createdAt', 'name', 'email', 'status', 'lastLoginAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'asc' },
    filters: {
      id: { type: 'id', ops: ['eq'] },
      status: { type: 'enum', values: ['invited', 'active', 'suspended'], ops: ['eq', 'ne'] },
      'role.id': { type: 'id', ops: ['eq'] },
    },
    search: ['name', 'email'],
  }),
  success: { status: 200, schema: StaffMember },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [MEMBER_EXAMPLE] },
});

/** `GET /admin/staff/:id`: one staff member. */
export const showStaff = defineRoute({
  key: 'GET /admin/staff/:id',
  summary: 'Show a staff member',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:read',
  params: ID_PARAMS,
  success: { status: 200, schema: StaffMember },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: MEMBER_EXAMPLE },
});

/** `POST /admin/staff`: add a staff member by invitation link or with a temporary password. */
export const createStaff = defineRoute({
  key: 'POST /admin/staff',
  summary: 'Add a staff member',
  description:
    'The account starts `invited`. `invite` creates a one-hour, single-use link token (hash only); `temporary_password` ' +
    'generates a password, stores its hash, forces a change at the first sign-in and returns it once in this answer. ' +
    'Only an owner can give the new account a role that grants `*`.',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:create',
  body: z.object({
    name: NameField,
    email: EmailField,
    roleId: zId,
    onboarding: z.enum(['invite', 'temporary_password']).default('invite'),
  }),
  success: { status: 201, schema: CreatedStaffMember },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'EMAIL_TAKEN'],
  examples: {
    request: { name: 'Nadia H.', email: 'nadia@gsm-supply.example', roleId: 2, onboarding: 'invite' },
    response: MEMBER_EXAMPLE,
  },
});

/** `PATCH /admin/staff/:id`: change name, email or role. */
export const updateStaff = defineRoute({
  key: 'PATCH /admin/staff/:id',
  summary: 'Edit a staff member',
  description:
    "Only the keys sent change. A role change applies on the member's next request. Nobody changes their own role " +
    '(`CANNOT_CHANGE_OWN_ROLE`), and the last active owner cannot be demoted (`LAST_OWNER`). Actions on an owner account and ' +
    'giving a role that grants `*` need an owner.',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:update',
  params: ID_PARAMS,
  body: z
    .object({ name: NameField.optional(), email: EmailField.optional(), roleId: zId.optional() })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: StaffMember },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'EMAIL_TAKEN',
    'CANNOT_CHANGE_OWN_ROLE',
    'LAST_OWNER',
  ],
  examples: { request: { roleId: 3 }, response: MEMBER_EXAMPLE },
});

/** `POST /admin/staff/:id/password`: send a set-password link, or set a temporary password. */
export const setStaffPassword = defineRoute({
  key: 'POST /admin/staff/:id/password',
  summary: 'Reset a staff password',
  description:
    '`reset_link` issues a one-hour link token (purpose `invite` while the account is still invited, else `reset`); the ' +
    'current password keeps working until the link is used. `temporary_password` generates and stores a password (hash ' +
    'only), forces a change at the next sign-in and returns it once. Always `200` with `Cache-Control: no-store`: `{}` for ' +
    'the link, `{temporaryPassword}` for the temporary password. `revokeSessions` ends every session of the member.',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:update',
  params: ID_PARAMS,
  body: z.object({ mode: z.enum(['reset_link', 'temporary_password']), revokeSessions: z.boolean() }),
  success: { status: 200, schema: z.object({ temporaryPassword: z.string().optional() }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { mode: 'temporary_password', revokeSessions: true },
    response: { temporaryPassword: 'Kq7mT2vNb8RxHc' },
  },
});

/** `POST /admin/staff/:id/sessions/revoke`: sign a member out everywhere. */
export const revokeStaffSessions = defineRoute({
  key: 'POST /admin/staff/:id/sessions/revoke',
  summary: 'End all sessions of a staff member',
  description: 'Ends every session of the member, including a sign-in step in progress. Ending your own signs you out.',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:update',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});

/** `POST /admin/staff/:id/suspend`: suspend a member with a reason. */
export const suspendStaff = defineRoute({
  key: 'POST /admin/staff/:id/suspend',
  summary: 'Suspend a staff member',
  description:
    'Sets `suspended`, ends every session and voids unused links; the history stays and the name stays on old audit ' +
    'entries. Suspending yourself or the last active owner is refused.',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:suspend',
  params: ID_PARAMS,
  body: z.object({ reason: z.string().trim().min(1, 'Say why, so the next person knows.').max(200) }),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'CANNOT_SUSPEND_SELF',
    'ALREADY_SUSPENDED',
    'LAST_OWNER',
  ],
  examples: { request: { reason: 'On leave: back in December' } },
});

/** `POST /admin/staff/:id/reactivate`: lift a suspension. */
export const reactivateStaff = defineRoute({
  key: 'POST /admin/staff/:id/reactivate',
  summary: 'Reactivate a staff member',
  description:
    'The status becomes `active` if the member ever signed in, else `invited`; the reason is cleared. No session comes ' +
    'back: the member signs in again with the current password and authenticator.',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:suspend',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NOT_SUSPENDED'],
});

/** `POST /admin/staff/:id/reset-2fa`: clear a member's authenticator. */
export const resetStaffTwoFactor = defineRoute({
  key: 'POST /admin/staff/:id/reset-2fa',
  summary: 'Reset two-factor sign-in',
  description:
    "Turns 2FA off and clears the secret; the next sign-in asks for a new setup. The member's sessions end unless the " +
    'member is the caller.',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:update',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'TWOFA_NOT_ENABLED'],
});
