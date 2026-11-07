// Route contracts of merchant wallets (map domain E, stage 3): the admin console's wallet, statement, manual adjustment and
// credit limit, and the merchant portal's own wallet and statement. Shapes match the console (docs/contract/endpoints/money.md).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';

/** The four wallet figures (all `Money`, merchant side). */
export const WalletViewSchema = z.object({
  balance: zMoney.describe('The wallet balance; positive is the merchant money, negative while credit is in use.'),
  reserved: zMoney.describe('Held for open orders.'),
  creditLimit: zMoney.describe('How far the balance may go below zero.'),
  available: zMoney.describe('Spendable now: balance plus credit limit.'),
});

/** One line of a merchant statement. */
export const StatementRowSchema = z.object({
  id: zId.describe('The ledger entry id.'),
  transactionId: zId.describe('The journal (`GET /admin/ledger/transactions/:id`).'),
  kind: z.string().describe('The entry kind: deposit, order_hold, order_release, adjustment, commission, ...'),
  memo: z.string(),
  amount: zMoney.describe('Signed from the merchant side: a deposit is positive, an order hold negative.'),
  balanceAfter: zMoney.describe('The wallet balance right after the line, merchant side.'),
  createdAt: zIsoDateTime,
});

const wallet = {
  balance: '1209.7500',
  reserved: '71.2300',
  creditLimit: '2000.0000',
  available: '3209.7500',
};
const statementRow = {
  id: 1394,
  transactionId: 1394,
  kind: 'deposit',
  memo: 'Deposit PAY-1000 (Bank transfer)',
  amount: '360.0000',
  balanceAfter: '1209.7500',
  createdAt: '2026-10-28T09:30:00.000Z',
};

/** `GET /admin/clients/:id/wallet`. */
export const getClientWallet = defineRoute({
  key: 'GET /admin/clients/:id/wallet',
  summary: 'A merchant wallet',
  description:
    'The four wallet figures of a merchant: balance, reserved, credit limit and available (balance plus credit limit). All zero ' +
    'while the merchant has no accounts. Never cached.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: WalletViewSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: wallet },
});

/** `GET /admin/clients/:id/statement`. */
export const listClientStatement = defineRoute({
  key: 'GET /admin/clients/:id/statement',
  summary: 'A merchant account statement',
  description:
    'One row per ledger entry on the merchant wallet, newest first. `amount` and `balanceAfter` are from the merchant side. ' +
    'Lines that only move the hold (`order_settle`) never appear. Never cached.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:read',
  params: z.object({ id: zIdParam }),
  query: listQuery({ sorts: ['createdAt'], defaultSort: { field: 'createdAt', order: 'desc' } }),
  success: { status: 200, schema: StatementRowSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: [statementRow] },
});

/** The body of `POST /admin/clients/:id/wallet/adjust`. */
const AdjustBody = z.object({
  amount: zMoney
    .refine((text) => /[1-9]/.test(text) && !text.startsWith('-'), 'Enter an amount greater than zero.')
    .describe('A positive amount in USD.'),
  direction: z.enum(['credit', 'debit']),
  reason: z
    .string()
    .trim()
    .min(5, 'Add a reason of at least 5 characters.')
    .max(140, 'Keep the reason to 140 characters or fewer.'),
});

/** `POST /admin/clients/:id/wallet/adjust`. */
export const adjustClientWallet = defineRoute({
  key: 'POST /admin/clients/:id/wallet/adjust',
  summary: 'Add to or deduct from a merchant wallet',
  description:
    'Posts the map money event `adjust` (credit: Dr adjustments / Cr client_wallet; debit: the mirror) with the reason in the ' +
    'memo, and audits it. An amount above the single-approver limit (setting `wallet.adjust_approval_limit`, default $10,000) ' +
    'is refused with `APPROVAL_REQUIRED`; a debit below the credit limit with `CREDIT_LIMIT_EXCEEDED`. The optional ' +
    '`Idempotency-Key` header makes a retry post once; without it each request posts.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:adjust',
  params: z.object({ id: zIdParam }),
  headers: z.object({ 'idempotency-key': z.string().trim().min(1).max(100).optional() }),
  body: AdjustBody,
  success: { status: 200, schema: z.object({ transactionId: zId, wallet: WalletViewSchema }) },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'APPROVAL_REQUIRED',
    'CREDIT_LIMIT_EXCEEDED',
    'IDEMPOTENCY_KEY_REUSED',
  ],
  examples: {
    request: { amount: '10.0000', direction: 'credit', reason: 'Goodwill credit for a failed order' },
    response: { transactionId: 1395, wallet },
  },
});

/** `PATCH /admin/clients/:id/credit-limit`. */
export const setClientCreditLimit = defineRoute({
  key: 'PATCH /admin/clients/:id/credit-limit',
  summary: 'Set a merchant credit limit',
  description:
    'Sets the overdraft limit of the merchant wallet; `0.0000` removes the credit. A limit above zero needs a merchant group ' +
    'that allows credit (`422` on `creditLimit` otherwise). Lowering the limit below the credit in use is allowed: new orders ' +
    'are refused until a top-up. No ledger entry; audited.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:credit_limit',
  params: z.object({ id: zIdParam }),
  body: z.object({ creditLimit: zMoney }),
  success: { status: 200, schema: WalletViewSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { creditLimit: '2000.0000' }, response: wallet },
});

/** `GET /client/wallet`. */
export const getMyWallet = defineRoute({
  key: 'GET /client/wallet',
  summary: 'My wallet',
  description: 'Available and held balance and credit limit of the signed-in merchant. Never cached.',
  tags: ['catalog'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: WalletViewSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL'],
  examples: { response: wallet },
});

/** `GET /client/wallet/statement`. */
export const listMyStatement = defineRoute({
  key: 'GET /client/wallet/statement',
  summary: 'My account statement',
  description:
    'The signed-in merchant statement, newest first, in the same shape as the admin one. `?format=csv` answers every line ' +
    '(up to 10,000) as a CSV file instead of a page. Never cached.',
  tags: ['catalog'],
  surface: 'client',
  access: 'merchant-session',
  query: listQuery({
    sorts: ['createdAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    extra: { format: z.enum(['json', 'csv']).optional() },
  }),
  success: { status: 200, schema: StatementRowSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'VALIDATION_FAILED'],
  examples: { response: [statementRow] },
});
