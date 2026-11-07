// Route contracts of the orders over REST v1 (map domain D, stage 7): place, place in bulk, list, show, cancel and verify, with the
// `Idempotency-Key` of ALIGNMENT § 7. No console screen calls them: the shapes follow ALIGNMENT § 7 (cursor lists, problem+json), B153 (a
// pending merchant's key is refused), B160 (the merchant's order) and decision 025 (the statuses).
import { z } from 'zod';
import { defineRoute, zCursor, zCursorLimit, zCursorPage, zId, zIdParam, zMoney } from '../../../common/contract';
import { ORDER_STATUSES } from '../db/schema';
import { MerchantOrderSchema } from './shared';

/** The most orders one `POST /v1/orders/bulk` may hold (the same limit as a Dhru bulk call). */
export const MAX_V1_BULK_ORDERS = 100;

/** The most ids `GET /v1/orders?ids=` may name. */
const MAX_IDS = 100;

/** The order as REST v1 reads it: the merchant's order of the portal, with the v1 routes named in its two flags. */
export const V1OrderSchema = MerchantOrderSchema.extend({
  canCancel: z.boolean().describe('`POST /v1/orders/:id/cancel` would be accepted now.'),
  canVerify: z.boolean().describe('`POST /v1/orders/:id/verify` would be accepted now.'),
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
  source: 'v1',
  result: { code: 'Unlocked: code 8842 1113', comment: null, fileId: null },
  verificationStatus: null,
  clientNote: null,
  inputFileId: null,
  canCancel: false,
  canVerify: false,
  createdAt: '2026-10-02T06:23:25.000Z',
  completedAt: '2026-10-02T07:01:10.000Z',
} as const;

const PENDING_ORDER_EXAMPLE = {
  ...ORDER_EXAMPLE,
  status: 'pending',
  result: { code: null, comment: null, fileId: null },
  completedAt: null,
} as const;

const V1_ERRORS = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'IP_NOT_ALLOWED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_PENDING_APPROVAL',
  'RATE_LIMITED',
] as const;

const PLACE_ERRORS = [
  ...V1_ERRORS,
  'MAINTENANCE',
  'NOT_FOUND',
  'INSUFFICIENT_FUNDS',
  'SERVICE_DISABLED',
  'PRICE_CHANGED',
  'DUPLICATE_ORDER',
  'INVALID_IMEI',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
] as const;

/** One order to place: the same fields as the portal's `POST /client/orders` without the bulk list. */
const PlaceItem = z.object({
  serviceId: zId.describe('The service (`GET /v1/services`).'),
  imei: z.string().trim().min(1, 'Enter the IMEI.').max(64).optional().describe('The IMEI of an IMEI service.'),
  quantity: z.number().int().min(1).max(100_000).optional().describe("Defaults to the service's minimum."),
  inputs: z
    .record(z.string().min(1).max(60), z.string().max(500))
    .optional()
    .describe("The values of the service's custom fields by field key (`GET /v1/services/:id`)."),
  fileId: zId.optional().describe('The uploaded input file of a File service (`POST /v1/files`).'),
});

const IdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/, 'Use printable characters without spaces.')
    .optional()
    .describe(
      'Makes a retry safe: the first answer is stored with the key and sent again for the same request; another request with the key ' +
        'is `409 IDEMPOTENCY_KEY_REUSED`, one still running `409 IDEMPOTENCY_IN_PROGRESS`.',
    ),
});

const PLACE_DESCRIPTION =
  "Orders a service at the merchant's own price (the one price resolver). The price is held from the wallet in the same transaction. " +
  'An order that would cost more than the tolerance above the price the merchant last listed is refused with `409 PRICE_CHANGED` ' +
  '(`listedPrice` and `currentPrice` in the body: list the services again and order again), a smaller raise is charged and recorded. ' +
  "A second open order for the same service and input is refused under the service's `block_open` rule (`DUPLICATE_ORDER`). An IMEI " +
  'service takes `imei` (15 digits, Luhn); a server or remote service takes `inputs`; a File service a `fileId` and/or `inputs`. The ' +
  'answer is immediate: the order is `pending` (or already `completed` when the service delivers from stock).';

/** `POST /v1/orders`. */
export const placeV1Order = defineRoute({
  key: 'POST /v1/orders',
  summary: 'Place an order',
  description: `${PLACE_DESCRIPTION} Send an \`Idempotency-Key\` so that a retry never places a second order. Scope \`orders:write\`.`,
  tags: ['orders'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:write',
  headers: IdempotencyHeaders,
  body: PlaceItem,
  success: { status: 201, schema: V1OrderSchema },
  errors: [...PLACE_ERRORS],
  examples: {
    request: { serviceId: 5, imei: '352905112490861' },
    response: PENDING_ORDER_EXAMPLE,
  },
});

/** What a refused item of a bulk placement says: the problem of the refusal, without the request id. */
const ItemError = z.object({
  code: z.string().describe('The error code of the refusal, as `POST /v1/orders` would answer it.'),
  status: z.number().int().describe('The HTTP status that single order would have answered.'),
  title: z.string(),
  detail: z.string(),
  errors: z
    .array(z.object({ field: z.string(), code: z.string(), message: z.string() }))
    .optional()
    .describe('Field problems; `field` is relative to the item (`imei`, `inputs.username`).'),
  listedPrice: zMoney.optional().describe('`PRICE_CHANGED`: the price last listed.'),
  currentPrice: zMoney.optional().describe('`PRICE_CHANGED`: the price now.'),
  orderId: zId.optional().describe('`DUPLICATE_ORDER`: the open order.'),
});

/** The result of one item of a bulk placement. */
const BulkItemResult = z.discriminatedUnion('ok', [
  z.object({ index: z.number().int().min(0), ok: z.literal(true), order: V1OrderSchema }),
  z.object({ index: z.number().int().min(0), ok: z.literal(false), error: ItemError }),
]);

/** `POST /v1/orders/bulk`. */
export const placeV1OrdersBulk = defineRoute({
  key: 'POST /v1/orders/bulk',
  summary: 'Place several orders',
  description:
    `Places up to ${MAX_V1_BULK_ORDERS} orders in one request, each item exactly as \`POST /v1/orders\` would (the price, the price guard, ` +
    'the duplicate rule, the hold). The answer has one result per item, in the order sent: `ok: true` with the order, or `ok: false` with the refusal ' +
    '(`code`, `status`, `detail`, field `errors`, and `listedPrice` and `currentPrice` for a changed price). An item that is refused ' +
    'places nothing and never stops the others; the items draw on one wallet in the order sent, so a later item may be refused for lack ' +
    'of funds. The answer is `200` even when every item was refused. An `Idempotency-Key` stores the whole answer and replays it.',
  tags: ['orders'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:write',
  headers: IdempotencyHeaders,
  body: z.object({
    orders: z
      .array(PlaceItem)
      .min(1, 'Send at least one order.')
      .max(MAX_V1_BULK_ORDERS, `At most ${MAX_V1_BULK_ORDERS} orders per request.`),
  }),
  success: { status: 200, schema: z.object({ results: z.array(BulkItemResult) }) },
  errors: [...V1_ERRORS, 'MAINTENANCE', 'VALIDATION_FAILED', 'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_PROGRESS'],
  examples: {
    request: {
      orders: [
        { serviceId: 5, imei: '352905112490861' },
        { serviceId: 5, imei: '354607111076240' },
      ],
    },
    response: {
      results: [
        { index: 0, ok: true, order: PENDING_ORDER_EXAMPLE },
        {
          index: 1,
          ok: false,
          error: {
            code: 'INSUFFICIENT_FUNDS',
            status: 402,
            title: 'Your balance is too low for this order.',
            detail: 'Your balance would go to -3.2000.',
          },
        },
      ],
    },
  },
});

/** A comma separated list (`pending,processing`) or a repeated parameter, read as a list of texts. */
const list = z.union([z.string(), z.array(z.string())]).transform((value) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter((part) => part !== ''),
);

/** `GET /v1/orders`. */
export const listV1Orders = defineRoute({
  key: 'GET /v1/orders',
  summary: 'List orders',
  description:
    "The merchant's orders, newest first, in pages: `limit` (1 to 100, default 50) and `cursor` (the `nextCursor` of the previous page). " +
    'Filters: `status` (one or several, comma separated: `pending,processing`), `ids` (up to 100 order ids, comma separated), `imei` (the ' +
    "order's main input, exact, whitespace ignored) and `updatedSince` (an ISO 8601 time: orders placed or changed at or after it). " +
    'Never cached. Scope `orders:read`.',
  tags: ['orders'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:read',
  query: z.object({
    limit: zCursorLimit,
    cursor: zCursor,
    status: list
      .pipe(z.array(z.enum(ORDER_STATUSES)).min(1).max(ORDER_STATUSES.length))
      .optional()
      .describe('One or several of `pending`, `processing`, `completed`, `rejected`, comma separated.'),
    ids: list
      .pipe(z.array(zIdParam).min(1).max(MAX_IDS))
      .optional()
      .describe(`Up to ${MAX_IDS} order ids, comma separated.`),
    imei: z.string().trim().min(1).max(64).optional().describe("The order's main input, exact."),
    updatedSince: z.iso
      .datetime({ offset: true, error: 'Must be an ISO 8601 time, like 2026-11-01T00:00:00Z.' })
      .transform((text) => new Date(text))
      .optional()
      .describe('Only orders placed or changed at or after this time.'),
  }),
  success: { status: 200, schema: zCursorPage(V1OrderSchema) },
  errors: [...V1_ERRORS, 'VALIDATION_FAILED'],
  examples: { response: { data: [ORDER_EXAMPLE], nextCursor: null } },
});

/** `GET /v1/orders/:id`. */
export const showV1Order = defineRoute({
  key: 'GET /v1/orders/:id',
  summary: 'One order',
  description:
    'The order with its status and result: `status` is `pending`, `processing`, `completed` or `rejected` (refunded); `result.code` is the code ' +
    "of a completed order or the reason of a rejected one. Another merchant's order, like an unknown id, is `404`. Never cached. Scope " +
    '`orders:read`.',
  tags: ['orders'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: V1OrderSchema },
  errors: [...V1_ERRORS, 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: ORDER_EXAMPLE },
});

/** `POST /v1/orders/:id/cancel`. */
export const cancelV1Order = defineRoute({
  key: 'POST /v1/orders/:id/cancel',
  summary: 'Cancel an order',
  description:
    'Cancels an order that was never sent (`pending`, manual or held) when its service allows it (`allowCancel` of the service): the ' +
    'order is rejected as "Cancelled by the merchant" and the hold returns to the wallet. The answer is the order. An order already sent to ' +
    'a supplier is `409 ALREADY_SENT`; a service that does not allow cancellation, or an order already being worked on, is `409 ' +
    'INVALID_TRANSITION`. Scope `orders:write`.',
  tags: ['orders'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:write',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: V1OrderSchema },
  errors: [...V1_ERRORS, 'NOT_FOUND', 'ORDER_NOT_OPEN', 'ALREADY_SENT', 'INVALID_TRANSITION', 'VALIDATION_FAILED'],
  examples: {
    response: {
      ...ORDER_EXAMPLE,
      status: 'rejected',
      result: { code: 'Cancelled by the merchant', comment: null, fileId: null },
    },
  },
});

/** `POST /v1/orders/:id/verify`. */
export const verifyV1Order = defineRoute({
  key: 'POST /v1/orders/:id/verify',
  summary: 'Ask for the verification of a result',
  description:
    'Asks staff to check the result of a completed order (once). Allowed when the service allows verification (`allowVerify`) and ' +
    'inside its window (`verifyWindowH` hours from completion); otherwise `409 INVALID_TRANSITION`. The answer is the order, with ' +
    '`verificationStatus: "requested"`; staff accept the charge or refund it. Scope `orders:write`.',
  tags: ['orders'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:write',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: V1OrderSchema },
  errors: [...V1_ERRORS, 'NOT_FOUND', 'ORDER_NOT_COMPLETED', 'INVALID_TRANSITION', 'VALIDATION_FAILED'],
  examples: { response: { ...ORDER_EXAMPLE, verificationStatus: 'requested' } },
});
