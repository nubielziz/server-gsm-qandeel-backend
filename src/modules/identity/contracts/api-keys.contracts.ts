// Route contracts of merchant API keys (map domain A, stage 7): the merchant's own keys under /client/api-keys (MISMATCHES B155)
// and the staff's view and revocation under /admin (identity.md). The shape is the console's ApiKey (identity-platform-5).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { MAX_ALLOWED_IPS, MAX_LIVE_KEYS, MERCHANT_KEY_SCOPES } from '../domain/api-key-input';

/** An API key as the portal and the console read it: never the hash, never the key itself after creation. */
const ApiKeyRow = z.object({
  id: zId,
  clientId: zId,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  allowedIps: z.array(z.string()),
  rateLimitPerMin: z.number().int(),
  lastUsedAt: zIsoDateTime.nullable(),
  lastUsedIp: z.string(),
  expiresAt: zIsoDateTime.nullable(),
  revokedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

/** The key name: trimmed, 1 to 60 characters. */
const KeyName = z.string().trim().min(1, 'Name the key.').max(60, 'Use at most 60 characters.');
/** Allowed addresses: each an address or a range; checked and written by the use case (`allowedIps.N`). */
const AllowedIps = z
  .array(z.string().trim().min(1, 'Enter an IP address or range.').max(60))
  .max(MAX_ALLOWED_IPS, `Use at most ${MAX_ALLOWED_IPS} addresses.`);

const KEY_EXAMPLE = {
  id: 7,
  clientId: 1,
  name: 'Production server',
  prefix: 'gsm_Qx4f',
  scopes: ['orders:read', 'orders:write', 'account:read'],
  allowedIps: ['203.0.113.55', '198.51.100.0/24'],
  rateLimitPerMin: 60,
  lastUsedAt: '2026-11-01T09:30:00.000Z',
  lastUsedIp: '203.0.113.55',
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-10-01T08:00:00.000Z',
} as const;

/** `GET /client/api-keys`: the merchant's own keys. */
export const portalListApiKeys = defineRoute({
  key: 'GET /client/api-keys',
  summary: 'My API keys',
  description:
    'The keys of the signed-in merchant: live keys first, then revoked ones, newest first within each group. Only the display ' +
    'prefix is readable; the full key was shown once when it was created. `allowedIps` keeps ranges as written and drops the ' +
    '`/32` or `/128` of a single address; `lastUsedIp` is `""` for a key that was never used.',
  tags: ['api-keys'],
  surface: 'client',
  access: 'merchant-session',
  query: listQuery({ sorts: ['createdAt', 'id'], defaultSort: { field: 'createdAt', order: 'desc' } }),
  success: { status: 200, schema: ApiKeyRow },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_APPROVAL', 'IP_NOT_ALLOWED'],
  examples: { response: [KEY_EXAMPLE] },
});

/** `POST /client/api-keys`: a new key, shown once. */
export const portalCreateApiKey = defineRoute({
  key: 'POST /client/api-keys',
  summary: 'New API key',
  description:
    `\`scopes\` is a non-empty subset of ${MERCHANT_KEY_SCOPES.map((scope) => `\`${scope}\``).join(', ')} (an area wildcard such ` +
    'as `orders:*` is allowed; `dhru` is matched exactly). `allowedIps` takes up to ' +
    `${MAX_ALLOWED_IPS} addresses or CIDR ranges (a bare address is stored as /32 or /128; bits after the prefix are refused); an ` +
    'empty list means any address. `expiresAt` must be in the future. The answer carries the full key once as `secret` ' +
    '(`Cache-Control: no-store`): only a keyed hash is stored, so a lost key cannot be shown again. The per-minute limit is the ' +
    `server default; only staff change it. A merchant may hold ${MAX_LIVE_KEYS} live keys: the next one is \`422\` on \`name\`.`,
  tags: ['api-keys'],
  surface: 'client',
  access: 'merchant-session',
  body: z.object({
    name: KeyName,
    scopes: z.array(z.string().trim().min(1)).min(1, 'Choose at least one scope.').max(20),
    allowedIps: AllowedIps.optional(),
    expiresAt: zIsoDateTime.optional(),
  }),
  success: { status: 201, schema: z.object({ key: ApiKeyRow, secret: z.string() }) },
  errors: [
    'VALIDATION_FAILED',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_PENDING_APPROVAL',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
  ],
  examples: {
    request: {
      name: 'Production server',
      scopes: ['orders:read', 'orders:write', 'account:read'],
      allowedIps: ['203.0.113.55'],
    },
    response: { key: KEY_EXAMPLE, secret: 'gsm_Qx4fD0nQ2hX8mV3vT9cKzY6bJ1aW5eRuLs7NpG4HtM0' },
  },
});

/** `PATCH /client/api-keys/:id`: rename a key or change its allowed addresses. */
export const portalUpdateApiKey = defineRoute({
  key: 'PATCH /client/api-keys/:id',
  summary: 'Rename a key or change its allowed IPs',
  description:
    'A partial body: a missing key stays as it is, `allowedIps: []` removes the restriction. Takes effect on the next call with ' +
    'the key. A revoked key is `409 INVALID_TRANSITION`. Another merchant’s and an unknown key are `404`.',
  tags: ['api-keys'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  body: z.object({ name: KeyName.optional(), allowedIps: AllowedIps.optional() }),
  success: { status: 200, schema: ApiKeyRow },
  errors: [
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'INVALID_TRANSITION',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_PENDING_APPROVAL',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
  ],
  examples: { request: { name: 'Staging server' }, response: { ...KEY_EXAMPLE, name: 'Staging server' } },
});

/** `DELETE /client/api-keys/:id`: revoke a key. */
export const portalRevokeApiKey = defineRoute({
  key: 'DELETE /client/api-keys/:id',
  summary: 'Revoke a key',
  description:
    'The key stops working at once and cannot be turned back on. Revoking a key twice answers `204` both times. Another ' +
    'merchant’s and an unknown key are `404`. The portal writes no audit entry; staff see the key in `GET /admin/clients/:id/api-keys`.',
  tags: ['api-keys'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: [
    'NOT_FOUND',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_PENDING_APPROVAL',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
  ],
});

/** `GET /admin/clients/:id/api-keys`: the keys of one merchant. */
export const adminListClientApiKeys = defineRoute({
  key: 'GET /admin/clients/:id/api-keys',
  summary: 'API keys of a merchant',
  description:
    'A plain array (no paging), newest first, every key including revoked and expired ones. The console derives Active, Revoked ' +
    'and Expired from `revokedAt` and `expiresAt`. Never the hash or the key.',
  tags: ['api-keys'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'api_keys:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: z.array(ApiKeyRow) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: [KEY_EXAMPLE] },
});

/** `DELETE /admin/api-keys/:id`: staff revoke a merchant's key. */
export const adminRevokeApiKey = defineRoute({
  key: 'DELETE /admin/api-keys/:id',
  summary: 'Revoke a merchant API key',
  description:
    'Sets `revokedAt` (the row stays for the orders that used the key and for the audit log). The key stops working at once: its ' +
    'cached view is dropped after the commit. Writes the audit entry `revoked API key of <merchant>`. A key that is already ' +
    'revoked is `409 ALREADY_REVOKED`.',
  tags: ['api-keys'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'api_keys:revoke',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ALREADY_REVOKED'],
});
