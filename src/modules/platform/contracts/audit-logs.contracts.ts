// Route contracts of the audit log (map domain G, routes /admin/audit-logs, stage 2): the list with its filters and one entry.
// Shapes match the console's AuditLog (docs/contract/endpoints/platform.md, MISMATCHES B10).
import { z } from 'zod';
import { defineRoute, listQuery, zDateOnly, zId, zIdParam, zIsoDateTime, zJsonObject } from '../../../common/contract';
import { AUDIT_ACTOR_TYPES } from '../db/schema';

/** One audit entry. `before` and `after` are snapshots with secrets masked. */
const AuditLogRow = z.object({
  id: zId,
  createdAt: zIsoDateTime,
  action: z.string(),
  entityType: z.string(),
  // 0 when the action has no numeric record (a settings change): the console then shows no link.
  entityId: z.number().int().min(0),
  actorType: z.enum(AUDIT_ACTOR_TYPES),
  actorId: zId.nullable(),
  actorName: z.string().nullable(),
  entityLabel: z.string().nullable(),
  before: zJsonObject.nullable(),
  after: zJsonObject.nullable(),
  ip: z.string().nullable(),
  account: z
    .object({ id: zId })
    .nullable()
    .describe(
      'The account the entry is about, so the console links an old row without guessing: the account of the record when the record is an ' +
        'account (`account`, an old `merchant` row, an old `customer` row through the legacy map), else the account that acted; `null` for ' +
        'staff and system rows, and for an old number the map does not know.',
    ),
});

const ENTRY_EXAMPLE = {
  id: 42,
  createdAt: '2026-11-01T09:30:00.000Z',
  action: 'suspended admin',
  entityType: 'staff',
  entityId: 6,
  actorType: 'staff',
  actorId: 1,
  actorName: 'Rami K.',
  entityLabel: 'Yusuf M.',
  before: { status: 'active' },
  after: { status: 'suspended', reason: 'Left the team' },
  ip: '203.0.113.24',
  account: null,
} as const;

/** `GET /admin/audit-logs`: the audit log, newest first. */
export const listAuditLogs = defineRoute({
  key: 'GET /admin/audit-logs',
  summary: 'List audit entries',
  description:
    'Newest first. `actorType` is staff, account or system (system rows have no `actorId`, `actorName` or `ip`; the ' +
    'console shows "System"); rows written before the accounts were merged also say client or customer. `actorName` and `entityLabel` are ' +
    'snapshots written with the entry, so renamed or deleted records still read correctly. `entityType` is a word of the closed list ' +
    '`AUDIT_ENTITY_TYPES`. `accountId` lists every entry about one account under every word it was written with: `account` with that id, ' +
    '`merchant` with the same number, and `customer` with the old customer numbers of the account. `entityType=account` reads the three words ' +
    '(with `entityId` it means one account, as `accountId`), and `actorType=account` reads `account`, `client` and `customer` actors the ' +
    'same way. Every row carries `account`, the account it is about. `q` is a case-insensitive ' +
    'contains over `actorName`, `action` and `entityLabel`. `from` and `to` are UTC days, both included.',
  tags: ['audit'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'audit:read',
  query: listQuery({
    sorts: ['createdAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      actorType: { type: 'enum', values: [...AUDIT_ACTOR_TYPES], ops: ['eq'] },
      actorId: { type: 'id', ops: ['eq'] },
      entityType: { type: 'string', ops: ['eq'] },
      entityId: { type: 'id', ops: ['eq'] },
      accountId: { type: 'id', ops: ['eq'] },
    },
    search: ['actorName', 'action', 'entityLabel'],
    extra: { from: zDateOnly.optional(), to: zDateOnly.optional() },
  }),
  success: { status: 200, schema: AuditLogRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ENTRY_EXAMPLE] },
});

/** `GET /admin/audit-logs/:id`: one audit entry. */
export const showAuditLog = defineRoute({
  key: 'GET /admin/audit-logs/:id',
  summary: 'Show an audit entry',
  tags: ['audit'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'audit:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: AuditLogRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: ENTRY_EXAMPLE },
});
