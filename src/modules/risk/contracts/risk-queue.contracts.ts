// Route contracts of the risk review queue (map domain K, stage 18): the held orders with the 30-day figures and the latest decisions,
// and the staff decision on a held order. Shapes are the console's (src/features/risk/types).
import { z } from 'zod';
import { defineRoute, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { MAX_BLOCK_REASON_LENGTH } from '../domain/blocklist-values';

const NamedRef = z.object({ id: zId, name: z.string() });

/** One held order, with everything the reviewer needs on the card. */
export const HeldOrderSchema = z.object({
  orderId: zId,
  paidAt: zIsoDateTime.describe('When the payment was captured.'),
  score: z.number().int().describe('0 to 100; the sum of the signals (a blocklist hit is 100).'),
  service: NamedRef,
  supplier: NamedRef.nullable().describe('The supplier the order will go to (its first active link); null when none.'),
  imei: z.string().describe('The IMEI, or the main input of the order.'),
  device: z
    .string()
    .nullable()
    .describe('Named from the TAC catalogue; null when the order has no IMEI or the TAC is unknown.'),
  capturedAmount: zMoney.describe('USD, VAT included.'),
  currency: z.string().describe('The currency the customer paid in.'),
  fxRate: zDecimal.describe('The rate locked by the checkout session.'),
  paymentMethod: z.enum(['card', 'wallet', 'crypto']),
  signals: z.array(z.string()).describe('The reasons, in words; the first one seeds the refund reason.'),
  customer: z.object({
    id: zId,
    name: z.string(),
    email: z.string(),
    country: z.string(),
    riskLevel: z.enum(['low', 'medium', 'high']),
    history: z.object({
      earlierOrders: z.number().int(),
      refunds: z.number().int(),
      disputes: z.number().int(),
    }),
  }),
});

/** A decided order of the "Decided recently" list. */
export const DecidedOrderSchema = z.object({
  orderId: zId,
  score: z.number().int(),
  customer: NamedRef,
  capturedAmount: zMoney,
  currency: z.string(),
  fxRate: zDecimal,
  outcome: z.enum(['approved', 'refunded']),
  reviewedBy: NamedRef.nullable(),
  reviewedAt: zIsoDateTime,
});

/** The answer of `GET /admin/risk/queue`. */
export const RiskQueueSchema = z.object({
  held: z.array(HeldOrderSchema),
  stats: z.object({
    decided30d: z.number().int(),
    approved30d: z.number().int(),
    refunded30d: z.number().int(),
    heldShare: z.number().describe('Percent with one decimal: 5.8 means 5.8 %.'),
  }),
  recent: z.array(DecidedOrderSchema),
});

const QUEUE_EXAMPLE = {
  held: [
    {
      orderId: 4821,
      paidAt: '2026-11-08T09:12:44.000Z',
      score: 62,
      service: { id: 14, name: 'Vodafone UK iPhone Unlock' },
      supplier: { id: 3, name: 'UnlockBase' },
      imei: '353890110000004',
      device: 'iPhone 13 (A2633)',
      capturedAmount: '23.7600',
      currency: 'GBP',
      fxRate: '0.79000000',
      paymentMethod: 'card',
      signals: ['Disposable email domain', 'IP country differs from card country'],
      customer: {
        id: 31,
        name: 'Jack Turner',
        email: 'jt@mailinator.com',
        country: 'GB',
        riskLevel: 'medium',
        history: { earlierOrders: 0, refunds: 0, disputes: 0 },
      },
    },
  ],
  stats: { decided30d: 12, approved30d: 9, refunded30d: 3, heldShare: 5.8 },
  recent: [
    {
      orderId: 4790,
      score: 84,
      customer: { id: 27, name: 'Priya Nair' },
      capturedAmount: '41.9000',
      currency: 'USD',
      fxRate: '1.00000000',
      outcome: 'refunded',
      reviewedBy: { id: 1, name: 'Rami K.' },
      reviewedAt: '2026-11-07T15:02:10.000Z',
    },
  ],
} as const;

/** `GET /admin/risk/queue`. */
export const getRiskQueue = defineRoute({
  key: 'GET /admin/risk/queue',
  summary: 'The risk review queue',
  description:
    'Paid storefront orders the risk rules are holding (their newest assessment says `review`, nothing was sent to a supplier), ' +
    'oldest payment first, with no paging. `stats` counts the last 30 days (decided, approved, refunded, and the percent of storefront ' +
    'orders that were held). `recent` is the six latest decisions, newest first. `device` is read from the TAC catalogue: the ' +
    'marketing name with the model in brackets when the entry has a marketing name, else brand and model. The console polls it ' +
    'every 30 seconds; never cached.',
  tags: ['risk'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:read',
  success: { status: 200, schema: RiskQueueSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
  examples: { response: QUEUE_EXAMPLE },
});

/** `POST /admin/risk/orders/:id/approve`. */
export const approveHeldOrder = defineRoute({
  key: 'POST /admin/risk/orders/:id/approve',
  summary: 'Approve a held order',
  description:
    '`:id` is the order id. Releases the order by the placement rule: to the dispatch job (the supplier gets it), or to the manual ' +
    'queue for a manual service or a service without an active supplier link. The assessment records who approved and when, the ' +
    'order timeline gets a risk line, and the action is audited as `approved after risk review`. `409 NOT_HELD` when the order is ' +
    'not waiting for a decision any more.',
  tags: ['risk'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:decide',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NOT_HELD'],
});

/** The body of `POST /admin/risk/orders/:id/refund`. */
export const RefundHeldBodySchema = z.object({
  reason: z
    .string()
    .trim()
    .max(MAX_BLOCK_REASON_LENGTH, `Use at most ${MAX_BLOCK_REASON_LENGTH} characters.`)
    .optional()
    .describe('Left out or blank: the server writes "Refunded after risk review: <first signal>".'),
  blockEmail: z.boolean().default(false).describe('Add the customer’s email to the blocklist.'),
  blockDevice: z.boolean().default(false).describe('Add the order’s IMEI (the device) to the blocklist.'),
});

/** `POST /admin/risk/orders/:id/refund`. */
export const refundHeldOrder = defineRoute({
  key: 'POST /admin/risk/orders/:id/refund',
  summary: 'Refund a held order',
  description:
    '`:id` is the order id. Rejects the order without contacting a supplier and returns the whole payment (the storefront refund ' +
    'ledger move), in one transaction with the assessment outcome, the order timeline, the audit row and the chosen blocklist ' +
    'entries (manual entries of the caller; an entry that already exists is skipped, and none is linked to a customer). The ' +
    'customer’s status is not changed: block the customer with `POST /admin/customers/:id/block`. `409 NOT_HELD` when the order ' +
    'is not waiting for a decision any more.',
  tags: ['risk'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:decide',
  params: z.object({ id: zIdParam }),
  body: RefundHeldBodySchema,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NOT_HELD', 'VALIDATION_FAILED'],
  examples: { request: { reason: 'Card owner did not match the IMEI buyer', blockEmail: true, blockDevice: false } },
});
