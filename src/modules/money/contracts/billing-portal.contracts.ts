// Route contracts of the merchant portal's billing (map domain E, stage 8, MISMATCHES B162 and B163): the payment methods, the
// merchant's invoices, a new top-up invoice and the receipt of a bank transfer. No console screen calls them.
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { INVOICE_KINDS, INVOICE_STATUSES, TOPUP_METHODS, TOPUP_PAYMENT_STATUSES } from '../db/schema';

/** A payment method the merchant may top up through (B162). */
export const PaymentMethodSchema = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  kind: z
    .enum(['manual', 'automatic'])
    .describe('Manual: staff review the receipt. Automatic: the gateway confirms and the wallet credits itself.'),
  methodType: z.enum(TOPUP_METHODS),
  feePercent: zDecimal,
  feeFixed: zMoney,
  minAmount: zMoney.describe('`0.0000` = no minimum.'),
  maxAmount: zMoney.describe(
    'The lower of the gateway maximum and the merchant group limit per deposit; `0.0000` = no maximum.',
  ),
  currency: z.string(),
  holdHours: z.number().int(),
  instructions: z.string().describe('The transfer details of a manual method; empty for an automatic one.'),
});

/** An invoice as the merchant sees it (B163): never a storefront receipt. */
export const MerchantInvoiceSchema = z.object({
  id: zId,
  number: z.string(),
  kind: z.enum(INVOICE_KINDS.filter((kind) => kind !== 'receipt') as ['topup', 'manual', 'statement']),
  status: z.enum(INVOICE_STATUSES),
  amount: zMoney,
  fee: zMoney,
  netAmount: zMoney.describe('What the wallet is credited when the invoice is paid.'),
  taxAmount: zMoney,
  taxRate: zDecimal,
  total: zMoney,
  currency: z.string(),
  description: z.string().nullable(),
  gateway: z.object({ id: zId, name: z.string() }).nullable(),
  dueAt: zIsoDateTime.nullable(),
  paidAt: zIsoDateTime.nullable(),
  pdfFileId: zId.nullable().describe('The PDF copy; download it with `GET /client/files/:id`.'),
  createdAt: zIsoDateTime,
});

/** A payment on an invoice, as the merchant sees it. */
export const MerchantPaymentSchema = z.object({
  id: zId,
  amount: zMoney,
  feeAmount: zMoney,
  currency: z.string(),
  status: z.enum(TOPUP_PAYMENT_STATUSES),
  methodType: z.enum(TOPUP_METHODS),
  reference: z.string().describe("The gateway's or the bank's reference; empty when there is none."),
  receiptFileId: zId.nullable(),
  capturedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

const method = {
  id: 3,
  code: 'bank',
  name: 'Bank transfer',
  kind: 'manual' as const,
  methodType: 'bank' as const,
  feePercent: '0.0000',
  feeFixed: '0.0000',
  minAmount: '50.0000',
  maxAmount: '5000.0000',
  currency: 'USD',
  holdHours: 24,
  instructions: 'IBAN JO94 CBJO 0010 0000 0000 0131 000302',
};
const invoice = {
  id: 312,
  number: 'INV-2026-0312',
  kind: 'topup' as const,
  status: 'open' as const,
  amount: '100.0000',
  fee: '0.0000',
  netAmount: '100.0000',
  taxAmount: '0.0000',
  taxRate: '0.0000',
  total: '100.0000',
  currency: 'USD',
  description: null,
  gateway: { id: 3, name: 'Bank transfer' },
  dueAt: '2026-11-15T10:00:00.000Z',
  paidAt: null,
  pdfFileId: null,
  createdAt: '2026-11-01T10:00:00.000Z',
};
const payment = {
  id: 1060,
  amount: '100.0000',
  feeAmount: '0.0000',
  currency: 'USD',
  status: 'pending' as const,
  methodType: 'bank' as const,
  reference: 'TRX-5521',
  receiptFileId: 9101,
  capturedAt: null,
  createdAt: '2026-11-01T10:20:00.000Z',
};

/** `GET /client/payment-methods`. */
export const listMyPaymentMethods = defineRoute({
  key: 'GET /client/payment-methods',
  summary: 'My payment methods',
  description:
    'The active payment gateways open to merchants (audience b2b or both) whose group list is empty or holds the merchant group, ' +
    'by name. `maxAmount` is the lower of the gateway maximum and the group limit per deposit, so it is the limit ' +
    '`POST /client/invoices` applies. Never secrets or webhook details.',
  tags: ['finance'],
  surface: 'client',
  access: 'merchant-session',
  query: listQuery({ sorts: ['name'], defaultSort: { field: 'name', order: 'asc' } }),
  success: { status: 200, schema: PaymentMethodSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'VALIDATION_FAILED'],
  examples: { response: [method] },
});

/** `GET /client/invoices`. */
export const listMyInvoices = defineRoute({
  key: 'GET /client/invoices',
  summary: 'My invoices',
  description: 'The invoices of the signed-in merchant, newest first. `q` searches the number.',
  tags: ['finance'],
  surface: 'client',
  access: 'merchant-session',
  query: listQuery({
    sorts: ['createdAt', 'number', 'total', 'status', 'dueAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: INVOICE_STATUSES },
      kind: { type: 'enum', values: INVOICE_KINDS },
      createdAt: { type: 'datetime' },
    },
    search: ['number'],
  }),
  success: { status: 200, schema: MerchantInvoiceSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'VALIDATION_FAILED'],
  examples: { response: [invoice] },
});

const InvoiceDetail = z.object({
  invoice: MerchantInvoiceSchema,
  payments: z.array(MerchantPaymentSchema),
  instructions: z.string().optional().describe('While the invoice is open and its gateway is manual: how to pay.'),
  paymentUrl: z.string().optional().describe('While the invoice is open and its gateway is automatic: where to pay.'),
});

/** `GET /client/invoices/:id`. */
export const getMyInvoice = defineRoute({
  key: 'GET /client/invoices/:id',
  summary: 'My invoice and its payments',
  description: "An invoice of the signed-in merchant with its payments. Another merchant's invoice is `404`.",
  tags: ['finance'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: InvoiceDetail },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: { invoice, payments: [payment], instructions: method.instructions } },
});

/** `POST /client/invoices`. */
export const createMyInvoice = defineRoute({
  key: 'POST /client/invoices',
  summary: 'Ask for a top-up invoice',
  description:
    'Writes a top-up invoice (status open, due in 14 days) through one of the merchant payment methods: `fee = amount x percent + ' +
    'fixed`, `netAmount = amount - fee` (the wallet is credited with it when the invoice is paid). A manual method answers ' +
    '`{ invoice, instructions }`; an automatic one opens a checkout and answers `{ invoice, paymentUrl }` (`502 GATEWAY_ERROR` and ' +
    'nothing written when the gateway fails). 422 on `gatewayId` for a method the merchant may not use, and on `amount` outside the ' +
    'method limits, above the group limit per deposit, or too small for the fee.',
  tags: ['finance'],
  surface: 'client',
  access: 'merchant-session',
  body: z.object({
    amount: z.string().trim().describe('A decimal amount above zero with up to four decimals.'),
    gatewayId: zId,
  }),
  success: {
    status: 201,
    schema: z.object({
      invoice: MerchantInvoiceSchema,
      instructions: z.string().optional(),
      paymentUrl: z.string().optional(),
    }),
  },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'CSRF_FAILED', 'VALIDATION_FAILED', 'GATEWAY_ERROR'],
  examples: { request: { amount: '100', gatewayId: 3 }, response: { invoice, instructions: method.instructions } },
});

/** `POST /client/invoices/:id/receipt`. */
export const uploadMyReceipt = defineRoute({
  key: 'POST /client/invoices/:id/receipt',
  summary: 'Upload a bank transfer receipt',
  description:
    'Attaches the receipt of a transfer (a file the merchant uploaded: PDF, JPEG or PNG) to an open invoice and queues the payment ' +
    'for staff review. `reference` is the bank reference (up to 64 characters, unique per gateway). A staff-issued invoice has no ' +
    'gateway yet: send the manual `gatewayId` the merchant paid through. 409 for an invoice that is not open, is paid online, or ' +
    'already has a receipt waiting; 422 on `fileId`, `reference` and `gatewayId`.',
  tags: ['finance'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  body: z.object({
    fileId: zId,
    reference: z.string().trim().optional(),
    gatewayId: zId.optional().describe('The manual payment method used; required when the invoice has none yet.'),
  }),
  success: { status: 201, schema: MerchantPaymentSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'CSRF_FAILED', 'NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED'],
  examples: { request: { fileId: 9101, reference: 'TRX-5521' }, response: payment },
});
