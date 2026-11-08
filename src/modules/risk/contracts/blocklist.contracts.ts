// Route contracts of the blocklist (map domain K, stage 18, scenario b2c-chargeback): list, read, add and remove entries. Shapes are the
// console's (src/features/risk/types: BlocklistEntry, CreateBlocklistBody).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { BLOCKLIST_KINDS, BLOCKLIST_SOURCES } from '../db/schema';
import { ADDABLE_BLOCKLIST_KINDS, MAX_BLOCK_REASON_LENGTH, MAX_FINGERPRINT_LENGTH } from '../domain/blocklist-values';

/** One blocklist entry: no hash, no `updatedAt`. */
export const BlocklistEntrySchema = z.object({
  id: zId,
  kind: z.enum(BLOCKLIST_KINDS),
  display: z
    .string()
    .describe(
      'Server-made and safe to show: a masked email, a domain, an IMEI as "35 389011 884201 9", a shortened card fingerprint.',
    ),
  reason: z.string(),
  expiresAt: zIsoDateTime.nullable().describe('When the entry stops blocking; null for ever.'),
  source: z.enum(BLOCKLIST_SOURCES),
  createdBy: z
    .object({ id: zId, name: z.string() })
    .nullable()
    .describe('The staff member; null for the system (a chargeback).'),
  createdAt: zIsoDateTime,
});

const ENTRY_EXAMPLE = {
  id: 5,
  kind: 'imei',
  display: '35 389011 884201 9',
  reason: 'Reported stolen by the previous owner',
  expiresAt: null,
  source: 'manual',
  createdBy: { id: 2, name: 'Lina S.' },
  createdAt: '2026-11-02T10:30:00.000Z',
} as const;

/** `GET /admin/blocklist`. */
export const listBlocklist = defineRoute({
  key: 'GET /admin/blocklist',
  summary: 'The blocklist',
  description:
    'Blocked emails, domains, IMEIs, card fingerprints, devices and countries (IP addresses live under the IP rules). Filter by ' +
    '`kind`; `q` searches the display text and the reason. Sort by `kind`, `display` or `createdAt` (default, newest first). Values ' +
    'are stored only as hashes: the display text is made when the entry is added.',
  tags: ['blocklist'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:read',
  query: listQuery({
    sorts: ['kind', 'display', 'createdAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { kind: { type: 'enum', values: BLOCKLIST_KINDS } },
    search: ['display', 'reason'],
  }),
  success: { status: 200, schema: BlocklistEntrySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ENTRY_EXAMPLE] },
});

/** `GET /admin/blocklist/:id`. */
export const getBlocklistEntry = defineRoute({
  key: 'GET /admin/blocklist/:id',
  summary: 'One blocklist entry',
  description: 'The same row as the list.',
  tags: ['blocklist'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: BlocklistEntrySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: ENTRY_EXAMPLE },
});

/** The body of `POST /admin/blocklist`. */
export const CreateBlocklistBodySchema = z.object({
  kind: z.enum(ADDABLE_BLOCKLIST_KINDS),
  value: z
    .string()
    .trim()
    .min(1, 'Enter a value.')
    .max(MAX_FINGERPRINT_LENGTH + 50, 'Too long.')
    .describe('The email, domain, IMEI (its 15 digits) or card fingerprint to block.'),
  reason: z
    .string()
    .trim()
    .min(1, 'Say why.')
    .max(MAX_BLOCK_REASON_LENGTH, `Use at most ${MAX_BLOCK_REASON_LENGTH} characters.`),
});

/** `POST /admin/blocklist`. */
export const createBlocklistEntry = defineRoute({
  key: 'POST /admin/blocklist',
  summary: 'Add to the blocklist',
  description:
    'Adds a manual entry (`source` manual, never expires). The server normalises the value (lower-case email and domain, digits ' +
    'only for an IMEI), stores only its hash and derives the display text. A value that is already blocked is `409 ALREADY_BLOCKED` ' +
    'with no `errors[]`. `422` names `value` when it does not fit its kind (an IMEI needs 15 digits: "An IMEI has 15 digits."). ' +
    'Devices and countries cannot be added by hand. Audited as `added to blocklist`.',
  tags: ['blocklist'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:create',
  body: CreateBlocklistBodySchema,
  success: { status: 201, schema: BlocklistEntrySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'ALREADY_BLOCKED', 'VALIDATION_FAILED'],
  examples: {
    request: { kind: 'imei', value: '353890118842019', reason: 'Reported stolen by the previous owner' },
    response: ENTRY_EXAMPLE,
  },
});

/** `DELETE /admin/blocklist/:id`. */
export const deleteBlocklistEntry = defineRoute({
  key: 'DELETE /admin/blocklist/:id',
  summary: 'Remove from the blocklist',
  description:
    'Removes an entry of any source (manual, auto or chargeback); whatever it blocked can order again. Audited as `removed from ' +
    'blocklist`.',
  tags: ['blocklist'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
