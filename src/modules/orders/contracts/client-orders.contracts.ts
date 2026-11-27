// Route contracts of the merchant portal's orders (map domain D, stage 5): the dashboard, placing an order (or a bulk of IMEIs),
// the list, one order with its timeline, cancel, verify and the CSV export. The console has no screen for these (the merchant portal is
// another frontend): the shapes follow ALIGNMENT § 7, B121, B153 and decision 025, and are written up in the module README.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zMoney, zSignedMoney } from '../../../common/contract';
import { SERVICE_TYPES } from '../../catalog';
import { ORDER_STATUSES } from '../db/schema';
import { IDEMPOTENCY_WINDOW_DAYS } from '../domain/idempotency-window';
import { CANCEL_WINDOW_MS } from '../domain/merchant-actions';
import { MAX_INPUT_LENGTH, MAX_RAW_INPUT_LENGTH } from '../domain/placement-rules';
import { IdempotencyHeaders } from './idempotency-headers';
import { MerchantEventSchema, MerchantOrderSchema, ORDER_SORTS, OrderAnswerSchema } from './shared';

/** The most IMEIs one bulk order may hold (the same limit as a Dhru bulk call). */
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
  inputFileId: null,
  canCancel: false,
  cancelUntil: null,
  cancelBlocked: 'closed',
  canVerify: false,
  verifyUntil: null,
  verifyBlocked: 'not_allowed',
  createdAt: '2026-10-02T06:23:25.000Z',
  completedAt: '2026-10-02T07:01:10.000Z',
} as const;

/** A website order of a service that allows cancellation, just placed: it waits two minutes before it is sent (decision 075). */
const PLACED_EXAMPLE = {
  ...ORDER_EXAMPLE,
  status: 'pending',
  result: { code: null, comment: null, fileId: null },
  canCancel: true,
  cancelUntil: '2026-10-02T06:25:25.000Z',
  cancelBlocked: null,
  verifyBlocked: 'not_completed',
  completedAt: null,
} as const;

const WALLET = z.object({
  balance: zSignedMoney.describe('The wallet balance; negative while credit is in use.'),
  reserved: zMoney.describe('Held for open orders.'),
  creditLimit: zMoney,
  available: zSignedMoney.describe('Spendable now: balance plus credit limit.'),
});

/** `GET /client/dashboard`. */
export const getMyDashboard = defineRoute({
  key: 'GET /client/dashboard',
  summary: 'My dashboard',
  description:
    "The signed-in merchant's wallet figures (`balance`, `reserved`, `creditLimit`, `available`), the number of its orders in each " +
    'status, the number still open and its five latest orders. Only orders placed through the portal and the Dhru API count: an order the ' +
    "same account paid first in the shop is not part of the portal's figures. Never cached.",
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
  errors: ['UNAUTHORIZED'],
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
    imei: z
      .string()
      .trim()
      .min(1, 'Enter the IMEI.')
      .max(64)
      .optional()
      .describe(
        'The main input of an IMEI service, from older pages: the value of its main-input field (it wins over a value sent under that ' +
          "field's key; a service without such a field takes it as sent). The shop now types it into the field (`inputs`).",
      ),
    imeis: z
      .array(z.string().trim().min(1, 'Enter the IMEI.').max(64))
      .min(1, 'Add at least one IMEI.')
      .max(MAX_BULK_IMEIS, `At most ${MAX_BULK_IMEIS} IMEIs per bulk order.`)
      .optional()
      .describe(
        'A bulk order: one order of the same service per item, each the value of the main-input field like `imei`, placed all together ' +
          'or not at all. Still accepted; the shop no longer sends it. Unrelated to a field of type `imei_bulk`, whose list is the value ' +
          'of one field of one order (decision 076).',
      ),
    quantity: z.number().int().min(1).max(100_000).optional().describe("Defaults to the service's minimum."),
    inputs: z
      .record(z.string().min(1).max(60), z.string().max(MAX_RAW_INPUT_LENGTH))
      .optional()
      .describe(
        "The values of the service's custom fields by field key (`GET /client/services/:id`), each judged by its field's type, " +
          "required tick and pattern and stored in its type's form (an `imei` as digits, an `imei_bulk` list one IMEI per line, a " +
          `\`mac_address\` as \`AA:BB:CC:DD:EE:FF\`; decisions 073 and 076). At most ${MAX_RAW_INPUT_LENGTH} characters as sent; the ` +
          `stored form at most ${MAX_INPUT_LENGTH} (\`too_long\` on \`inputs.<key>\`; an \`imei_bulk\` list of more than 30 IMEIs is ` +
          '`too_many_imeis` first).',
      ),
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
    "service's `block_open` rule (`DUPLICATE_ORDER`). Every service takes its custom fields in `inputs`, each judged by its own type, " +
    'required tick and pattern (decision 073: the service type `imei` forces nothing); a field of type `imei` holds one IMEI (spaces and ' +
    'dashes removed, 15 digits, Luhn; else `422 INVALID_IMEI` with `invalid_imei` on `inputs.<key>`) and is stored as digits. Decision ' +
    '076: a field of type `imei_bulk` holds 1 to 30 IMEIs, still one order at one price (a bad line is `422 INVALID_IMEI`), and the other ' +
    'check types (`imeisv`, `serial`, `iccid`, `eid`, `meid`, `ecid`, `mac_address`, `mi_lock_code`, `box_sn`) answer `422 ' +
    'VALIDATION_FAILED` with `invalid_<type>` on `inputs.<key>`. On an IMEI ' +
    'service the main input may also come as `imei` (older pages; it is the value of the main-input field, wins over a value under its ' +
    'key and is reported on `imei`; a service without such a field takes it as sent) or `imeis` (a bulk of up to 100: one order each, ' +
    'all placed or none, each item reported on `imeis.N`; still accepted, the shop no longer sends it); `imei` on another service is ' +
    '`422 not_applicable`. A File service takes a `fileId` and/or `inputs`. The ' +
    'answer is immediate: the orders are `pending`, in the manual queue or waiting for the dispatch job. An order of a service that allows ' +
    `cancellation waits ${CANCEL_WINDOW_MS / 60_000} minutes before it is sent, so the merchant can still cancel it (\`cancelUntil\`, decision 075). ` +
    'Send an `Idempotency-Key` (a new ' +
    'one per form submission) so that a double click or a retry never places or holds twice: the same key and body sends the first `201` ' +
    'again with the response header `idempotency-replayed: true` (nothing is placed); another body with the key is `409 ' +
    'IDEMPOTENCY_KEY_REUSED`, one still running `409 IDEMPOTENCY_IN_PROGRESS` (`Retry-After`). A refused request stores nothing, so the key ' +
    `may be sent again. The answer is kept ${IDEMPOTENCY_WINDOW_DAYS} days; a replay is the first answer as it was (the orders may have moved on). ` +
    'Without the header nothing changes. An account that is not active is refused with `403 ACCOUNT_SUSPENDED` and a frozen merchant wallet with ' +
    '`409 WALLET_FROZEN`; nothing is written (a retail rank never reaches this route: `403 RANK_NOT_ALLOWED`).',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  headers: IdempotencyHeaders,
  body: PlaceOrderBody,
  success: { status: 201, schema: z.object({ orders: z.array(MerchantOrderSchema) }) },
  errors: [
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'CSRF_FAILED',
    'NOT_FOUND',
    'INSUFFICIENT_FUNDS',
    'WALLET_FROZEN',
    'SERVICE_DISABLED',
    'PRICE_CHANGED',
    'DUPLICATE_ORDER',
    'INVALID_IMEI',
    'VALIDATION_FAILED',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ],
  examples: {
    request: { serviceId: 5, inputs: { imei: '352905112490861' } },
    response: { orders: [PLACED_EXAMPLE] },
  },
});

/** `GET /client/orders`. */
export const listClientOrders = defineRoute({
  key: 'GET /client/orders',
  summary: 'My orders',
  description:
    "The signed-in account's orders placed through the portal and the Dhru API (an order the same account paid first in the shop is not " +
    'listed here: it is in `GET /store/v1/me/orders`). Filters: `status` (repeat for IN, `status_ne`), `type`, `serviceId`, `createdAt_gte` and ' +
    '`createdAt_lte`. `q` searches the input and the service name, and the order id exactly when it is all digits. Sort by ' +
    '`createdAt` (default, newest first), `totalPrice` or `status`. Each order says whether it can be cancelled or verified now, until ' +
    'when (`cancelUntil`, `verifyUntil`) and, when not, why (`cancelBlocked`, `verifyBlocked`; decision 075). Never cached.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  query: MERCHANT_ORDER_QUERY,
  success: { status: 200, schema: MerchantOrderSchema },
  errors: ['UNAUTHORIZED', 'VALIDATION_FAILED'],
  examples: { response: [ORDER_EXAMPLE] },
});

/** `GET /client/orders/export`. */
export const exportClientOrders = defineRoute({
  key: 'GET /client/orders/export',
  summary: 'Export my orders as CSV',
  description:
    "The account's portal and Dhru orders that match the same filters, `q` and sort as `GET /client/orders` as `text/csv` (`Content-Disposition: " +
    'attachment`). Columns: `id,created,service,input,quantity,status,price,currency`; never cost or supplier. More than 100,000 ' +
    'matching orders is `422`. Streamed, never cached.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  query: z.record(z.string(), z.unknown()).pipe(MERCHANT_ORDER_QUERY),
  success: { status: 200, contentType: 'text/csv' },
  errors: ['UNAUTHORIZED', 'VALIDATION_FAILED'],
});

/** `GET /client/orders/:id`. */
export const showClientOrder = defineRoute({
  key: 'GET /client/orders/:id',
  summary: 'One of my orders',
  description:
    'The order with its timeline: the lines the merchant may see (placement, hold, acceptance, completion, rejection, release, refund, ' +
    'reopen, verification), never a note, a supplier line, a risk line or the settlement. `answers` lists the custom field values of the ' +
    'order as `{ key, label, value }` (decision 065): the label of each field of the service that has a value, then stored keys the ' +
    "service has no field for any more (label = the key). Another account's order, and the account's own store order, are `404`.",
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  success: {
    status: 200,
    schema: MerchantOrderSchema.extend({ answers: z.array(OrderAnswerSchema), events: z.array(MerchantEventSchema) }),
  },
  errors: ['UNAUTHORIZED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: {
      ...ORDER_EXAMPLE,
      answers: [{ key: 'username', label: 'Username', value: 'amir92' }],
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
    '"Cancelled by the merchant" and the hold returns to the wallet. An order placed on the website for a service that allows ' +
    `cancellation is sent only ${CANCEL_WINDOW_MS / 60_000} minutes after it was placed (the order's \`cancelUntil\`, decision 075), so it can be ` +
    'cancelled during that wait; a Dhru order is sent at once. An order that was sent to a supplier once (being sent now, sent, or ' +
    'sent and then failed or queued again) is `409 ALREADY_SENT`: it is cancelled by staff. A service that does not allow cancellation, or an ' +
    "order already being worked on, is `409 INVALID_TRANSITION`. The account's own store order (paid first, in the shop) is `404`: it is refunded " +
    'by staff, never cancelled here.',
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  body: z.object({}),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
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
    "accept the charge or refund it. The account's own store order is `404`.",
  tags: ['client-orders'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  body: z.object({}),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_COMPLETED',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: {} },
});
