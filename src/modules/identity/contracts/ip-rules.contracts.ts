// Route contracts of IP rules and the admin access restriction (map domain A, routes /admin/ip-rules and
// /admin/access/restriction, stage 2, scenario ip-rules). Shapes match the console (docs/contract/endpoints/identity.md).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { PersonRef } from './shared';

const Scope = z.enum(['store', 'api', 'admin', 'all']);

/** An allowed or blocked address or range, as the console lists it. */
const IpRuleRow = z.object({
  id: zId,
  cidr: z.string(),
  label: z.string(),
  reason: z.string(),
  expiresAt: zIsoDateTime.nullable(),
  hitCount: z.number().int().min(0),
  lastHitAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  kind: z.enum(['allow', 'block']),
  scope: Scope,
  source: z.enum(['manual', 'auto']),
  createdBy: PersonRef.nullable(),
});

const RULE_EXAMPLE = {
  id: 3,
  cidr: '203.0.113.24',
  label: 'Amman office',
  reason: '',
  expiresAt: null,
  hitCount: 12,
  lastHitAt: '2026-11-01T08:00:00.000Z',
  createdAt: '2026-10-01T09:30:00.000Z',
  kind: 'allow',
  scope: 'admin',
  source: 'manual',
  createdBy: { id: 1, name: 'Rami K.' },
} as const;

/** `GET /admin/ip-rules`: the live rules (expired ones are left out). */
export const listIpRules = defineRoute({
  key: 'GET /admin/ip-rules',
  summary: 'List IP rules',
  description:
    'Rules that have not expired, newest first. A single address is written without `/32` or `/128`; ranges keep their ' +
    'prefix. `label` and `reason` are empty strings when unset. `createdBy` is `null` for rules the risk engine added.',
  tags: ['ip-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'access:read',
  query: listQuery({
    sorts: ['createdAt', 'hitCount', 'expiresAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      id: { type: 'id', ops: ['eq'] },
      kind: { type: 'enum', values: ['allow', 'block'], ops: ['eq'] },
      scope: { type: 'enum', values: ['store', 'api', 'admin', 'all'], ops: ['eq'] },
      source: { type: 'enum', values: ['manual', 'auto'], ops: ['eq'] },
    },
    search: ['cidr', 'label', 'reason'],
  }),
  success: { status: 200, schema: IpRuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [RULE_EXAMPLE] },
});

/** `GET /admin/ip-rules/:id`: one rule (also an expired one, so audit links keep working). */
export const showIpRule = defineRoute({
  key: 'GET /admin/ip-rules/:id',
  summary: 'Show an IP rule',
  tags: ['ip-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'access:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: IpRuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: RULE_EXAMPLE },
});

/** `POST /admin/ip-rules`: allow or block an address or range. */
export const createIpRule = defineRoute({
  key: 'POST /admin/ip-rules',
  summary: 'Add an IP rule',
  description:
    'An allow rule is always for the admin console (the scope is forced to `admin`). A block needs a `reason`. `cidr` is an ' +
    'address or a range of at least /16 (IPv4) or /48 (IPv6) with no bits set after the prefix. A live rule with the same ' +
    'range and kind (and, for blocks, scope) is refused. A block of the admin console or of everything that covers the ' +
    "caller's own address is `409 SELF_LOCKOUT`. The rule cache is cleared after the commit.",
  tags: ['ip-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'access:create',
  body: z.object({
    kind: z.enum(['allow', 'block']),
    scope: Scope,
    cidr: z.string().trim().min(1, 'Enter an address.').max(64, 'Too long.'),
    label: z.string().trim().max(120).optional(),
    reason: z.string().trim().max(240).optional(),
    expiresAt: zIsoDateTime.optional(),
  }),
  success: { status: 201, schema: IpRuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'SELF_LOCKOUT'],
  examples: {
    request: { kind: 'allow', scope: 'admin', cidr: '203.0.113.24', label: 'Amman office' },
    response: RULE_EXAMPLE,
  },
});

/** `DELETE /admin/ip-rules/:id`: remove a rule. */
export const deleteIpRule = defineRoute({
  key: 'DELETE /admin/ip-rules/:id',
  summary: 'Remove an IP rule',
  description:
    'Unblocks an address or removes an allowed one. Removing the only live allow rule that lets the caller in, while the ' +
    'restriction is on, is `409 SELF_LOCKOUT`; removing a rule that does not cover the caller is always allowed.',
  tags: ['ip-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'access:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'SELF_LOCKOUT'],
});

/** `POST /admin/ip-rules/check`: what would happen to an address. */
export const checkIp = defineRoute({
  key: 'POST /admin/ip-rules/check',
  summary: 'Test an address against the rules',
  description:
    'Read-only: it counts no hit and writes no audit row (a POST only because the address travels in the body). A range is ' +
    'judged by its first address. `rule` is the rule that decided, or `null` when none did.',
  tags: ['ip-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'access:read',
  body: z.object({ ip: z.string().trim().min(1, 'Enter an address.').max(64, 'Too long.'), scope: Scope }),
  success: { status: 200, schema: z.object({ decision: z.enum(['allowed', 'refused']), rule: IpRuleRow.nullable() }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  audit: false,
  examples: { request: { ip: '203.0.113.24', scope: 'admin' }, response: { decision: 'allowed', rule: RULE_EXAMPLE } },
});

/** `PUT /admin/access/restriction`: limit the admin console to the allow list, or lift the limit. */
export const setAdminRestriction = defineRoute({
  key: 'PUT /admin/access/restriction',
  summary: 'Turn the admin allow-list restriction on or off',
  description:
    'Stores the setting `adminAllowlistOnly`. Turning it on is `409 IP_NOT_IN_ALLOWLIST` unless a live allow rule covers the ' +
    "caller's own address, so nobody locks themselves out. Turning it off is always allowed. Idempotent.",
  tags: ['ip-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'access:update',
  body: z.object({ enabled: z.boolean() }),
  success: { status: 200, schema: z.object({ enabled: z.boolean() }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'IP_NOT_IN_ALLOWLIST'],
  examples: { request: { enabled: true }, response: { enabled: true } },
});
