// Route contracts of the wallet top-ups for staff (map domain E, stage 8, routes /admin/payments*). Shapes match the console's
// `Payment` (docs/contract/endpoints/money.md, RESOLUTIONS money-2, money-3, money-8).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { PAYMENT_PURPOSES, TOPUP_METHODS, TOPUP_PAYMENT_STATUSES } from '../db/schema';

/** A top-up (a merchant's deposit) as the console's Deposits tab shows it. */
export const PaymentSchema = z.object({
  id: zId,
  purpose: z.enum(PAYMENT_PURPOSES).describe('Always `topup` here.'),
  status: z.enum(TOPUP_PAYMENT_STATUSES),
  methodType: z.enum(TOPUP_METHODS),
  amount: zMoney.describe('What the merchant paid.'),
  feeAmount: zMoney,
  netAmount: zMoney.describe('Amount minus fee: what the wallet is credited.'),
  currency: z.string().describe('ISO code.'),
  gatewayTxnId: z.string().describe("The gateway's or the bank's reference; empty when there is none."),
  capturedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  invoiceId: zId.nullable(),
  receiptFileId: zId.nullable().describe('The uploaded proof of payment; download it with `GET /admin/files/:id`.'),
  client: z
    .object({
      id: zId,
      name: z.string(),
      group: z.string().nullable().describe('The merchant group name.'),
      walletBalance: zMoney
        .nullable()
        .describe('The merchant wallet balance now (it includes this deposit once approved).'),
    })
    .nullable(),
  gateway: z.object({ id: zId, name: z.string() }).nullable(),
  reviewedBy: z
    .object({ id: zId.nullable(), name: z.string() })
    .nullable()
    .describe('Who decided; an automatic credit is `{ id: null, name: "System" }`.'),
  reviewedAt: zIsoDateTime.nullable(),
  note: z
    .string()
    .nullable()
    .describe(
      'While pending: a hint for the reviewer (a first deposit, or when an automatic gateway credits it). Once rejected: the reason.',
    ),
});

const deposit = {
  id: 1004,
  purpose: 'topup' as const,
  status: 'pending' as const,
  methodType: 'bank' as const,
  amount: '360.0000',
  feeAmount: '0.0000',
  netAmount: '360.0000',
  currency: 'USD',
  gatewayTxnId: 'TRX-1431693',
  capturedAt: null,
  createdAt: '2026-11-01T09:30:00.000Z',
  invoiceId: 5,
  receiptFileId: 9004,
  client: { id: 11, name: 'Zain Mobile Hub', group: 'Wholesale', walletBalance: '1209.7500' },
  gateway: { id: 3, name: 'Bank transfer' },
  reviewedBy: null,
  reviewedAt: null,
  note: 'First deposit of this merchant.',
};

const REVIEW_RULES =
  'Only a pending top-up can be decided, and only when its gateway is manual or the payment was sent to review ' +
  '(`409 PAYMENT_AUTO_CREDIT_PENDING` otherwise: an automatic gateway credits by itself after the gateway check). A decided ' +
  'payment is `409 PAYMENT_ALREADY_REVIEWED`. An order (storefront) payment is `404`. Approving is `409 CONFLICT` when the ' +
  'gateway confirmed another amount or currency than the invoice (reject it and adjust the wallet by hand), when the gateway ' +
  'event can no longer be read, or when the invoice is no longer open.';

/** `GET /admin/payments`. */
export const listPayments = defineRoute({
  key: 'GET /admin/payments',
  summary: 'Payments and the manual review queue',
  description:
    'The wallet top-ups only: the list always filters `purpose=topup`, so `purpose=order` answers an empty list. Newest first. ' +
    '`q` searches the gateway reference and the merchant name.',
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:read',
  query: listQuery({
    sorts: ['createdAt', 'id', 'amount', 'status'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      purpose: { type: 'enum', values: PAYMENT_PURPOSES, ops: ['eq'] },
      status: { type: 'enum', values: TOPUP_PAYMENT_STATUSES },
      clientId: { type: 'id', ops: ['eq'] },
    },
    search: ['gatewayTxnId', 'client.name'],
  }),
  success: { status: 200, schema: PaymentSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [deposit] },
});

/** `GET /admin/payments/:id`. */
export const getPayment = defineRoute({
  key: 'GET /admin/payments/:id',
  summary: 'One top-up payment',
  description: 'The same row as the list. An order (storefront) payment is not served here: `404`.',
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: PaymentSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: deposit },
});

/** `POST /admin/payments/:id/approve`. */
export const approvePayment = defineRoute({
  key: 'POST /admin/payments/:id/approve',
  summary: 'Approve a top-up',
  description:
    'Approves a top-up and credits the wallet in one transaction: the money event `deposit` (Dr bank for a manual gateway or ' +
    'gateway_clearing for an automatic one, Cr client_wallet net, Cr fee_income fee, idempotency key `deposit:payment:<id>`), the ' +
    'linked invoice becomes paid, `invoice.paid` is queued for the merchant webhook, and the decision is audited. ' +
    `${REVIEW_RULES} The answer's \`client.walletBalance\` already includes the credit.`,
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:approve',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: PaymentSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'PAYMENT_ALREADY_REVIEWED',
    'PAYMENT_AUTO_CREDIT_PENDING',
    'CONFLICT',
    'VALIDATION_FAILED',
  ],
  examples: {
    response: {
      ...deposit,
      status: 'approved',
      capturedAt: '2026-11-01T10:00:00.000Z',
      reviewedBy: { id: 2, name: 'Omar T.' },
      reviewedAt: '2026-11-01T10:00:00.000Z',
      note: null,
      client: { ...deposit.client, walletBalance: '1569.7500' },
    },
  },
});

/** `POST /admin/payments/:id/reject`. */
export const rejectPayment = defineRoute({
  key: 'POST /admin/payments/:id/reject',
  summary: 'Reject a top-up',
  description:
    'Rejects a top-up with the reason the merchant sees: the payment becomes rejected with the reason as its note, the linked top-up ' +
    'invoice is voided (a staff-issued manual invoice stays open: the merchant may upload another receipt), nothing is posted to the ' +
    `ledger, and the decision is audited. ${REVIEW_RULES}`,
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:approve',
  params: z.object({ id: zIdParam }),
  body: z.object({ reason: z.string().trim().describe('The reason the merchant is shown, up to 500 characters.') }),
  success: { status: 200, schema: PaymentSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'PAYMENT_ALREADY_REVIEWED',
    'PAYMENT_AUTO_CREDIT_PENDING',
    'VALIDATION_FAILED',
  ],
  examples: {
    request: { reason: 'Receipt unreadable. Please upload a clearer copy.' },
    response: {
      ...deposit,
      status: 'rejected',
      reviewedBy: { id: 2, name: 'Omar T.' },
      reviewedAt: '2026-11-01T10:00:00.000Z',
      note: 'Receipt unreadable. Please upload a clearer copy.',
    },
  },
});
