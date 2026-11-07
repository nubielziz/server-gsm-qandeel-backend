// Route contracts of roles and the permission catalog (map domain A, routes /admin/roles and /admin/permissions, stage 2).
// Shapes match what the console sends and reads (docs/contract/endpoints/identity.md, ALIGNMENT § 4).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam } from '../../../common/contract';

/**
 * A role with the number of staff members who hold it (any status). The console types `staffCount` as optional (its mock leaves
 * it out of a PATCH answer); the server sends it on every answer.
 */
const RoleRow = z.object({
  id: zId,
  name: z.string(),
  permissions: z.array(z.string()),
  staffCount: z.number().int().min(0).optional(),
});

/** The role name: trimmed, 1 to 60 characters (RoleDialog). */
const RoleName = z.string().trim().min(1, 'Enter a name for the role.').max(60, 'Use at most 60 characters.');

/** Permission entries: well-formed text only here; the server checks them against the catalog. */
const PermissionList = z.array(z.string().trim().min(1).max(80)).max(400);

/** One permission the role editor offers. */
const PermissionRow = z.object({ key: z.string(), label: z.string(), group: z.string() });

const ROLE_EXAMPLE = { id: 2, name: 'Support', permissions: ['staff:read', 'orders:*'], staffCount: 3 };

/** `GET /admin/roles`: the roles with their holders counted. */
export const listRoles = defineRoute({
  key: 'GET /admin/roles',
  summary: 'List roles',
  description: 'Roles and their permissions as stored, wildcards included. `staffCount` counts staff of any status.',
  tags: ['roles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'roles:read',
  query: listQuery({
    sorts: ['id', 'name'],
    defaultSort: { field: 'id', order: 'asc' },
    search: ['name'],
  }),
  success: { status: 200, schema: RoleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ROLE_EXAMPLE] },
});

/** `GET /admin/roles/:id`: one role. */
export const showRole = defineRoute({
  key: 'GET /admin/roles/:id',
  summary: 'Show a role',
  tags: ['roles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'roles:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: RoleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: ROLE_EXAMPLE },
});

/** `POST /admin/roles`: a new role. */
export const createRole = defineRoute({
  key: 'POST /admin/roles',
  summary: 'Create a role',
  description:
    'Permissions are catalog entries (`GET /admin/permissions`), an area wildcard `area:*` of a known area, or `*`. Only an ' +
    'owner can create a role that grants `*`.',
  tags: ['roles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'roles:create',
  body: z.object({ name: RoleName, permissions: PermissionList }),
  success: { status: 201, schema: RoleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { name: 'Support', permissions: ['staff:read', 'orders:*'] },
    response: { ...ROLE_EXAMPLE, staffCount: 0 },
  },
});

/** `PATCH /admin/roles/:id`: rename a role or change its permissions. */
export const updateRole = defineRoute({
  key: 'PATCH /admin/roles/:id',
  summary: 'Update a role',
  description:
    'Only the keys sent change. A permission change applies to everyone who holds the role on their next request. Removing ' +
    '`*` from the role of the last active owner is `409 LAST_OWNER` on `permissions`; the Owner role may be renamed.',
  tags: ['roles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'roles:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({ name: RoleName.optional(), permissions: PermissionList.optional() })
    .refine((body) => body.name !== undefined || body.permissions !== undefined, 'Send a name or permissions.'),
  success: { status: 200, schema: RoleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'LAST_OWNER'],
  examples: { request: { name: 'Support team' }, response: { ...ROLE_EXAMPLE, name: 'Support team' } },
});

/** `DELETE /admin/roles/:id`: delete a role nobody holds. */
export const deleteRole = defineRoute({
  key: 'DELETE /admin/roles/:id',
  summary: 'Delete a role',
  tags: ['roles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'roles:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ROLE_IN_USE'],
});

/** `GET /admin/permissions`: every concrete permission the server checks. */
export const listPermissions = defineRoute({
  key: 'GET /admin/permissions',
  summary: 'List the permission catalog',
  description:
    'Every concrete `area:action` permission the registered routes require, without wildcards, as `{key, label, group}` ' +
    '(group is the area, label the humanised action). Plain array, no paging, no `x-total-count`.',
  tags: ['roles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'roles:read',
  success: { status: 200, schema: z.array(PermissionRow) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
  examples: { response: [{ key: 'staff:read', label: 'Read', group: 'staff' }] },
});
