// Route contracts of the code inventory (map domain B, stage 5): the masked list, the import with duplicate detection and
// the void action. Shapes match the console (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-15, MISMATCHES B18).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { INVENTORY_CODE_STATUSES } from '../db/schema';
import { MAX_IMPORT_CODES, MAX_VOID_IDS } from '../domain/inventory-codes';
import { NamedRef } from './shared';

const CodeRow = z.object({
  id: zId,
  maskedCode: z.string().describe('Eight bullets and the last four characters; the clear code is never sent.'),
  serviceId: zId.describe('The id of `service`, as the console mock also sends it (handy for the `serviceId` filter).'),
  service: NamedRef,
  status: z.enum(INVENTORY_CODE_STATUSES),
  orderId: zId.nullable(),
  batchRef: z.string(),
  createdAt: zIsoDateTime,
});

const CODE_EXAMPLE = {
  id: 19,
  maskedCode: '••••••••A1B2',
  serviceId: 16,
  service: { id: 16, name: 'UnlockTool 1-day licence' },
  status: 'available',
  orderId: null,
  batchRef: 'B-0002',
  createdAt: '2026-10-30T08:00:00.000Z',
} as const;

/** `GET /admin/inventory-codes`: the masked stock. */
export const listInventoryCodes = defineRoute({
  key: 'GET /admin/inventory-codes',
  summary: 'List inventory codes',
  description:
    'Stocked codes, newest first by default, masked (`maskedCode` has a fixed length, so no code is decrypted to list it). ' +
    'Filters: `serviceId` and `status`. `q` is a case-insensitive contains over the service name and the batch reference.',
  tags: ['inventory'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'inventory:read',
  query: listQuery({
    sorts: ['createdAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      serviceId: { type: 'id', ops: ['eq'] },
      status: { type: 'enum', values: INVENTORY_CODE_STATUSES, ops: ['eq', 'ne'] },
    },
    search: ['service.name', 'batchRef'],
  }),
  success: { status: 200, schema: CodeRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [CODE_EXAMPLE] },
});

/** `POST /admin/services/:id/inventory/import`: add codes to a service. */
export const importInventoryCodes = defineRoute({
  key: 'POST /admin/services/:id/inventory/import',
  summary: 'Import inventory codes',
  description:
    'One entry per pasted or uploaded line. Each is trimmed. A line shorter than 6 or longer than 128 characters, or with ' +
    'whitespace or a control character inside, is counted in `rejected` (not an error). A code that repeats an earlier line of ' +
    'the batch, or matches a code that is not void of any service, is counted in `duplicates`. The rest is stored encrypted ' +
    '(AES-GCM) with a keyed hash and the last four characters; a clear code is never logged or returned. `batchRef` ' +
    '(1 to 40 of `A-Za-z0-9._-`) names the batch; without it one is generated (`B-0031`). An empty list or more than 10,000 ' +
    'entries is `422` on `codes`; an unknown or archived service is `404`.',
  tags: ['inventory'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'inventory:write',
  params: z.object({ id: zIdParam }),
  body: z.object({
    codes: z
      .array(z.string())
      .min(1, 'Add at least one code.')
      .max(MAX_IMPORT_CODES, `Import at most ${MAX_IMPORT_CODES} codes at a time.`),
    batchRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,40}$/, 'Use 1 to 40 letters, digits, dots, underscores or hyphens.')
      .optional(),
  }),
  success: {
    status: 200,
    schema: z.object({
      imported: z.number().int(),
      duplicates: z.number().int(),
      rejected: z.number().int(),
      batchRef: z.string(),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { codes: ['UT-1000-A1B2', 'UT-1001-C3D4'], batchRef: 'B-0002' },
    response: { imported: 2, duplicates: 0, rejected: 0, batchRef: 'B-0002' },
  },
});

/** `POST /admin/inventory-codes/void`: withdraw unsold codes. */
export const voidInventoryCodes = defineRoute({
  key: 'POST /admin/inventory-codes/void',
  summary: 'Void inventory codes',
  description:
    'Only codes that are `available` become `void`; reserved (an open order holds it), sold, already void or unknown ids are ' +
    'skipped and counted, so a repeat voids nothing twice. An empty list is `422` on `ids`.',
  tags: ['inventory'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'inventory:write',
  body: z.object({
    ids: z
      .array(zId)
      .min(1, 'Tick at least one code.')
      .max(MAX_VOID_IDS, `Void at most ${MAX_VOID_IDS} codes at a time.`),
  }),
  success: { status: 200, schema: z.object({ voided: z.number().int(), skipped: z.number().int() }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: { request: { ids: [19, 20] }, response: { voided: 2, skipped: 0 } },
});
