// Route contracts of the customer store balance (feature 21, plan § 7.1, routes beyond the map in scripts/map-additions/21.mjs): the
// customer's own wallet and statement on the store, and the staff wallet view, statement, adjust, freeze, unfreeze and list.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zMoney, zSignedMoney } from '../../../common/contract';
import { StatementRowSchema } from './wallet.contracts';

/**
 * The `Idempotency-Key` every customer wallet write requires (O15): 1 to 100 printable ASCII characters, no spaces.
 *
 * Why: lead rule L5: a retry of the same dialog or attempt must change nothing twice; the console makes one key per dialog opening.
 */
export const IdempotencyHeader = z.object({
  'idempotency-key': z
    .string()
    .trim()
    .min(1, 'Send an Idempotency-Key header.')
    .max(100, 'Keep the Idempotency-Key to 100 characters or fewer.')
    .regex(/^[\x21-\x7e]+$/, 'Use printable ASCII characters without spaces.'),
});

/** The top-up limits a customer sees. */
export const WalletLimitsSchema = z.object({
  minTopUp: zMoney,
  maxTopUp: zMoney,
  maxBalance: zMoney,
  room: zMoney.describe(
    'How much more top-ups may add: maxBalance minus the balance and the pending top-ups, never below zero.',
  ),
  topUpsLeftToday: z.number().int().min(0).describe('Top-ups still allowed in the trailing 24 hours.'),
  amountLeftToday: zMoney.describe('USD still allowed in top-ups in the trailing 24 hours.'),
});

const PendingSchema = z.object({
  count: z.number().int().min(0),
  amount: zMoney.describe('The net the unpaid top-ups would add.'),
});

/** The customer's store balance (`GET /store/v1/me/wallet`). */
export const StoreWalletSchema = z.object({
  enabled: z
    .boolean()
    .describe('The master switch: false hides Add Funds and Pay from balance; a balance is still shown.'),
  cardTopUps: z.boolean().describe('Whether an automatic (card) method can appear.'),
  currency: z.string().describe('Always USD.'),
  balance: zSignedMoney.describe('Customer side; negative only after a lost top-up chargeback.'),
  reserved: zMoney.describe('Always 0.0000 for a customer (the merchant wallet shape).'),
  creditLimit: zMoney.describe('Always 0.0000 for a customer.'),
  available: zMoney.describe('What can be spent now: 0.0000 while frozen, switched off or negative, else the balance.'),
  frozen: z.object({ at: zIsoDateTime }).nullable(),
  pendingTopUps: PendingSchema,
  limits: WalletLimitsSchema,
});

/** The customer's store balance as staff see it. */
export const AdminWalletSchema = z.object({
  enabled: z.boolean(),
  currency: z.string(),
  balance: zSignedMoney,
  reserved: zMoney,
  creditLimit: zMoney,
  available: zMoney,
  frozen: z.object({ at: zIsoDateTime, reason: z.string() }).nullable(),
  pendingTopUps: PendingSchema,
  openDisputes: z.number().int().min(0).describe('Open disputes of this customer’s top-ups.'),
  adjustApprovalLimit: zMoney.describe(
    "A staff member's credits to customer balances within 24 hours, and any single debit, above this need an owner (setting wallet.customer.adjust_approval_limit, decision 049).",
  ),
});

/** One line of the customer's own statement. */
export const StoreStatementRowSchema = z.object({
  id: zId.describe('The ledger entry id.'),
  transactionId: zId,
  kind: z.string().describe('deposit, b2c_payment, refund, adjustment or chargeback.'),
  memo: z.string().describe('English; a staff adjustment reads "Balance adjustment".'),
  orderId: zId.nullable().describe('The order the line is about, when it is one.'),
  amount: zSignedMoney.describe('Signed from the customer side: a top-up is positive, a payment negative.'),
  balanceAfter: zSignedMoney,
  createdAt: zIsoDateTime,
});

/** One wallet of the staff list. */
export const WalletRowSchema = z.object({
  customer: z.object({ id: zId, name: z.string(), email: z.string(), status: z.string() }),
  balance: zSignedMoney,
  frozen: z.object({ at: zIsoDateTime, reason: z.string() }).nullable(),
  updatedAt: zIsoDateTime,
});

const limits = {
  minTopUp: '5.0000',
  maxTopUp: '500.0000',
  maxBalance: '1000.0000',
  room: '950.0000',
  topUpsLeftToday: 4,
  amountLeftToday: '950.0000',
};
const storeWallet = {
  enabled: true,
  cardTopUps: false,
  currency: 'USD',
  balance: '50.0000',
  reserved: '0.0000',
  creditLimit: '0.0000',
  available: '50.0000',
  frozen: null,
  pendingTopUps: { count: 0, amount: '0.0000' },
  limits,
};
const adminWallet = {
  enabled: true,
  currency: 'USD',
  balance: '50.0000',
  reserved: '0.0000',
  creditLimit: '0.0000',
  available: '50.0000',
  frozen: null,
  pendingTopUps: { count: 0, amount: '0.0000' },
  openDisputes: 0,
  adjustApprovalLimit: '500.0000',
};
const storeLine = {
  id: 812,
  transactionId: 640,
  kind: 'deposit',
  memo: 'Top-up PAY-1042 (Bank transfer)',
  orderId: null,
  amount: '50.0000',
  balanceAfter: '50.0000',
  createdAt: '2026-11-10T09:30:00.000Z',
};
const adminLine = {
  id: 813,
  transactionId: 641,
  kind: 'adjustment',
  memo: 'Manual credit: Goodwill credit for a slow unlock',
  amount: '10.0000',
  balanceAfter: '60.0000',
  createdAt: '2026-11-10T10:00:00.000Z',
};

const statementQuery = () =>
  listQuery({
    sorts: ['createdAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { createdAt: { type: 'datetime', ops: ['gte', 'lte'] } },
  });

const STORE_READ_ERRORS = ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'] as const;

/** `GET /store/v1/me/wallet`. */
export const getMyStoreWallet = defineRoute({
  key: 'GET /store/v1/me/wallet',
  summary: 'My store balance',
  description:
    'The signed-in customer’s store balance (USD): balance, what can be spent now, the hold state, unpaid top-ups and the top-up ' +
    'limits. `enabled: false` means the shop switched the balance off: hide Add Funds and Pay from balance, still show a balance. ' +
    'Never cached (`Cache-Control: no-store`).',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  success: { status: 200, schema: StoreWalletSchema },
  errors: [...STORE_READ_ERRORS],
  examples: { response: storeWallet },
});

/** `GET /store/v1/me/wallet/statement`. */
export const listMyStoreWalletStatement = defineRoute({
  key: 'GET /store/v1/me/wallet/statement',
  summary: 'My store balance statement',
  description:
    'One row per ledger entry on the signed-in customer’s balance, newest first; `createdAt_gte` and `createdAt_lte` filter by the ' +
    'posting time. A staff adjustment reads "Balance adjustment" (the staff reason is internal). Never cached.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  query: statementQuery(),
  success: { status: 200, schema: StoreStatementRowSchema },
  errors: [...STORE_READ_ERRORS, 'VALIDATION_FAILED'],
  examples: { response: [storeLine] },
});

/** `GET /admin/customers/:id/wallet`. */
export const getCustomerWallet = defineRoute({
  key: 'GET /admin/customers/:id/wallet',
  summary: 'A customer store balance',
  description:
    'The store balance of a customer: balance, available, the hold with its reason, unpaid top-ups, open top-up disputes and the ' +
    'adjust approval limit. All zero while the customer has no wallet. Never cached.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: AdminWalletSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: adminWallet },
});

/** `GET /admin/customers/:id/wallet/statement`. */
export const listCustomerWalletStatement = defineRoute({
  key: 'GET /admin/customers/:id/wallet/statement',
  summary: 'A customer balance statement',
  description:
    'One row per ledger entry on the customer’s balance, newest first, with the full memo (staff reasons included). ' +
    '`createdAt_gte` and `createdAt_lte` filter by the posting time.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:read',
  params: z.object({ id: zIdParam }),
  query: statementQuery(),
  success: { status: 200, schema: StatementRowSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: [adminLine] },
});

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

const ReasonBody = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Add a reason of at least 5 characters.')
    .max(200, 'Keep the reason to 200 characters or fewer.'),
});

/** `POST /admin/customers/:id/wallet/adjust`. */
export const adjustCustomerWallet = defineRoute({
  key: 'POST /admin/customers/:id/wallet/adjust',
  summary: 'Add to or deduct from a customer balance',
  description:
    'Posts a manual adjustment (credit: Dr adjustments / Cr customer_wallet; debit: the mirror) with the reason in the memo, audits it ' +
    'and emails the customer. A credit needs a customer with an account that is not anonymized (`NO_ACCOUNT`, `ANONYMIZED`); a debit ' +
    "never takes the balance below zero (`INSUFFICIENT_FUNDS`). A staff member's credits to customer balances within 24 hours, this " +
    'one included, above the approval limit (setting `wallet.customer.adjust_approval_limit`, default $500), or a single debit above ' +
    'it, are refused with `APPROVAL_REQUIRED`; an Owner is not limited (decision 049). The `Idempotency-Key` header is ' +
    'required: a retry with the same key and body answers the first adjustment; the same key with another body is ' +
    '`IDEMPOTENCY_KEY_REUSED`. Works while the balance is switched off or frozen.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:adjust',
  params: z.object({ id: zIdParam }),
  headers: IdempotencyHeader,
  body: AdjustBody,
  success: { status: 200, schema: z.object({ transactionId: zId, wallet: AdminWalletSchema }) },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'APPROVAL_REQUIRED',
    'INSUFFICIENT_FUNDS',
    'IDEMPOTENCY_KEY_REUSED',
    'NO_ACCOUNT',
    'ANONYMIZED',
  ],
  examples: {
    request: { amount: '10.0000', direction: 'credit', reason: 'Goodwill credit for a slow unlock' },
    response: { transactionId: 641, wallet: { ...adminWallet, balance: '60.0000', available: '60.0000' } },
  },
});

/** `POST /admin/customers/:id/wallet/freeze`. */
export const freezeCustomerWallet = defineRoute({
  key: 'POST /admin/customers/:id/wallet/freeze',
  summary: 'Put a customer balance on hold',
  description:
    'Stops paying from the balance and card top-ups; bank top-ups, credits, refunds and staff adjustments still work. Freezing a frozen ' +
    'wallet changes nothing (still audited). Audited and emailed to the customer. The `Idempotency-Key` header is required.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:adjust',
  params: z.object({ id: zIdParam }),
  headers: IdempotencyHeader,
  body: ReasonBody,
  success: { status: 200, schema: AdminWalletSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { reason: 'Checking a disputed top-up' },
    response: {
      ...adminWallet,
      available: '0.0000',
      frozen: { at: '2026-11-10T10:00:00.000Z', reason: 'Checking a disputed top-up' },
    },
  },
});

/** `POST /admin/customers/:id/wallet/unfreeze`. */
export const unfreezeCustomerWallet = defineRoute({
  key: 'POST /admin/customers/:id/wallet/unfreeze',
  summary: 'Lift the hold on a customer balance',
  description:
    'Clears the hold. Refused while the balance is below zero (`CONFLICT`: bring it to zero first) or a dispute of one of the ' +
    'customer’s top-ups is open (`OPEN_DISPUTE`). Unfreezing a wallet that is not frozen changes nothing. Audited. The ' +
    '`Idempotency-Key` header is required.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:adjust',
  params: z.object({ id: zIdParam }),
  headers: IdempotencyHeader,
  body: ReasonBody,
  success: { status: 200, schema: AdminWalletSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'CONFLICT', 'OPEN_DISPUTE'],
  examples: { request: { reason: 'The dispute was won' }, response: adminWallet },
});

/** `GET /admin/customer-wallets`. */
export const listCustomerWallets = defineRoute({
  key: 'GET /admin/customer-wallets',
  summary: 'Customer balances',
  description:
    'Every customer wallet, most recently changed first. `state` filters positive, zero, negative or frozen wallets (repeat it for ' +
    'several); `q` searches the customer’s name and email.',
  tags: ['finance'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:read',
  query: listQuery({
    sorts: ['balance', 'updatedAt'],
    defaultSort: { field: 'updatedAt', order: 'desc' },
    filters: { state: { type: 'enum', values: ['positive', 'zero', 'negative', 'frozen'], ops: ['eq'] } },
    search: ['customer.name', 'customer.email'],
  }),
  success: { status: 200, schema: WalletRowSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        customer: { id: 12, name: 'Daniel Rivera', email: 'daniel@mail.example', status: 'active' },
        balance: '50.0000',
        frozen: null,
        updatedAt: '2026-11-10T09:30:00.000Z',
      },
    ],
  },
});
