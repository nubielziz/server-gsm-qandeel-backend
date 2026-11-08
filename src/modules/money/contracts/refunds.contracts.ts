// Route contracts of the storefront refunds for staff (map domain E, stage 16, routes /admin/refunds*). Shapes match the console's
// `Refund` (src/features/refunds/types; docs/contract/endpoints/money.md, RESOLUTIONS money-4, money-11, money-12, user rule 7).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { ORDER_METHODS, REFUND_METHODS, REFUND_REQUESTER_TYPES, REFUND_STATUSES } from '../db/schema';
import { MAX_DECLINE_REASON_LENGTH } from '../domain/refund-rules';

const NamedRef = z.object({ id: zId, name: z.string() });

/** One storefront refund as the console's Refunds page shows it. */
export const RefundSchema = z.object({
  id: zId,
  orderId: zId,
  amount: zMoney.describe('What goes back, USD.'),
  reason: z.string().describe("The requester's reason."),
  status: z
    .enum(REFUND_STATUSES)
    .describe(
      '`requested` waits for staff; `processing` from approval until the gateway answers; then `completed` or `failed`; `rejected` when declined. A hand payout goes straight to `completed`.',
    ),
  method: z.enum(REFUND_METHODS).describe('`original` goes back through the gateway; `manual` is paid out by hand.'),
  currency: z.string().describe("The customer's currency (ISO code), for display."),
  fx: zDecimal.describe('The rate the order was priced with, for display.'),
  partial: z.boolean().describe('True when less than the whole payment goes back.'),
  gatewayRefundId: z.string().nullable(),
  note: z
    .string()
    .nullable()
    .describe('The gateway failure text or the message the customer got when it was declined.'),
  requestedBy: z.object({ type: z.enum(REFUND_REQUESTER_TYPES), name: z.string().nullable() }),
  approvedBy: NamedRef.nullable().describe('The staff member who decided it.'),
  customer: NamedRef.nullable(),
  order: z.object({
    id: zId,
    deliveredAt: zIsoDateTime.nullable().describe('When the order completed; null while it has not.'),
    cost: zMoney.describe('What the supplier charged (USD); a delivered order does not get it back.'),
  }),
  payment: z.object({
    id: zId,
    method: z.enum(ORDER_METHODS),
    brand: z.string().describe("`Visa •••• 4242`, `USDT TRC-20` or a wallet's name; empty when unknown."),
    amount: zMoney.describe('What the customer paid including VAT (USD).'),
    taxAmount: zMoney.describe('The VAT of the whole payment (USD), from the payment journal.'),
  }),
  netAmount: zMoney.nullable().describe('The revenue part of the refund journal; null until it is posted.'),
  taxAmount: zMoney.nullable().describe('The VAT part of the refund journal; null until it is posted.'),
  completedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

const REFUND_EXAMPLE = {
  id: 1007,
  orderId: 20467,
  amount: '14.9900',
  reason: 'The code did not work',
  status: 'requested' as const,
  method: 'original' as const,
  currency: 'GBP',
  fx: '0.79000000',
  partial: false,
  gatewayRefundId: null,
  note: null,
  requestedBy: { type: 'customer' as const, name: null },
  approvedBy: null,
  customer: { id: 31, name: 'Jack Turner' },
  order: { id: 20467, deliveredAt: '2026-11-07T12:02:10.000Z', cost: '7.2000' },
  payment: { id: 9001, method: 'card' as const, brand: 'Visa •••• 4242', amount: '14.9900', taxAmount: '2.5000' },
  netAmount: null,
  taxAmount: null,
  completedAt: null,
  createdAt: '2026-11-07T13:00:00.000Z',
};

const DECISION_ERRORS = ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'] as const;

/** `GET /admin/refunds`. */
export const listRefunds = defineRoute({
  key: 'GET /admin/refunds',
  summary: 'Storefront refund requests',
  description:
    'Refunds of storefront customers only (a merchant refund goes through its order). Newest first. The page counts of the console are ' +
    'this call with `_start=0&_end=1` and a `status` filter. `q` searches the id, the reason and the customer name and email (a guest has only an email). `amount` sorts ' +
    'numerically.',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'refunds:read',
  query: listQuery({
    sorts: ['id', 'amount', 'status', 'createdAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { status: { type: 'enum', values: REFUND_STATUSES } },
    search: ['refundId', 'reason', 'customer.name', 'customer.email'],
  }),
  success: { status: 200, schema: RefundSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [REFUND_EXAMPLE] },
});

/** `GET /admin/refunds/:id`. */
export const getRefund = defineRoute({
  key: 'GET /admin/refunds/:id',
  summary: 'One storefront refund',
  description: 'The same row as the list; the console reads it when the approve or decline dialog opens.',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'refunds:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: RefundSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: REFUND_EXAMPLE },
});

/** `POST /admin/refunds/:id/approve`. */
export const approveRefund = defineRoute({
  key: 'POST /admin/refunds/:id/approve',
  summary: 'Approve a refund',
  description:
    'Approves a waiting refund in full or in part and posts its journal once (`b2c_refund`, key `refund:<id>`): a delivered order is ' +
    'reversed from revenue (the supplier cost is never recovered), an order that was not delivered is cancelled and refunded in full ' +
    'from customer funds; the VAT share is `round(tax x amount / paid, 2)`. A card or wallet refund goes to the gateway through a job ' +
    '(`processing` until it answers, then `completed` or `failed`); a crypto payment, or a gateway that cannot refund, is paid out ' +
    'by hand and is `completed` at once. Without `amount` the amount on the request is refunded; the limit is what was paid minus the ' +
    'other refunds that are completed or processing. The answer carries `netAmount` and `taxAmount` of the posted journal.',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'refunds:approve',
  params: z.object({ id: zIdParam }),
  body: z.object({
    amount: z
      .string()
      .trim()
      .max(20)
      .optional()
      .describe('A USD amount with up to 4 decimals (`7.5000`); left out means the amount on the request.'),
  }),
  success: { status: 200, schema: RefundSchema },
  errors: [...DECISION_ERRORS, 'REFUND_NOT_PENDING', 'ORDER_NOT_OPEN', 'INVALID_TRANSITION'],
  examples: {
    request: { amount: '7.5000' },
    response: {
      ...REFUND_EXAMPLE,
      amount: '7.5000',
      status: 'processing' as const,
      partial: true,
      approvedBy: { id: 2, name: 'Layla Haddad' },
      netAmount: '6.2500',
      taxAmount: '1.2500',
    },
  },
});

/** `POST /admin/refunds/:id/decline`. */
export const declineRefund = defineRoute({
  key: 'POST /admin/refunds/:id/decline',
  summary: 'Decline a refund',
  description:
    'Declines a waiting refund with a reason that reaches the customer (at least a sentence): the refund is `rejected`, `note` holds ' +
    'the reason, the order timeline says so, and the decision is audited. The customer email goes with the notifications feature.',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'refunds:approve',
  params: z.object({ id: zIdParam }),
  body: z.object({ reason: z.string().trim().max(MAX_DECLINE_REASON_LENGTH) }),
  success: { status: 200, schema: RefundSchema },
  errors: [...DECISION_ERRORS, 'REFUND_NOT_PENDING'],
  examples: {
    request: { reason: 'The code was delivered and works.' },
    response: {
      ...REFUND_EXAMPLE,
      status: 'rejected' as const,
      note: 'The code was delivered and works.',
      approvedBy: { id: 2, name: 'Layla Haddad' },
    },
  },
});

/** `POST /admin/refunds/:id/retry`. */
export const retryRefund = defineRoute({
  key: 'POST /admin/refunds/:id/retry',
  summary: 'Retry a failed refund',
  description:
    'Sends a refund that failed at the gateway again, with its original idempotency key (`refund-<id>`): the status is `processing` ' +
    'until the gateway answers, then `completed` or `failed`. Nothing is posted again: the journal was posted at approval (B83).',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'refunds:approve',
  params: z.object({ id: zIdParam }),
  body: z.object({}),
  success: { status: 200, schema: RefundSchema },
  errors: [...DECISION_ERRORS, 'REFUND_NOT_FAILED'],
  examples: { request: {}, response: { ...REFUND_EXAMPLE, status: 'processing' as const } },
});
