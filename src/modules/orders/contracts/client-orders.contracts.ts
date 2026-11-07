// Route contracts of the merchant portal's orders (map domain D, stage 5): the dashboard, placing an order (or a bulk of IMEIs),
// the list, one order with its timeline, cancel, verify and the CSV export. The console has no screen for these (the merchant portal is
// another frontend): the shapes follow ALIGNMENT § 7, B121, B153 and decision 025, and are written up in the module README.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zMoney } from '../../../common/contract';
import { SERVICE_TYPES } from '../../catalog';
import { ORDER_STATUSES } from '../db/schema';
import { MerchantEventSchema, MerchantOrderSchema, ORDER_SORTS } from './shared';

/** The most IMEIs one bulk order may hold (the same limit as REST v1's `POST /v1/orders/bulk`). */
export const MAX_BULK_IMEIS = 100;

const MERCHANT_ORDER_QUERY = listQuery({
  sorts: ORDER_SORTS,
  defaultSort: { field: 'createdAt', order: 'desc' },
  filters: {
    status: { type: 'enum', values: ORDER_STATUSES, ops: ['eq', 'ne'] },
    type: { type: 'enum', values: SERVICE_TYPES, ops: ['eq'] },
    serviceId: { type: 'id', ops: ['eq'] },
    createdAt: { type: 'datetime' },
  },
  search: ['id', 'imei', 'service.name'],
});

const ORDER_EXAMPLE = {
  id: 48101,
  status: 'completed',
  imei: '352905112490861',
  quantity: 1,
  inputs: {},
  unitPrice: '16.2600',
  totalPrice: '16.2600',
  currency: 'USD',
  service: { id: 5, name: 'AT&T USA Premier Unlock', type: 'imei' },
  source: 'portal',
  result: { code: 'Unlocked: code 8842 1113', comment: null, fileId: null },
  verificationStatus: null,
  clientNote: null,
  inputFileId: null,
  canCancel: false,
  canVerify: false,
  createdAt: '2026-10-02T06:23:25.000Z',
  completedAt: '2026-10-02T07:01:10.000Z',
} as const;

const WALLET = z.object({
  balance: zMoney.describe('The wallet balance; negative while credit is in use.'),
  reserved: zMoney.describe('Held for open orders.'),
  creditLimit: zMoney,
  available: zMoney.describe('Spendable now: balance plus credit limit.'),
});

/** `GET /client/dashboard`. */
export const getMyDashboard = defineRoute({
  key: 'GET /client/dashboard',
  summary: 'My dashboard',
  description:
    "The signed-in merchant's wallet figures (`balance`, `reserved`, `creditLimit`, `available`), the number of its orders in each " +
    'status, the number still open and its five latest orders. Never cached.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  success: {
    status: 200,
    schema: z.object({
      wallet: WALLET,
      counts: z.object({
        pending: z.number().int().min(0),
        processing: z.number().int().min(0),
        completed: z.number().int().min(0),
        rejected: z.number().int().min(0),
      }),
      openOrders: z.number().int().min(0).describe('`pending` plus `processing`.'),
      latestOrders: z.array(MerchantOrderSchema),
    }),
  },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL'],
  examples: {
    response: {
      wallet: { balance: '1209.7500', reserved: '71.2300', creditLimit: '2000.0000', available: '3209.7500' },
      counts: { pending: 2, processing: 1, completed: 48, rejected: 3 },
      openOrders: 3,
      latestOrders: [ORDER_EXAMPLE],
    },
  },
});

/** The body of `POST /client/orders`. */
const PlaceOrderBody = z
  .object({
    serviceId: zId,
    imei: z.string().trim().min(1, 'Enter the IMEI.').max(64).optional().describe('The IMEI of an IMEI service.'),
    imeis: z
      .array(z.string().trim().min(1, 'Enter the IMEI.').max(64))
      .min(1, 'Add at least one IMEI.')
      .max(MAX_BULK_IMEIS, `At most ${MAX_BULK_IMEIS} IMEIs per bulk order.`)
      .optional()
      .describe('A bulk order: one order of the same service per IMEI, placed all together or not at all.'),
    quantity: z.number().int().min(1).max(100_000).optional().describe("Defaults to the service's minimum."),
    inputs: z
      .record(z.string().min(1).max(60), z.string().max(500))
      .optional()
      .describe("The values of the service's custom fields by field key (`GET /client/services/:id`)."),
    fileId: zId.optional().describe('The uploaded input file of a File service.'),
  })
  .refine((body) => body.imei === undefined || body.imeis === undefined, {
    message: 'Send imei or imeis, not both.',
    path: ['imeis'],
  });

/** `POST /client/orders`. */
export const placeClientOrder = defineRoute({
  key: 'POST /client/orders',
  summary: 'Place an order',
  description:
    "Orders a service at the merchant's own price (the one price resolver). The price is held from the wallet in the same transaction; " +
    'an order that would cost more than the tolerance above the price the merchant last listed is refused (`PRICE_CHANGED`, with both ' +
    'prices), a smaller raise is charged and recorded; a second open order for the same service and input is refused under the ' +
    "service's `block_open` rule (`DUPLICATE_ORDER`). An IMEI service takes `imei` (15 digits, Luhn) or `imeis` (a bulk of up to 100: " +
    'one order each, all placed or none); a server or remote service takes `inputs`; a File service a `fileId` and/or `inputs`. The ' +
    'answer is immediate: the orders are `pending`, in the manual queue or waiting for the dispatch job.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  body: PlaceOrderBody,
  success: { status: 201, schema: z.object({ orders: z.array(MerchantOrderSchema) }) },
  errors: [
    'UNAUTHORIZED',
    'ACCOUNT_PENDING_APPROVAL',
    'CSRF_FAILED',
    'NOT_FOUND',
    'INSUFFICIENT_FUNDS',
    'SERVICE_DISABLED',
    'PRICE_CHANGED',
    'DUPLICATE_ORDER',
    'INVALID_IMEI',
    'VALIDATION_FAILED',
  ],
  examples: {
    request: { serviceId: 5, imei: '352905112490861' },
    response: {
      orders: [
        { ...ORDER_EXAMPLE, status: 'pending', result: { code: null, comment: null, fileId: null }, completedAt: null },
      ],
    },
  },
});

/** `GET /client/orders`. */
export const listClientOrders = defineRoute({
  key: 'GET /client/orders',
  summary: 'My orders',
  description:
    "The signed-in merchant's orders. Filters: `status` (repeat for IN, `status_ne`), `type`, `serviceId`, `createdAt_gte` and " +
    '`createdAt_lte`. `q` searches the input and the service name, and the order id exactly when it is all digits. Sort by ' +
    '`createdAt` (default, newest first), `totalPrice` or `status`. Never cached.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  query: MERCHANT_ORDER_QUERY,
  success: { status: 200, schema: MerchantOrderSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'VALIDATION_FAILED'],
  examples: { response: [ORDER_EXAMPLE] },
});

/** `GET /client/orders/export`. */
export const exportClientOrders = defineRoute({
  key: 'GET /client/orders/export',
  summary: 'Export my orders as CSV',
  description:
    "The merchant's orders that match the same filters, `q` and sort as `GET /client/orders` as `text/csv` (`Content-Disposition: " +
    'attachment`). Columns: `id,created,service,input,quantity,status,price,currency`; never cost or supplier. More than 100,000 ' +
    'matching orders is `422`. Streamed, never cached.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  query: z.record(z.string(), z.unknown()).pipe(MERCHANT_ORDER_QUERY),
  success: { status: 200, contentType: 'text/csv' },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'VALIDATION_FAILED'],
});

/** `GET /client/orders/:id`. */
export const showClientOrder = defineRoute({
  key: 'GET /client/orders/:id',
  summary: 'One of my orders',
  description:
    'The order with its timeline: the lines the merchant may see (placement, hold, acceptance, completion, rejection, release, refund, ' +
    "reopen, verification), never a note, a supplier line, a risk line or the settlement. Another merchant's order is `404`.",
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: MerchantOrderSchema.extend({ events: z.array(MerchantEventSchema) }) },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: {
      ...ORDER_EXAMPLE,
      events: [{ id: 1, type: 'created', message: 'Order received via Portal', createdAt: '2026-10-02T06:23:25.000Z' }],
    },
  },
});

/** `POST /client/orders/:id/cancel`. */
export const cancelClientOrder = defineRoute({
  key: 'POST /client/orders/:id/cancel',
  summary: 'Cancel an order',
  description:
    'Cancels an order that was never sent (`pending`, manual or held) when its service allows it: the order is rejected as ' +
    '"Cancelled by the merchant" and the hold returns to the wallet. An order already sent to a supplier is `409 ALREADY_SENT`; a ' +
    'service that does not allow cancellation, or an order already being worked on, is `409 INVALID_TRANSITION`.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  body: z.object({}),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'ACCOUNT_PENDING_APPROVAL',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_OPEN',
    'ALREADY_SENT',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: {} },
});

/** `POST /client/orders/:id/verify`. */
export const verifyClientOrder = defineRoute({
  key: 'POST /client/orders/:id/verify',
  summary: 'Ask for the verification of a result',
  description:
    'Asks staff to check the result of a completed order (once). Allowed when the service allows verification and inside its window ' +
    '(`verify_window_h` hours from completion); otherwise `409 INVALID_TRANSITION`. The order enters the verification queue; staff ' +
    'accept the charge or refund it.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  body: z.object({}),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'ACCOUNT_PENDING_APPROVAL',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_COMPLETED',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: {} },
});
