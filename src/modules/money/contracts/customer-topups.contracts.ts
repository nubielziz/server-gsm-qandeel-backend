// Route contracts of the storefront customer's store balance top-ups (feature 21, plan § 7.1 routes 3 to 8, beyond the map in
// scripts/map-additions/21.mjs): the methods, a new top-up, the list and one top-up, the transfer receipt and the cancel.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { TOPUP_METHODS } from '../db/schema';
import { PaymentMethodSchema } from './billing-portal.contracts';
import { IdempotencyHeader } from './customer-wallet.contracts';

/** The store states of a top-up. */
export const TOPUP_STATUSES = ['awaiting_payment', 'in_review', 'credited', 'rejected', 'cancelled'] as const;

/** A top-up as the customer sees it. */
export const TopUpSchema = z.object({
  id: zId,
  number: z.string().describe('The top-up number (`INV-2026-0042`).'),
  status: z.enum(TOPUP_STATUSES),
  amount: zMoney.describe('What the customer pays (USD).'),
  fee: zMoney,
  netAmount: zMoney.describe('What the balance receives: amount minus fee.'),
  currency: z.string().describe('Always USD.'),
  method: z.object({
    id: zId,
    code: z.string(),
    name: z.string(),
    kind: z.enum(['manual', 'automatic']),
    methodType: z.enum(TOPUP_METHODS),
  }),
  reference: z.string().nullable().describe('The bank or gateway reference, once paid.'),
  receiptUploaded: z.boolean(),
  rejectionReason: z.string().nullable().describe('Why staff rejected it (status `rejected`).'),
  createdAt: zIsoDateTime,
  creditedAt: zIsoDateTime.nullable(),
});

/** A top-up with how to pay it (only while it awaits payment). */
export const TopUpDetailSchema = TopUpSchema.extend({
  instructions: z.string().optional().describe('The transfer details of a manual method.'),
  paymentUrl: z.string().optional().describe('The hosted payment page of an automatic method.'),
});

const topUp = {
  id: 42,
  number: 'INV-2026-0042',
  status: 'awaiting_payment' as const,
  amount: '50.0000',
  fee: '0.0000',
  netAmount: '50.0000',
  currency: 'USD',
  method: { id: 7, code: 'cliq', name: 'CliQ transfer', kind: 'manual' as const, methodType: 'bank' as const },
  reference: null,
  receiptUploaded: false,
  rejectionReason: null,
  createdAt: '2026-11-10T09:30:00.000Z',
  creditedAt: null,
};
const detail = { ...topUp, instructions: 'Send the amount by CliQ to GSMSHOP and write INV-2026-0042 in the note.' };

const SESSION_ERRORS = ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'] as const;
const WRITE_ERRORS = [...SESSION_ERRORS, 'CSRF_FAILED', 'VALIDATION_FAILED'] as const;

/** `GET /store/v1/me/wallet/top-up-methods`. */
export const listMyTopUpMethods = defineRoute({
  key: 'GET /store/v1/me/wallet/top-up-methods',
  summary: 'My top-up methods',
  description:
    'The payment methods the signed-in customer can top up the store balance with: manual transfers (bank, CliQ) and, while card ' +
    'top-ups are on, automatic gateways. `minAmount` and `maxAmount` are the effective limits (gateway and shop). Empty while the ' +
    'store balance is switched off. Never cached.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  query: listQuery({ sorts: ['name'], defaultSort: { field: 'name', order: 'asc' } }),
  success: { status: 200, schema: PaymentMethodSchema },
  errors: [...SESSION_ERRORS, 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        id: 7,
        code: 'cliq',
        name: 'CliQ transfer',
        kind: 'manual',
        methodType: 'bank',
        feePercent: '0.0000',
        feeFixed: '0.0000',
        minAmount: '5.0000',
        maxAmount: '500.0000',
        currency: 'USD',
        holdHours: 0,
        instructions: 'Send the amount by CliQ to GSMSHOP and write the top-up number in the note.',
        preset: null,
        logoUrl: null,
      },
    ],
  },
});

/** `POST /store/v1/me/wallet/top-ups`. */
export const createMyTopUp = defineRoute({
  key: 'POST /store/v1/me/wallet/top-ups',
  summary: 'Start a top-up',
  description:
    'Starts a store balance top-up: `amount` (USD, what the customer pays; the fee comes out of it) through `gatewayId`. A manual ' +
    'method answers the transfer `instructions` (then upload the receipt); an automatic one answers the `paymentUrl`. The ' +
    '`Idempotency-Key` header is required: a retry with the same key and body answers the same top-up (`idempotency-replayed: true`); ' +
    'the same key with another body is `IDEMPOTENCY_KEY_REUSED`. Limits answer `422` on `amount` (`min`, `max`, `fee`, `daily_count`, ' +
    '`daily_amount`, `max_balance`, and `not_chargeable` for an automatic method that cannot charge the amount exactly: a card page ' +
    'takes two decimals) or `409 CONFLICT` (three unpaid top-ups). Refused while the balance is switched off ' +
    '(`WALLET_DISABLED`), and through an automatic method while it is on hold (`WALLET_FROZEN`). A card method asks for 3-D Secure ' +
    "while the shop's `require3ds` policy is on (decision 049).",
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  headers: IdempotencyHeader,
  body: z.object({
    amount: z.string().trim().min(1).max(20).describe('A decimal above zero with at most four places, in USD.'),
    gatewayId: zId,
  }),
  success: { status: 201, schema: TopUpDetailSchema },
  errors: [
    ...WRITE_ERRORS,
    'CONFLICT',
    'WALLET_DISABLED',
    'WALLET_FROZEN',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
    'RATE_LIMITED',
    'GATEWAY_ERROR',
  ],
  examples: { request: { amount: '50', gatewayId: 7 }, response: detail },
});

/** `GET /store/v1/me/wallet/top-ups`. */
export const listMyTopUps = defineRoute({
  key: 'GET /store/v1/me/wallet/top-ups',
  summary: 'My top-ups',
  description: 'The signed-in customer’s top-ups, newest first, with their states. Never cached.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  query: listQuery({ sorts: ['createdAt'], defaultSort: { field: 'createdAt', order: 'desc' } }),
  success: { status: 200, schema: TopUpSchema },
  errors: [...SESSION_ERRORS, 'VALIDATION_FAILED'],
  examples: { response: [topUp] },
});

/** `GET /store/v1/me/wallet/top-ups/:id`. */
export const getMyTopUp = defineRoute({
  key: 'GET /store/v1/me/wallet/top-ups/:id',
  summary: 'One of my top-ups',
  description:
    'One top-up with how to pay it while it awaits payment (`instructions` or `paymentUrl`). Another customer’s top-up is `404`. ' +
    'Poll it gently after the hosted page returns. Never cached.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: TopUpDetailSchema },
  errors: [...SESSION_ERRORS, 'VALIDATION_FAILED', 'NOT_FOUND'],
  examples: { response: detail },
});

/** `POST /store/v1/me/wallet/top-ups/:id/receipt`. */
export const attachMyTopUpReceipt = defineRoute({
  key: 'POST /store/v1/me/wallet/top-ups/:id/receipt',
  summary: 'Attach the transfer receipt',
  description:
    'Attaches the receipt of a manual transfer (`fileId` from `POST /store/v1/files`, PDF, JPEG or PNG) and the optional bank ' +
    'reference; the top-up then waits for staff (`in_review`). Sending the same receipt again answers the top-up again. Allowed ' +
    'while the balance is switched off (the money may already be on its way). The `Idempotency-Key` header is required. A receipt ' +
    'whose file, or a file with the same content, already backs a pending or approved payment is `422` on `fileId` (`taken`; ' +
    'decision 049).',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  params: z.object({ id: zIdParam }),
  headers: IdempotencyHeader,
  body: z.object({ fileId: zId, reference: z.string().optional() }),
  success: { status: 201, schema: TopUpDetailSchema },
  errors: [...WRITE_ERRORS, 'NOT_FOUND', 'CONFLICT'],
  examples: {
    request: { fileId: 90, reference: 'CLIQ-77812' },
    response: { ...topUp, status: 'in_review', reference: 'CLIQ-77812', receiptUploaded: true },
  },
});

/** `POST /store/v1/me/wallet/top-ups/:id/cancel`. */
export const cancelMyTopUp = defineRoute({
  key: 'POST /store/v1/me/wallet/top-ups/:id/cancel',
  summary: 'Cancel a top-up',
  description:
    'Cancels a manual top-up that has no receipt yet; cancelling it again answers it again. A credited top-up, an online one (it ' +
    'closes by itself) or one with a receipt in review is `409 CONFLICT`. The `Idempotency-Key` header is required.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  params: z.object({ id: zIdParam }),
  headers: IdempotencyHeader,
  success: { status: 200, schema: TopUpDetailSchema },
  errors: [...SESSION_ERRORS, 'CSRF_FAILED', 'VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT'],
  examples: { response: { ...topUp, status: 'cancelled' } },
});
