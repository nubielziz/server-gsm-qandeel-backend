// Route contracts of the reports (map domain E, routes /admin/reports/profit, wallet-exposure, suppliers, top-clients and
// client-statement, stage 11). Shapes match the console's report types (docs/contract/endpoints/money.md, suppliers.md and orders.md,
// RULES money, MISMATCHES B88).
import { z } from 'zod';
import { defineRoute, zDateOnly, zId, zIdParam, zMoney, zSignedMoney } from '../../../common/contract';
import { RANK_KINDS } from '../db/schema';
import { PROFIT_GROUPS, TOP_SCOPES } from '../domain/report-figures';

const ProfitRow = z.object({
  key: z
    .string()
    .describe(
      'The date for a day split, otherwise the record id as text (`0` for "No supplier" and "Storefront customers"; a merchant row is the account id).',
    ),
  label: z.string(),
  orders: z.number().int().min(0),
  revenue: zMoney.describe('Selling price without VAT.'),
  cost: zMoney.describe('Supplier cost.'),
  profit: zSignedMoney.describe('Revenue minus cost; negative when the supplier cost more than the price.'),
});

const PROFIT_EXAMPLE = {
  groupBy: 'day',
  from: '2026-10-09',
  to: '2026-11-07',
  currency: 'USD',
  rows: [
    { key: '2026-11-06', label: '2026-11-06', orders: 12, revenue: '212.4000', cost: '181.3000', profit: '31.1000' },
  ],
  totals: { orders: 12, revenue: '212.4000', cost: '181.3000', profit: '31.1000' },
} as const;

/** `GET /admin/reports/profit`. */
export const getProfitReport = defineRoute({
  key: 'GET /admin/reports/profit',
  summary: 'Profit by day, service, supplier or merchant',
  description:
    'Completed orders counted by the day they completed (UTC days). `revenue` is the selling price without VAT (for a storefront ' +
    'order, less what its refund and chargeback journals took back, never below zero), `cost` the supplier cost, `profit` their ' +
    'difference. `groupBy` is `day` (default; oldest day first, days without orders left out), `service`, ' +
    '`supplier` (key `0` is "No supplier") or `client` (the buyer\'s account of every order that came through a merchant door, by account id; ' +
    'key `0` is "Storefront customers", every order of the shop door together); the other splits rank by profit, highest ' +
    'first. `from` and `to` are days, both included; the default is the 30 days ending on `to` (today). The dates used are echoed ' +
    'back. `422` names `from` when it is after `to`.',
  tags: ['reports'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'reports:read',
  query: z.object({
    groupBy: z.enum(PROFIT_GROUPS).optional(),
    from: zDateOnly.optional(),
    to: zDateOnly.optional(),
  }),
  success: {
    status: 200,
    schema: z.object({
      groupBy: z.enum(PROFIT_GROUPS),
      from: zDateOnly,
      to: zDateOnly,
      currency: z.string(),
      rows: z.array(ProfitRow),
      totals: z.object({ orders: z.number().int().min(0), revenue: zMoney, cost: zMoney, profit: zSignedMoney }),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: PROFIT_EXAMPLE },
});

/** `GET /admin/reports/wallet-exposure`. */
export const getWalletExposure = defineRoute({
  key: 'GET /admin/reports/wallet-exposure',
  summary: 'Merchant wallet balances, credit in use, reserved amounts and store balances',
  description:
    '`balance` is the wallet of an account with a merchant rank (negative while credit is used), `reserved` what is held for open orders, ' +
    '`overdraftLimit` its credit limit and `overdraftUsed` the credit in use (`max(0, -balance)`, not capped at the limit). `rows` lists ' +
    'the 50 largest merchant wallets by balance (`clientId` is the account id); `totals` cover every merchant-rank wallet (`inOverdraft` ' +
    'counts those with a negative balance). `storeBalances` is a sibling of `totals` and covers the store balances, the wallets of ' +
    'accounts with a retail rank: how many there are, what they hold, how many are below zero (only a chargeback can take one there) and ' +
    'how many are on hold. A wallet of the inactive kind (it holds zero after a rank change) is in neither.',
  tags: ['reports'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'reports:read',
  success: {
    status: 200,
    schema: z.object({
      currency: z.string(),
      totals: z.object({
        clients: z.number().int().min(0),
        balance: zSignedMoney,
        reserved: zMoney,
        overdraftLimit: zMoney,
        overdraftUsed: zMoney,
        inOverdraft: z.number().int().min(0),
      }),
      storeBalances: z.object({
        accounts: z.number().int().min(0),
        balance: zSignedMoney,
        negative: z.number().int().min(0),
        frozen: z.number().int().min(0),
      }),
      rows: z.array(
        z.object({
          clientId: zId,
          name: z.string(),
          balance: zSignedMoney,
          reserved: zMoney,
          overdraftLimit: zMoney,
          overdraftUsed: zMoney,
        }),
      ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
  examples: {
    response: {
      currency: 'USD',
      totals: {
        clients: 12,
        balance: '5230.4000',
        reserved: '86.0000',
        overdraftLimit: '4000.0000',
        overdraftUsed: '120.0000',
        inOverdraft: 1,
      },
      storeBalances: { accounts: 31, balance: '412.6000', negative: 0, frozen: 1 },
      rows: [
        {
          clientId: 1,
          name: 'Zain Mobile Hub',
          balance: '1209.7500',
          reserved: '16.2600',
          overdraftLimit: '500.0000',
          overdraftUsed: '0.0000',
        },
      ],
    },
  },
});

const Days = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d{0,3}$/, 'Use a whole number of days.')
    .transform(Number)
    .pipe(z.number().int().min(1).max(max, `Use at most ${max} days.`));

/** `GET /admin/reports/suppliers`. */
export const getSupplierReport = defineRoute({
  key: 'GET /admin/reports/suppliers',
  summary: 'Supplier spend, rejection rate and speed',
  description:
    'A bare array with one row per supplier (suppliers without orders included), by supplier id, over the last `days` (default 7, at ' +
    'most 365). `orders` counts orders sent to the supplier created in the window, `spend` is the supplier cost of the completed ones, ' +
    '`rejectionRate` is `rejected / (completed + rejected) x 100` (`null` when none finished), `averageSeconds` the mean time from ' +
    'sending (or creating) an order to its completion (`null` when none completed). `calls`, `errorCalls` and `timeoutCalls` are extra ' +
    'figures from the supplier call log of the same window.',
  tags: ['reports'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'reports:read',
  query: z.object({ days: Days(365).optional() }),
  success: {
    status: 200,
    schema: z.array(
      z.object({
        supplierId: zId,
        supplierName: z.string(),
        orders: z.number().int().min(0),
        completed: z.number().int().min(0),
        rejected: z.number().int().min(0),
        spend: zMoney,
        rejectionRate: z.number().nullable().describe('Percent from 0 to 100.'),
        averageSeconds: z.number().nullable(),
        calls: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Extra: supplier calls in the window (every action, tests and syncs included).'),
        errorCalls: z.number().int().min(0).optional().describe('Extra: calls that failed.'),
        timeoutCalls: z.number().int().min(0).optional().describe('Extra: calls that got no answer in time.'),
      }),
    ),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        supplierId: 2,
        supplierName: 'Gulf Server Hub',
        orders: 46,
        completed: 39,
        rejected: 4,
        spend: '1042.1000',
        rejectionRate: 9.3,
        averageSeconds: 97.1,
        calls: 130,
        errorCalls: 3,
        timeoutCalls: 1,
      },
    ],
  },
});

const Limit = z
  .string()
  .regex(/^[1-9]\d{0,2}$/, 'Use a whole number.')
  .transform(Number)
  .pipe(z.number().int().min(1).max(50, 'Use at most 50.'));

/** `GET /admin/reports/top-clients`. */
export const getTopClients = defineRoute({
  key: 'GET /admin/reports/top-clients',
  summary: 'Top accounts by spend and profit',
  description:
    'A bare array of up to `limit` accounts (default 6, at most 50) ranked by `spend`, highest first, over the last `days` x 24 hours ' +
    '(`days` is 1, 7 or 14; default 7), whatever the rank: merchants and shop buyers are in one list, a guest (an account row made by a ' +
    'checkout without a login, `hasAccount` false) is in and an anonymized account is out. `scope` is the door the orders came through: ' +
    '`all` (default), `b2b` (every merchant door) or `b2c` (the shop); an account that used both doors counts the orders of the doors ' +
    'the scope names. `orders` counts those orders created in the window, `spend` the price (before VAT) of the non-rejected ones, ' +
    "`profit` price minus cost of the completed ones, `rank` the account's rank now (`kind` is `merchant` or `retail`) and " +
    '`walletBalance` the balance of its live wallet (may be negative; zero for a guest). Accounts with no order in the window are left out.',
  tags: ['reports'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'reports:read',
  query: z.object({
    days: z.enum(['1', '7', '14']).transform(Number).optional(),
    limit: Limit.optional(),
    scope: z.enum(TOP_SCOPES).optional(),
  }),
  success: {
    status: 200,
    schema: z.array(
      z.object({
        id: zId.describe('The account id.'),
        name: z.string(),
        country: z.string(),
        rank: z.object({ id: zId, name: z.string(), kind: z.enum(RANK_KINDS) }),
        hasAccount: z.boolean().describe('False for a guest row.'),
        orders: z.number().int().min(0),
        spend: zMoney,
        profit: zSignedMoney,
        walletBalance: zSignedMoney,
      }),
    ),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        id: 9,
        name: 'Lagos Gadget Fix',
        country: 'NG',
        rank: { id: 2, name: 'Gold', kind: 'merchant' },
        hasAccount: true,
        orders: 15,
        spend: '347.5700',
        profit: '31.2700',
        walletBalance: '95.5700',
      },
    ],
  },
});

/** `GET /admin/reports/client-statement/:clientId`. */
export const getClientStatement = defineRoute({
  key: 'GET /admin/reports/client-statement/:clientId',
  summary: 'The official account statement of an account (PDF)',
  description:
    'A PDF (`application/pdf`, `Content-Disposition: attachment; filename="statement-<clientId>-<from>-<to>.pdf"` with the UTF-8 form, ' +
    '`Cache-Control: no-store`) made on the spot from the ledger, not stored. It is the statement of the live wallet (decision 064): ' +
    'the merchant wallet of a merchant rank, the store balance of the retail rank. It shows the account (name, company, country), the ' +
    'period, the opening balance, the wallet lines oldest first (date, `JRN-<id>`, kind, memo, debit, credit, balance after), the ' +
    'totals, the closing balance, the credit limit (merchant wallet only) and the invoices of that wallet issued in the period (the ' +
    'top-ups of a store balance). Amounts are USD with 4 decimals. `from` ' +
    'and `to` are UTC days, both included; the default is the whole history (from the day of the first wallet line to today). ' +
    'Lines are ordered by ledger entry id, so the closing balance is the wallet balance. Without `from`, a history of more than ' +
    '10,000 lines is cut to the most recent 10,000 and the period starts on the day of the first of them (the opening balance is the ' +
    'balance before that line), and a history of more than 10,000 invoices is cut to the newest 10,000 the same way; only an explicit ' +
    '`from` period with more than 10,000 lines, or with more than 10,000 invoices, is `422`. Every download writes an audit row ' +
    '(`exported statement of`). It is answered only to a request started by the console itself (`Sec-Fetch-Site: same-origin`, or an ' +
    '`Origin` that is one of the console’s origins); anything else is `403 CSRF_FAILED` and writes no audit row. ' +
    'It also needs `wallet:read`, as the wallet statement does (`403 FORBIDDEN`, decision 046).',
  tags: ['reports'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'reports:read',
  originCheck: true,
  params: z.object({ clientId: zIdParam }),
  query: z.object({ from: zDateOnly.optional(), to: zDateOnly.optional() }),
  success: { status: 200, contentType: 'application/pdf' },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'CSRF_FAILED'],
});
