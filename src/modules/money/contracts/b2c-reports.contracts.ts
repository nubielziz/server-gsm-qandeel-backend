// Route contracts of the storefront money reports (map domain E, stage 16, routes GET /admin/reports/vat and /payments). Shapes match the
// console's `VatReport` (src/features/finance/types/reports.ts) and `PaymentsReport` (src/features/refunds/types).
import { z } from 'zod';
import { defineRoute, zDateOnly, zDecimal, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { ORDER_METHODS } from '../db/schema';

const VatRow = z.object({
  country: z.string().describe('ISO country of the tax.'),
  period: z.string().describe('The month, `YYYY-MM` (UTC).'),
  rate: z.string().describe('The VAT rate in percent applied to the month (the rate of its latest order).'),
  orders: z.number().int().describe('Paid orders of the month.'),
  taxable: zMoney.describe('Net sales (after refunds).'),
  vat: zMoney.describe('VAT due (after refunds).'),
});

/** `GET /admin/reports/vat`. */
export const getVatReport = defineRoute({
  key: 'GET /admin/reports/vat',
  summary: 'VAT due by country and month',
  description:
    'Worked out from the ledger, not from invoices: the `vat_payable` lines of the storefront payment journals (`b2c_pay`) minus its ' +
    'refund journals (`b2c_refund`), posted between `from` and `to` (days, both included, UTC). One row per tax country and month, ' +
    'newest month first, then country. Amounts are USD. `422` for a bad date or `from` after `to`.',
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'reports:finance',
  query: z.object({ from: zDateOnly, to: zDateOnly }),
  success: {
    status: 200,
    schema: z.object({
      from: z.string(),
      to: z.string(),
      currency: z.string(),
      rows: z.array(VatRow),
      totals: z.object({ orders: z.number().int(), taxable: zMoney, vat: zMoney }),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: {
    response: {
      from: '2026-10-01',
      to: '2026-10-31',
      currency: 'USD',
      rows: [{ country: 'GB', period: '2026-10', rate: '20.0000', orders: 41, taxable: '512.4000', vat: '102.4800' }],
      totals: { orders: 41, taxable: '512.4000', vat: '102.4800' },
    },
  },
});

/** The sort keys of the payments report. */
export const REPORT_SORTS = ['orderId', 'method', 'amount', 'feeAmount', 'status', 'createdAt'] as const;
const PAYMENT_STATUSES = ['captured', 'refunded', 'partial_refund', 'disputed', 'chargeback'] as const;

const wholeNumber = z
  .string()
  .regex(/^\d{1,9}$/, 'Must be a whole number.')
  .transform(Number);

const PaymentLine = z.object({
  id: zId,
  orderId: zId,
  amount: zMoney.describe('Paid including VAT (USD).'),
  feeAmount: zMoney.describe("The gateway's fee (USD)."),
  createdAt: zIsoDateTime.describe('When the payment was captured.'),
  method: z.enum(ORDER_METHODS),
  brand: z.string().describe('`Visa •••• 4242`, `USDT TRC-20` or a wallet name; empty when the driver could not tell.'),
  status: z.enum(PAYMENT_STATUSES),
  currency: z.string(),
  fx: zDecimal,
  customer: z.object({ id: zId, name: z.string() }).nullable(),
});

const MethodSummary = z.object({
  method: z.enum(ORDER_METHODS),
  payments: z.number().int(),
  volume: zMoney,
  fees: zMoney,
  feeRate: zDecimal.describe('Fees as a percent of the volume, 2 decimals.'),
  refunds: z.number().int(),
  disputes: z.number().int(),
});

/** `GET /admin/reports/payments`. */
export const getPaymentsReport = defineRoute({
  key: 'GET /admin/reports/payments',
  summary: 'Storefront payments by method',
  description:
    'One object: `methods` (card, wallet and crypto, always all three, whatever the filter and page: payments, volume, fees, fee rate, ' +
    'refunds and disputes), `payments` (one page of storefront payments, never top-ups), `total` (payments matching the `method` filter) ' +
    "and `totals` (the strip: refunds completed in the last 30 days, their share of the same days' sales, what waits in requested and " +
    'failed refunds, and all-time chargeback losses with their fees). Only payments with money received count (captured, refunded, ' +
    "partial_refund, disputed, chargeback). Amounts are USD at the checkout's locked rate. Pages are `_start` and `_end`; `_sort` is one " +
    'of orderId, method, amount, feeAmount, status, createdAt (default `createdAt` descending).',
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'reports:finance',
  query: z.object({
    method: z.enum(ORDER_METHODS).optional(),
    _start: wholeNumber.optional(),
    _end: wholeNumber.optional(),
    _sort: z.enum(REPORT_SORTS).optional(),
    _order: z.enum(['asc', 'desc']).optional(),
    // The console's function names its range and sort `start`, `end`, `sort` and `order` and the contract test compares those names: they are
    // accepted as aliases of the underscore names (the simple-rest wire).
    start: wholeNumber.optional().describe('Alias of `_start`.'),
    end: wholeNumber.optional().describe('Alias of `_end`.'),
    sort: z.string().max(30).optional().describe('Alias of `_sort`; a value that is not a sort key is `422`.'),
    order: z.enum(['asc', 'desc']).optional().describe('Alias of `_order`.'),
  }),
  success: {
    status: 200,
    schema: z.object({
      methods: z.array(MethodSummary),
      payments: z.array(PaymentLine),
      total: z.number().int(),
      totals: z.object({
        refundedCount: z.number().int(),
        refundedAmount: zMoney,
        refundedPercentOfSales: zDecimal,
        awaitingAmount: zMoney,
        chargebackLoss: zMoney,
      }),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: {
    response: {
      methods: [
        { method: 'card', payments: 1, volume: '14.9900', fees: '0.7300', feeRate: '4.87', refunds: 0, disputes: 0 },
        { method: 'wallet', payments: 0, volume: '0.0000', fees: '0.0000', feeRate: '0.00', refunds: 0, disputes: 0 },
        { method: 'crypto', payments: 0, volume: '0.0000', fees: '0.0000', feeRate: '0.00', refunds: 0, disputes: 0 },
      ],
      payments: [
        {
          id: 9001,
          orderId: 20467,
          amount: '14.9900',
          feeAmount: '0.7300',
          createdAt: '2026-11-07T12:00:05.000Z',
          method: 'card',
          brand: 'Visa •••• 4242',
          status: 'captured',
          currency: 'GBP',
          fx: '0.79000000',
          customer: { id: 31, name: 'Jack Turner' },
        },
      ],
      total: 1,
      totals: {
        refundedCount: 0,
        refundedAmount: '0.0000',
        refundedPercentOfSales: '0.00',
        awaitingAmount: '0.0000',
        chargebackLoss: '0.0000',
      },
    },
  },
});
