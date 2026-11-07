// Route contracts of the staff actions on one order and the bulk reply (map domain D, stage 5). Each action answers 204; the bulk
// reply answers per item. Bodies match the console (`src/features/orders/api/actions.ts`, `bulkReply.ts`).
import { z } from 'zod';
import { defineRoute, zId, zIdParam } from '../../../common/contract';
import { MAX_BULK_ITEMS } from '../domain/bulk-reply';

const id = z.object({ id: zIdParam });

/** A required text of the staff dialogs: trimmed, not empty, with the console's length limit. */
const required = (max: number, message: string) =>
  z.string().trim().min(1, message).max(max, `Keep it to ${max} characters or fewer.`);

/** `POST /admin/orders/:id/accept`. */
export const acceptOrder = defineRoute({
  key: 'POST /admin/orders/:id/accept',
  summary: 'Accept a manual order',
  description:
    'Moves an order of the manual queue (`pending` with `dispatch_state` `manual`) to `processing` (dispatch state `operator`, no queue). ' +
    'No money moves: the hold stays. Writes an `accepted` event, the `order.status_changed` outbox row and an audit row.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  params: id,
  body: z.object({}),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'NOT_MANUAL',
    'ORDER_NOT_OPEN',
    'ORDER_HELD',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: {} },
});

/** `POST /admin/orders/:id/reply`. */
export const replyOrder = defineRoute({
  key: 'POST /admin/orders/:id/reply',
  summary: 'Complete an order with its result',
  description:
    'Completes an open order: `result_code` and `result_comment` are stored, `completed_at` is set, `dispatch_state` becomes `done`. The ' +
    'hold is settled to revenue (B2B `complete`: hold to revenue, plus supplier prepaid to cost of goods only when a supplier executed ' +
    'the order and no earlier settlement booked the cost). Writes `completed` and `settle` events, `order.status_changed` and an audit ' +
    'row. Two parallel replies, or a reply and a reject, change the order and the ledger once: the other answers `409`.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  params: id,
  body: z.object({
    code: required(2000, 'Write a reply.').describe('The result text the buyer receives.'),
    comment: z.string().trim().max(200, 'Keep the comment to 200 characters or fewer.').optional(),
  }),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_OPEN',
    'ORDER_HELD',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: { code: 'Unlocked: code 8842 1113', comment: 'Wait 10 minutes after the first boot.' } },
});

/** `POST /admin/orders/:id/reject`. */
export const rejectOrder = defineRoute({
  key: 'POST /admin/orders/:id/reject',
  summary: 'Reject an order and release its hold',
  description:
    'Rejects an open order with a buyer-visible reason: `result_code` is the reason, `completed_at` is set and the hold returns to the ' +
    'wallet (B2B `reject`). Writes `rejected` and `release` events, `order.status_changed` and an audit row. A storefront order ' +
    'delivered before and then reopened is refunded from the Refunds page (`USE_REFUNDS`).',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  params: id,
  body: z.object({ reason: required(120, 'Choose a reason.') }),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_OPEN',
    'ORDER_HELD',
    'USE_REFUNDS',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: { reason: 'IMEI is blacklisted' } },
});

/** `POST /admin/orders/:id/reopen`. */
export const reopenOrder = defineRoute({
  key: 'POST /admin/orders/:id/reopen',
  summary: 'Reopen a completed order',
  description:
    'Sends a completed order back to `processing` (dispatch state `operator`, no queue): `completed_at` and the result are cleared and ' +
    'the settled revenue returns to the hold (a reversing entry; the cost stays booked). Writes a `reopened` event, ' +
    '`order.status_changed` and an audit row. A later reply settles it again.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:reopen',
  params: id,
  body: z.object({ reason: z.string().trim().max(140, 'Keep the reason to 140 characters or fewer.').optional() }),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_COMPLETED',
    'ORDER_NOT_OPEN',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: { reason: 'The code did not work' } },
});

/** `POST /admin/orders/:id/refund`. */
export const refundOrder = defineRoute({
  key: 'POST /admin/orders/:id/refund',
  summary: 'Refund a completed merchant order',
  description:
    'Refunds a completed merchant order in one step (reopen, then reject): the order becomes `rejected` with the reason as its result, ' +
    'the settled revenue goes straight back to the wallet and the supplier cost is kept (a reversing entry). Writes `rejected` and ' +
    '`refund` events, `order.status_changed` and an audit row. Storefront orders are refunded from the Refunds page (`USE_REFUNDS`).',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:reopen',
  params: id,
  body: z.object({ reason: required(140, 'Add a short reason.') }),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_COMPLETED',
    'USE_REFUNDS',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: { reason: 'The merchant was charged twice' } },
});

/** `POST /admin/orders/:id/verification`. */
export const decideVerification = defineRoute({
  key: 'POST /admin/orders/:id/verification',
  summary: 'Decide a verification request',
  description:
    'Decides the verification request of a completed order. `accept` keeps the charge (`verification_status` `accepted`). `refund` ' +
    'rejects the order with the note (or a default text) as its result and refunds it like `POST /admin/orders/:id/refund`: revenue ' +
    'back to the wallet, cost kept (`verification_status` `refunded`). Writes a `verification` event (and the refund events) and an audit row.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  params: id,
  body: z.object({
    decision: z.enum(['accept', 'refund']),
    note: z.string().trim().max(140, 'Keep the note to 140 characters or fewer.').optional(),
  }),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'NOT_IN_VERIFICATION',
    'USE_REFUNDS',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: { decision: 'accept' } },
});

/** `POST /admin/orders/:id/notes`. */
export const addOrderNote = defineRoute({
  key: 'POST /admin/orders/:id/notes',
  summary: 'Add an internal note',
  description:
    "Appends a `note` event and sets the order's latest internal note (`adminNote`). Any status. Never shown to the buyer, in the " +
    'merchant portal or in a webhook. Audited.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  params: id,
  body: z.object({ body: required(500, 'Write the note first.') }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { body: 'Called the merchant: they will send the IMEI again.' } },
});

const LINE_STATUSES = ['matched', 'not_found', 'ambiguous', 'invalid', 'not_open'] as const;

/** `POST /admin/orders/bulk-reply/preview`. */
export const previewBulkReply = defineRoute({
  key: 'POST /admin/orders/bulk-reply/preview',
  summary: 'Match pasted lines to orders',
  description:
    `Reads the pasted text (at most ${MAX_BULK_ITEMS} lines): each non-blank line is an input followed by a code, separated by ` +
    'whitespace, a comma or a semicolon. The input is matched to `orders.imei` with whitespace removed (a blank input never ' +
    'matches). Status per line: `invalid` (no input or no code), `not_found`, `not_open` (only closed orders carry it), `ambiguous` ' +
    '(several open orders) or `matched` (with the order id). Changes nothing, so it writes no audit row.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  audit: false,
  body: z.object({ text: z.string() }),
  success: {
    status: 200,
    schema: z.object({
      lines: z.array(
        z.object({
          line: z.number().int().min(1).describe('1-based over the pasted text; blank lines are skipped but counted.'),
          raw: z.string(),
          imei: z.string().nullable(),
          code: z.string().nullable(),
          orderId: zId.nullable(),
          status: z.enum(LINE_STATUSES),
        }),
      ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { text: '352905112490861 Unlocked: 8842\n' },
    response: {
      lines: [
        {
          line: 1,
          raw: '352905112490861 Unlocked: 8842',
          imei: '352905112490861',
          code: 'Unlocked: 8842',
          orderId: 48101,
          status: 'matched',
        },
      ],
    },
  },
});

/** `POST /admin/orders/bulk-reply/apply`. */
export const applyBulkReply = defineRoute({
  key: 'POST /admin/orders/bulk-reply/apply',
  summary: 'Apply the matched replies',
  description:
    `Completes up to ${MAX_BULK_ITEMS} orders, each as its own \`reply\` (own transaction, same checks, ledger and audit row). A refused ` +
    'item goes to `failed` with a readable reason and never turns the call into an error. Also writes one audit row for the request.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  body: z.object({
    items: z
      .array(z.object({ orderId: zId, code: required(2000, 'Write a reply.') }))
      .min(1, 'Add at least one order.')
      .max(MAX_BULK_ITEMS, `At most ${MAX_BULK_ITEMS} orders per apply`),
  }),
  success: {
    status: 200,
    schema: z.object({
      applied: z.number().int().min(0),
      failed: z.array(z.object({ orderId: zId, title: z.string() })),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { items: [{ orderId: 48101, code: 'Unlocked: 8842' }] },
    response: { applied: 0, failed: [{ orderId: 48101, title: 'Only an open order can be changed.' }] },
  },
});
