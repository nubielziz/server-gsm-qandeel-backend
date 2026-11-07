// Route contracts of the supplier chain of a service (PUT /admin/services/:id/supplier-links) and of the supplier call log
// (/admin/supplier-api-logs), stage 6. Shapes match the console's `src/features/suppliers/types` (resolutions orders-suppliers-3).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zJsonObject } from '../../../common/contract';
import { SUPPLIER_CALL_OUTCOMES } from '../db/schema';

/** `PUT /admin/services/:id/supplier-links`. */
export const replaceSupplierLinks = defineRoute({
  key: 'PUT /admin/services/:id/supplier-links',
  summary: 'Replace the supplier chain of a service',
  description:
    'The whole chain in one call: `links` in priority order (priorities are renumbered 1..n from the order given, then by the ' +
    'priority sent); `[]` unlinks the service, and its new orders wait for manual dispatch. A link that stays keeps its field map and ' +
    "its switch. The service's effective cost is recomputed from the first active link and the catalog price version moves. An unknown " +
    'or repeated supplier service is `422` on `links`.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    links: z
      .array(
        z.object({
          supplierServiceId: zId,
          priority: z.number().int('Enter a whole number.').min(1, 'Priorities start at 1.').max(1000),
        }),
      )
      .max(50, 'Use at most 50 links.'),
  }),
  success: {
    status: 200,
    schema: z.array(
      z.object({
        priority: z.number().int(),
        supplierId: zId,
        supplierName: z.string(),
        supplierServiceId: zId,
        supplierServiceName: z.string(),
      }),
    ),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: {
      links: [
        { supplierServiceId: 91, priority: 1 },
        { supplierServiceId: 140, priority: 2 },
      ],
    },
    response: [
      {
        priority: 1,
        supplierId: 2,
        supplierName: 'Gulf Server Hub',
        supplierServiceId: 91,
        supplierServiceName: 'Chimera 1 month',
      },
      {
        priority: 2,
        supplierId: 3,
        supplierName: 'Rapid IMEI',
        supplierServiceId: 140,
        supplierServiceName: 'Chimera 30 days',
      },
    ],
  },
});

/** A call of the supplier log without its bodies. */
const LogRow = z.object({
  id: zId,
  supplierId: zId,
  orderId: zId.nullable().describe('`null` for a test or a sync.'),
  action: z.string().describe('`placeimeiorder`, `getimeiorder`, `accountinfo`, `imeiservicelist`.'),
  httpStatus: z.number().int().describe('`0` when there was no HTTP answer (timeout, connection refused).'),
  durationMs: z.number().int().describe('The time waited, always measured.'),
  error: z.string().describe('`""` when the call worked, else the reason.'),
  createdAt: zIsoDateTime,
});

const LOG_EXAMPLE = {
  id: 9021,
  supplierId: 2,
  orderId: 48102,
  action: 'placeimeiorder',
  httpStatus: 200,
  durationMs: 640,
  error: '',
  createdAt: '2026-11-07T08:12:30.000Z',
} as const;

/** `GET /admin/supplier-api-logs`. */
export const listSupplierApiLogs = defineRoute({
  key: 'GET /admin/supplier-api-logs',
  summary: 'List supplier calls',
  description:
    'Every call we made to a supplier, newest first, without the request and response bodies. Filters: `supplierId`, `orderId`, ' +
    '`action`, `outcome` (`ok`, `error`, `timeout`). Credentials are never stored and IMEIs are masked.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:read',
  query: listQuery({
    sorts: ['createdAt', 'id', 'durationMs', 'httpStatus'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      supplierId: { type: 'id' },
      orderId: { type: 'id' },
      action: { type: 'string' },
      outcome: { type: 'enum', values: SUPPLIER_CALL_OUTCOMES },
    },
  }),
  success: { status: 200, schema: LogRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [LOG_EXAMPLE] },
});

/** `GET /admin/supplier-api-logs/:id`. */
export const showSupplierApiLog = defineRoute({
  key: 'GET /admin/supplier-api-logs/:id',
  summary: 'Show a supplier call',
  description:
    'The list row plus the request and the response, with secrets and IMEIs masked when the call was written.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:read',
  params: z.object({ id: zIdParam }),
  success: {
    status: 200,
    schema: LogRow.extend({
      request: zJsonObject.describe('`{}` when nothing was sent (a call that never left).'),
      response: zJsonObject.describe('`{}` when no answer arrived (a timeout, a refused connection).'),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: {
    response: {
      ...LOG_EXAMPLE,
      request: { action: 'placeimeiorder', parameters: { ID: '4411', IMEI: '••••••••••••0861', QNT: 1 } },
      response: { SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: '88121' }], apiversion: '6.1' },
    },
  },
});
