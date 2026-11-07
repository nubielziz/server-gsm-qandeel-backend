// Route contracts of the invoices for staff (map domain E, stage 8, routes /admin/invoices). Shapes match the console's `Invoice`
// and `CreateInvoiceBody` (docs/contract/endpoints/money.md, RESOLUTIONS money-7).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { INVOICE_KINDS, INVOICE_STATUSES } from '../db/schema';

/** An invoice as the console shows it: a merchant's top-up or manual invoice, or a storefront customer's tax receipt. */
export const InvoiceSchema = z.object({
  id: zId,
  number: z.string().describe('`INV-<year>-<id>`, for example `INV-2026-0042`.'),
  kind: z.enum(INVOICE_KINDS),
  status: z.enum(INVOICE_STATUSES),
  amount: zMoney.describe('Before fee and tax.'),
  fee: zMoney,
  netAmount: zMoney.describe(
    'What the wallet is credited when it is paid: amount minus fee (a receipt: the price without VAT).',
  ),
  taxAmount: zMoney,
  taxRate: zDecimal.describe('Percent. For a merchant: the B2B VAT rate setting (0 for now).'),
  taxCountry: z
    .string()
    .describe('The merchant billing country, or the checkout session tax country of a receipt; empty when none.'),
  customerVatId: z.string(),
  total: zMoney.describe('What is billed.'),
  currency: z.string().describe('ISO code, not the currencies id.'),
  client: z.object({ id: zId, name: z.string() }).nullable(),
  customer: z.object({ id: zId, name: z.string(), email: z.string() }).nullable(),
  orderId: zId.nullable(),
  pdfFileId: zId.nullable().describe('The PDF copy; download it with `GET /admin/files/:id`.'),
  description: z.string().nullable().describe('What a manual invoice bills for; null when none.'),
  dueAt: zIsoDateTime.nullable(),
  paidAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

const manual = {
  id: 311,
  number: 'INV-2026-0311',
  kind: 'manual' as const,
  status: 'open' as const,
  amount: '250.0000',
  fee: '0.0000',
  netAmount: '250.0000',
  taxAmount: '0.0000',
  taxRate: '0.0000',
  taxCountry: 'JO',
  customerVatId: '',
  total: '250.0000',
  currency: 'USD',
  client: { id: 5, name: 'Zain Mobile Hub' },
  customer: null,
  orderId: null,
  pdfFileId: 9500,
  description: 'Priority support, November',
  dueAt: '2026-11-15T10:00:00.000Z',
  paidAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
};

/** `GET /admin/invoices`. */
export const listInvoices = defineRoute({
  key: 'GET /admin/invoices',
  summary: 'Invoices',
  description:
    'Top-up and manual invoices of merchants, statements and the tax receipts of storefront orders, newest first. `q` searches the ' +
    'number and the merchant or customer name.',
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'invoices:read',
  query: listQuery({
    sorts: ['createdAt', 'total', 'status'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: INVOICE_STATUSES },
      kind: { type: 'enum', values: INVOICE_KINDS },
      clientId: { type: 'id', ops: ['eq'] },
    },
    search: ['number', 'client.name', 'customer.name'],
  }),
  success: { status: 200, schema: InvoiceSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [manual] },
});

/** `GET /admin/invoices/:id`. */
export const getInvoice = defineRoute({
  key: 'GET /admin/invoices/:id',
  summary: 'One invoice',
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'invoices:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: InvoiceSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: manual },
});

/** `POST /admin/invoices`. */
export const createInvoice = defineRoute({
  key: 'POST /admin/invoices',
  summary: 'Issue a manual invoice',
  description:
    'Issues a manual invoice to a merchant: kind manual, status open, no fee, tax at the B2B VAT rate (setting, 0 for now), due in ' +
    '14 days, in the base currency. It is a top-up invoice: when it is paid the wallet is credited and `invoice.paid` is sent. No ' +
    'ledger entry at issue. A merchant without a billing country is 422 on `clientId`. Audited.',
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'invoices:create',
  body: z.object({
    clientId: zId,
    amount: z.string().trim().describe('A decimal amount above zero with up to four decimals.'),
    description: z.string().trim().describe('What the invoice is for, up to 500 characters.'),
  }),
  success: { status: 201, schema: InvoiceSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { clientId: 5, amount: '250.0000', description: 'Priority support, November' },
    response: manual,
  },
});
