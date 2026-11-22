// Route contracts of the admin session list (map domain A, routes /admin/sessions, stage 2): who is signed in, and ending a
// session. Shapes match the console (docs/contract/endpoints/identity.md, MISMATCHES B9).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';

/** One live session of a staff member or a merchant. */
const SessionRow = z.object({
  id: zId,
  expiresAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  ip: z.string(),
  userAgent: z.string(),
  lastSeenAt: zIsoDateTime.nullable(),
  subjectType: z.enum(['staff', 'client']),
  subject: z.object({ id: zId, name: z.string(), email: z.string().optional() }),
  current: z.boolean().optional(),
});

/** `GET /admin/sessions`: the live, fully signed-in sessions of staff and merchants. */
export const listSessions = defineRoute({
  key: 'GET /admin/sessions',
  summary: 'List live sessions',
  description:
    'Fully signed-in staff and merchant sessions that are live: not revoked, not past `expiresAt`, and used within the idle ' +
    'limit of their subject type (decision 018). Storefront customer sessions and sign-in steps are not listed (B9). ' +
    "`current` marks the session that made the request. `subjectId` lists one account's sessions (the merchant page); it needs " +
    '`subjectType` in the same request because staff and merchant ids overlap (`422` on `subjectId` otherwise). ' +
    "The address and the device of another staff member's session are masked (`•••`) when that member's role holds permissions the caller does not hold " +
    "(an owner's, for a caller who is not an owner); a merchant's email address is masked unless the caller holds `clients:read` (decisions 046 and 047).",
  tags: ['sessions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'sessions:read',
  query: listQuery({
    sorts: ['lastSeenAt', 'createdAt', 'id'],
    defaultSort: { field: 'lastSeenAt', order: 'desc' },
    filters: {
      subjectType: { type: 'enum', values: ['staff', 'client'], ops: ['eq'] },
      subjectId: { type: 'id', ops: ['eq'] },
    },
  }),
  success: { status: 200, schema: SessionRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        id: 14,
        expiresAt: '2026-11-01T17:30:00.000Z',
        createdAt: '2026-11-01T09:30:00.000Z',
        ip: '203.0.113.24',
        userAgent: 'Mozilla/5.0',
        lastSeenAt: '2026-11-01T10:02:00.000Z',
        subjectType: 'staff',
        subject: { id: 1, name: 'Rami K.', email: 'rami@gsm-supply.example' },
        current: true,
      },
    ],
  },
});

/** `DELETE /admin/sessions/:id`: ends a session. */
export const revokeSession = defineRoute({
  key: 'DELETE /admin/sessions/:id',
  summary: 'End a session',
  description:
    'Ends any live session of the list (staff or merchant). Ending your own session signs you out on your next request. A ' +
    "session that is no longer live by the list's rule (revoked, expired or idle) answers 404. " +
    "A session of another staff member is ended only by an owner when that member is an owner, and only by a caller who holds every permission of the member's role (`403 FORBIDDEN`, decision 046). " +
    "A merchant's session is ended only by a caller who also holds `clients:security` (`403 FORBIDDEN`, decision 047).",
  tags: ['sessions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'sessions:revoke',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
