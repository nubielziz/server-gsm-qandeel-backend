// Route contracts of the admin order reads (map domain D, stage 5): the list, one order, its timeline and the CSV export. Shapes match
// the console's `Order` and `OrderEvent` (docs/contract/endpoints/orders.md).
import { z } from 'zod';
import { defineRoute, listQuery, zIdParam } from '../../../common/contract';
import { SERVICE_TYPES } from '../../catalog';
import { ORDER_STATUSES } from '../db/schema';
import { ORDER_QUEUES, ORDER_SORTS, StaffEventSchema, StaffOrderSchema } from './shared';

/**
 * The list dialect of the staff order list, shared by the list route and the export.
 *
 * Why: the console filters by status (repeat the key for IN), queue (derived), type, supplier, merchant, customer, channel and
 * `pastSla`, searches with `q` and sorts by `createdAt`, `totalPrice` or `status`; the export takes the same parameters.
 */
const STAFF_ORDER_QUERY = listQuery({
  sorts: ORDER_SORTS,
  defaultSort: { field: 'createdAt', order: 'desc' },
  filters: {
    status: { type: 'enum', values: ORDER_STATUSES, ops: ['eq'] },
    queue: { type: 'enum', values: ORDER_QUEUES, ops: ['eq'] },
    type: { type: 'enum', values: SERVICE_TYPES, ops: ['eq'] },
    supplierId: { type: 'id', ops: ['eq'] },
    clientId: { type: 'id', ops: ['eq'] },
    customerId: { type: 'id', ops: ['eq'] },
    channel: { type: 'enum', values: ['b2b', 'b2c'], ops: ['eq'] },
    pastSla: { type: 'boolean' },
  },
  search: ['id', 'imei', 'supplierRef', 'client.name', 'customer.name', 'service.name'],
});

const SNAPSHOT = {
  source: 'base',
  price: '16.2600',
  rawPrice: '16.2600',
  floor: '14.3100',
  clamped: false,
  ruleId: null,
  fx: 1,
  taxRate: 0,
  steps: [],
};

const ORDER_EXAMPLE = {
  id: 48101,
  createdAt: '2026-10-02T06:23:25.000Z',
  taxAmount: '0.0000',
  currency: 'USD',
  dispatchState: 'done',
  imei: '352905112490861',
  quantity: 1,
  inputs: {},
  unitPrice: '16.2600',
  totalPrice: '16.2600',
  unitCost: '13.5000',
  totalCost: '13.5000',
  pricingSnapshot: SNAPSHOT,
  status: 'completed',
  queue: null,
  reviewReason: null,
  channel: 'b2b',
  source: 'dhru',
  service: { id: 5, name: 'AT&T USA Premier Unlock', type: 'imei', slaMinutes: 1440, category: 'Carrier unlock' },
  client: { id: 8, name: 'Casablanca Unlock' },
  customer: null,
  supplier: { id: 1, name: 'Nordic GSM' },
  supplierRef: 'NG-8841',
  attempts: 1,
  result: { code: 'Unlocked: code 8842 1113', comment: null, fileId: null },
  verificationStatus: null,
  inputFileId: null,
  clientNote: null,
  adminNote: null,
  sentAt: '2026-10-02T06:23:28.000Z',
  completedAt: '2026-10-02T07:01:10.000Z',
} as const;

/** `GET /admin/orders`. */
export const listOrders = defineRoute({
  key: 'GET /admin/orders',
  summary: 'List orders',
  description:
    'Merchant and storefront orders with their queues. Filters (repeat a key for IN): `status`, `queue` (`pending`, `manual`, ' +
    '`needs_attention`, `verification`, `review`; derived from the status and the dispatch state, decision 025), `type`, `supplierId`, ' +
    '`clientId`, `customerId`, `channel` (`b2b`, `b2c`) and `pastSla=true` (an open order older than its service SLA, one age-only ' +
    'predicate shared with the dashboard and System health). `q` searches the input, the supplier reference and the service, merchant ' +
    'and customer names, and the order id exactly when it is all digits. Sort by `createdAt` (default, newest first), `totalPrice` or ' +
    '`status`. Never cached.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:read',
  query: STAFF_ORDER_QUERY,
  success: { status: 200, schema: StaffOrderSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ORDER_EXAMPLE] },
});

/** `GET /admin/orders/export`. */
export const exportOrders = defineRoute({
  key: 'GET /admin/orders/export',
  summary: 'Export orders as CSV',
  description:
    'Every order that matches the same filters, `q` and sort as `GET /admin/orders` (`_start` and `_end` are ignored) as `text/csv` with ' +
    '`Content-Disposition: attachment`. Columns: `id,created,channel,buyer,service,input,status,supplier,price,cost`; CRLF line ends, ' +
    'cells that start with `=`, `+`, `-` or `@` are written as text. The matching rows are counted first: more than 100,000 is ' +
    '`422` ("Too many rows (N); narrow the filters (max 100000)"). The file is streamed. Every export writes an audit row.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:read',
  query: z.record(z.string(), z.unknown()).pipe(STAFF_ORDER_QUERY),
  success: { status: 200, contentType: 'text/csv' },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
});

/** `GET /admin/orders/:id`. */
export const showOrder = defineRoute({
  key: 'GET /admin/orders/:id',
  summary: 'Show an order',
  description: 'One order in the shape of a list row. Read after every action and for deep links. Never cached.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: StaffOrderSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: ORDER_EXAMPLE },
});

/** `GET /admin/orders/:id/events`. */
export const listOrderEvents = defineRoute({
  key: 'GET /admin/orders/:id/events',
  summary: 'The timeline of an order',
  description:
    'Every `order_events` row of the order, oldest first, as a bare array (no paging). Internal notes appear here and never reach ' +
    'the merchant, the storefront or REST v1. The console shows `data.message` as it is.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: z.array(StaffEventSchema) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        id: 1,
        type: 'created',
        fromStatus: null,
        toStatus: null,
        actor: { type: 'client', id: 8, name: 'Casablanca Unlock' },
        data: { message: 'Order received via Dhru API', source: 'dhru' },
        createdAt: '2026-10-02T06:23:25.000Z',
      },
    ],
  },
});
