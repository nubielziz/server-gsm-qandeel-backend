// Route contracts of API keys (map domain A, stage 7): the read-only list of the keys of an account of a merchant rank under
// /client/api-keys (MISMATCHES B155) and the staff's view, creation, limits and revocation under /admin (identity.md). Merchants no longer
// create, change or revoke keys (decision 067): the three routes of those writes are retired and have no contract. The shape is the
// console's ApiKey (identity-platform-5).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { MAX_ALLOWED_IPS, MAX_LIVE_KEYS, RATE_LIMIT_PER_MIN_RANGE } from '../domain/api-key-input';

/** An API key as the portal and the console read it: never the hash, never the key itself after creation. */
const ApiKeyRow = z.object({
  id: zId,
  clientId: zId,
  name: z.string(),
  prefix: z.string(),
  allowedIps: z.array(z.string()),
  rateLimitPerMin: z.number().int(),
  lastUsedAt: zIsoDateTime.nullable(),
  lastUsedIp: z.string(),
  expiresAt: zIsoDateTime.nullable(),
  revokedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  /** True for a key staff created for the merchant (feature 20); false for one the merchant made itself before decision 067. Optional in the schema, always sent by the server. */
  createdByStaff: z.boolean().optional(),
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
  allowedIps: ['203.0.113.55', '198.51.100.0/24'],
  rateLimitPerMin: 60,
  lastUsedAt: '2026-11-01T09:30:00.000Z',
  lastUsedIp: '203.0.113.55',
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  createdByStaff: false,
} as const;

/** The per-minute limit staff may set: an integer from 1 to 6000. */
const RateLimitPerMin = z
  .number()
  .int('Use a whole number.')
  .min(RATE_LIMIT_PER_MIN_RANGE.min, `Use at least ${RATE_LIMIT_PER_MIN_RANGE.min}.`)
  .max(RATE_LIMIT_PER_MIN_RANGE.max, `Use at most ${RATE_LIMIT_PER_MIN_RANGE.max}.`);

/** `GET /client/api-keys`: the merchant's own keys (read only, decision 067). */
export const portalListApiKeys = defineRoute({
  key: 'GET /client/api-keys',
  summary: 'My API keys',
  description:
    'The keys of the signed-in merchant (an account of a merchant rank; a retail account is `403 RANK_NOT_ALLOWED`): live keys first, then revoked ones, newest first within each group. Only the display ' +
    'prefix is readable; the full key was shown once when it was created. `allowedIps` keeps ranges as written and drops the ' +
    '`/32` or `/128` of a single address; `lastUsedIp` is `""` for a key that was never used. The list is read only: staff make every ' +
    'key and change or revoke it in the console, so there is no route for a merchant to do that (decision 067); a key the merchant made ' +
    'before that keeps working, and `createdByStaff` is `false` on it.',
  tags: ['api-keys'],
  surface: 'client',
  access: 'merchant-session',
  query: listQuery({ sorts: ['createdAt', 'id'], defaultSort: { field: 'createdAt', order: 'desc' } }),
  success: { status: 200, schema: ApiKeyRow },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'],
  examples: { response: [KEY_EXAMPLE] },
});

/** `GET /admin/clients/:id/api-keys`: the keys of one merchant. */
export const adminListClientApiKeys = defineRoute({
  key: 'GET /admin/clients/:id/api-keys',
  summary: 'API keys of a merchant',
  description:
    'A plain array (no paging), newest first, every key including revoked and expired ones, for an account of any rank: an account ' +
    'that left the merchant rank shows the keys it had, all revoked. The console derives Active, Revoked ' +
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

/** `POST /admin/clients/:id/api-keys`: staff create a key for an active merchant, shown once. */
export const adminCreateClientApiKey = defineRoute({
  key: 'POST /admin/clients/:id/api-keys',
  summary: 'Create an API key for a merchant',
  description:
    'Only for an `active` account of a merchant rank (`409 CONFLICT` for a retail rank, `409 NOT_ACTIVE` for a suspended, blocked or ' +
    'erased account: such a key could not be used). The ' +
    `body is \`name\`, \`allowedIps\` and \`expiresAt\` plus \`rateLimitPerMin\` (an integer from ${RATE_LIMIT_PER_MIN_RANGE.min} to ` +
    `${RATE_LIMIT_PER_MIN_RANGE.max}, default 60). The answer carries the full key once as \`secret\` (\`Cache-Control: no-store\`); ` +
    'only a keyed hash is stored, so a lost key cannot be shown again. The key is marked `createdByStaff` and `api_keys.created_by` ' +
    'records the staff member, the merchant is sent a security notice by email, and the audit entry `created API key for <merchant>` ' +
    `never holds the key. A merchant may hold ${MAX_LIVE_KEYS} live keys: the next one is \`422\` on \`name\`. ` +
    'Only an owner may create one (`403 FORBIDDEN` for everyone else, decision 046); a merchant cannot create, change or revoke its own keys (decision 067).',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'api_keys:create',
  params: z.object({ id: zIdParam }),
  body: z.object({
    name: KeyName,
    allowedIps: AllowedIps.optional(),
    expiresAt: zIsoDateTime.optional(),
    rateLimitPerMin: RateLimitPerMin.optional(),
  }),
  success: { status: 201, schema: z.object({ key: ApiKeyRow, secret: z.string() }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'CONFLICT', 'NOT_ACTIVE', 'VALIDATION_FAILED'],
  examples: {
    request: {
      name: 'Production server',
      allowedIps: ['203.0.113.55'],
      rateLimitPerMin: 120,
    },
    response: {
      key: { ...KEY_EXAMPLE, rateLimitPerMin: 120, createdByStaff: true },
      secret: 'gsm_Qx4fD0nQ2hX8mV3vT9cKzY6bJ1aW5eRuLs7NpG4HtM0',
    },
  },
});

/** `PATCH /admin/api-keys/:id`: staff change a key's per-minute limit and allowed addresses. */
export const adminUpdateApiKey = defineRoute({
  key: 'PATCH /admin/api-keys/:id',
  summary: "Change a merchant key's limits",
  description:
    'A partial body with at least one key: `rateLimitPerMin` (an integer from ' +
    `${RATE_LIMIT_PER_MIN_RANGE.min} to ${RATE_LIMIT_PER_MIN_RANGE.max}) and \`allowedIps\` (up to ${MAX_ALLOWED_IPS} addresses or ` +
    'ranges; `[]` removes the restriction). Takes effect on the next call with the key: its cached view is dropped after the commit. ' +
    'A change that gives the key more reach (an empty list, an address that is not stored, a higher limit) needs an owner: ' +
    '`403 FORBIDDEN` for everyone else, judged on the stored key; a narrower list or a lower limit stays under `api_keys:update`. ' +
    'A revoked key is `409 ALREADY_REVOKED`. Writes the audit entry `changed limits of API key of <merchant>` with the old and new values; ' +
    'a change of a value sends the merchant a security notice by email.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'api_keys:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({ rateLimitPerMin: RateLimitPerMin.optional(), allowedIps: AllowedIps.optional() })
    .refine((body) => body.rateLimitPerMin !== undefined || body.allowedIps !== undefined, {
      message: 'Send a limit or the allowed addresses.',
    }),
  success: { status: 200, schema: ApiKeyRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ALREADY_REVOKED', 'VALIDATION_FAILED'],
  examples: { request: { rateLimitPerMin: 300 }, response: { ...KEY_EXAMPLE, rateLimitPerMin: 300 } },
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
