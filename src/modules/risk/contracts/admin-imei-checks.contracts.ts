// Route contracts of the staff IMEI log (map domain K, stage 18, RESOLUTIONS b2c-3 and b2c-4): list and read the checks. Shapes are the
// console's (src/features/risk/types: ImeiCheck). The storefront check itself is in imei-check.contracts.ts.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zJsonObject, zMoney } from '../../../common/contract';
import { IMEI_CHECK_SOURCES, IMEI_CHECK_STATUSES, IMEI_CHECK_TYPES } from '../db/schema';

const NamedRef = z.object({ id: zId, name: z.string() });

/** One IMEI check as the staff log shows it. */
export const AdminImeiCheckSchema = z.object({
  id: zId,
  imei: z
    .string()
    .describe(
      'The 15 digits while they are stored; after an erasure the TAC followed by bullets up to 15 characters (15 bullets when the TAC is unknown).',
    ),
  brand: z.string(),
  model: z.string(),
  checkType: z.enum(IMEI_CHECK_TYPES),
  status: z.enum(IMEI_CHECK_STATUSES),
  source: z.enum(IMEI_CHECK_SOURCES),
  country: z.string().nullable().describe('ISO 3166-1 alpha-2, upper case; null when unknown.'),
  ip: z.string().nullable(),
  orderId: zId.nullable().describe('The order the check led to (through its checkout session); null when none.'),
  customer: NamedRef.nullable(),
  supplier: NamedRef.nullable(),
  result: zJsonObject.nullable().describe('What the lookup returned, free-form.'),
  cost: zMoney,
  price: zMoney,
  cachedUntil: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

const CHECK_EXAMPLE = {
  id: 9840,
  imei: '353890110000004',
  brand: 'Apple',
  model: 'iPhone 13',
  checkType: 'basic',
  status: 'unknown',
  source: 'storefront_free',
  country: 'GB',
  ip: '203.0.113.25',
  orderId: null,
  customer: null,
  supplier: null,
  result: { stage: 'basic', checksum: 'valid', tac: 'known' },
  cost: '0.0000',
  price: '0.0000',
  cachedUntil: null,
  createdAt: '2026-11-08T08:00:00.000Z',
} as const;

/** `GET /admin/imei-checks`. */
export const listImeiChecks = defineRoute({
  key: 'GET /admin/imei-checks',
  summary: 'The IMEI check log',
  description:
    'Every IMEI check, free or before an order. Filters: `checkType`, `status`, `source`. `q` is an IMEI (15 digits: matched through ' +
    'the keyed hash), a TAC (8 to 14 digits, or a shorter prefix) or text matched against the brand and the model. Sort by `model`, ' +
    '`checkType`, `status` or `createdAt` (default, newest first). The IMEI is decrypted for the answer; after the retention period ' +
    'or an anonymization it is erased and shown as the TAC and bullets.',
  tags: ['imei-checks'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:read',
  query: listQuery({
    sorts: ['model', 'checkType', 'status', 'createdAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      checkType: { type: 'enum', values: IMEI_CHECK_TYPES },
      status: { type: 'enum', values: IMEI_CHECK_STATUSES },
      source: { type: 'enum', values: IMEI_CHECK_SOURCES },
    },
    search: ['brand', 'model'],
  }),
  success: { status: 200, schema: AdminImeiCheckSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [CHECK_EXAMPLE] },
});

/** `GET /admin/imei-checks/:id`. */
export const getImeiCheck = defineRoute({
  key: 'GET /admin/imei-checks/:id',
  summary: 'One IMEI check',
  description: 'The same row as the list.',
  tags: ['imei-checks'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: AdminImeiCheckSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: CHECK_EXAMPLE },
});
