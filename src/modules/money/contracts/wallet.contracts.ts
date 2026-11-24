// Route contracts of the wallets of accounts (decision 064; map domain E, stage 3): the admin console's wallet, statement, manual adjustment,
// credit limit, freeze and unfreeze at one address for both wallet kinds, and the merchant portal's own wallet and statement. Shapes match
// the console (docs/contract/endpoints/money.md).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zMoney, zSignedMoney } from '../../../common/contract';

/** The four wallet figures (all `Money`, merchant side). */
export const WalletViewSchema = z.object({
  balance: zSignedMoney.describe(
    'The wallet balance; positive is the merchant money, negative while credit is in use.',
  ),
  reserved: zMoney.describe('Held for open orders.'),
  creditLimit: zMoney.describe('How far the balance may go below zero.'),
  available: zSignedMoney.describe('Spendable now: balance plus credit limit.'),
});

/**
 * The live wallet of an account of either rank (`GET /admin/clients/:id/wallet` and the answer of every wallet write).
 *
 * Why: one shape for both kinds, so the console draws one panel. The four figures of the merchant wallet keep their meaning; a store
 * balance has no reserve and no credit.
 */
export const AccountWalletSchema = z.object({
  kind: z
    .enum(['merchant', 'store'])
    .describe('Which wallet is live: the merchant wallet (hold and settle) or the store balance (pay first).'),
  currency: z.string().describe('Always USD.'),
  balance: zSignedMoney.describe(
    'In the account own sign: positive is the account money; negative while credit is in use or after a lost chargeback.',
  ),
  reserved: zMoney.describe('Held for open orders (merchant wallet; always 0.0000 for a store balance).'),
  creditLimit: zMoney.describe(
    'How far the balance may go below zero (merchant wallet; always 0.0000 for a store balance).',
  ),
  available: zSignedMoney.describe(
    'Spendable now: balance plus credit limit; a store balance reads zero while held, switched off or below zero.',
  ),
  creditAllowed: z.boolean().describe('Whether the rank allows a credit limit (merchant wallet only).'),
  frozen: z
    .object({ at: zIsoDateTime, reason: z.string() })
    .nullable()
    .describe('The hold: when and why; null when the wallet is not held.'),
  enabled: z
    .boolean()
    .describe(
      'Whether the wallet may be used at all: always true for a merchant wallet, the shop switch for a store balance.',
    ),
  pendingTopUps: z
    .object({ count: z.number().int().min(0), amount: zMoney.describe('The net the unpaid top-ups would add.') })
    .describe('Top-ups created and not yet credited.'),
  openDisputes: z.number().int().min(0).describe('Open disputes of the account card top-ups.'),
  adjustApprovalLimit: zMoney.describe(
    "A staff member's credits to this kind of wallet within 24 hours, and any single debit, above this need an owner (settings wallet.adjust_approval_limit for merchant wallets and wallet.customer.adjust_approval_limit for store balances, decision 049).",
  ),
});

/** One line of an account statement. */
export const StatementRowSchema = z.object({
  id: zId.describe('The ledger entry id.'),
  transactionId: zId.describe('The journal (`GET /admin/ledger/transactions/:id`).'),
  kind: z.string().describe('The entry kind: deposit, order_hold, order_release, adjustment, commission, ...'),
  memo: z.string(),
  orderId: zId
    .nullable()
    .optional()
    .describe('The order the line is about, when it is one (the staff statement; absent on the merchant portal).'),
  amount: zSignedMoney.describe('Signed from the account side: a deposit is positive, an order hold negative.'),
  balanceAfter: zSignedMoney.describe('The wallet balance right after the line, account side.'),
  createdAt: zIsoDateTime,
});

/**
 * The `Idempotency-Key` every staff wallet write requires: 1 to 100 printable ASCII characters, no spaces.
 *
 * Why: a retry of the same dialog must change nothing twice. The console makes one key per dialog opening.
 */
export const WalletKeyHeader = z.object({
  'idempotency-key': z
    .string()
    .trim()
    .min(1, 'Send an Idempotency-Key header.')
    .max(100, 'Keep the Idempotency-Key to 100 characters or fewer.')
    .regex(/^[\x21-\x7e]+$/, 'Use printable ASCII characters without spaces.'),
});

const merchantWallet = {
  balance: '1209.7500',
  reserved: '71.2300',
  creditLimit: '2000.0000',
  available: '3209.7500',
};
const wallet = {
  kind: 'merchant' as const,
  currency: 'USD',
  ...merchantWallet,
  creditAllowed: true,
  frozen: null,
  enabled: true,
  pendingTopUps: { count: 0, amount: '0.0000' },
  openDisputes: 0,
  adjustApprovalLimit: '10000.0000',
};
const statementRow = {
  id: 1394,
  transactionId: 1394,
  kind: 'deposit',
  memo: 'Deposit PAY-1000 (Bank transfer)',
  orderId: null,
  amount: '360.0000',
  balanceAfter: '1209.7500',
  createdAt: '2026-10-28T09:30:00.000Z',
};

const STAFF_WRITE_ERRORS = ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'] as const;

/** `GET /admin/clients/:id/wallet`. */
export const getClientWallet = defineRoute({
  key: 'GET /admin/clients/:id/wallet',
  summary: 'The live wallet of an account',
  description:
    'The wallet of the kind the account rank gives now: a merchant wallet (balance, reserved, credit limit, available) or a store ' +
    'balance (no reserve, no credit), with the hold, the unpaid top-ups, the open top-up disputes and the approval limit of its kind. ' +
    'All zero while the account has no wallet. Never cached.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: AccountWalletSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: wallet },
});

/** `GET /admin/clients/:id/statement`. */
export const listClientStatement = defineRoute({
  key: 'GET /admin/clients/:id/statement',
  summary: 'An account wallet statement',
  description:
    'One row per ledger entry on the live wallet of the account, newest first. `amount` and `balanceAfter` are from the account side, and ' +
    '`orderId` names the order a line is about. `createdAt_gte` and `createdAt_lte` filter by the posting time. `wallet=merchant` or ' +
    '`wallet=store` reads the history of a wallet the account left behind by a rank change (`live` is the default). Lines that only ' +
    'move the hold (`order_settle`) never appear. Never cached.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:read',
  params: z.object({ id: zIdParam }),
  query: listQuery({
    sorts: ['createdAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { createdAt: { type: 'datetime', ops: ['gte', 'lte'] } },
    extra: { wallet: z.enum(['live', 'merchant', 'store']).optional() },
  }),
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

/** The body of the freeze and the unfreeze. */
const ReasonBody = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Add a reason of at least 5 characters.')
    .max(200, 'Keep the reason to 200 characters or fewer.'),
});

/** `POST /admin/clients/:id/wallet/adjust`. */
export const adjustClientWallet = defineRoute({
  key: 'POST /admin/clients/:id/wallet/adjust',
  summary: 'Add to or deduct from the live wallet of an account',
  description:
    'Posts the manual adjustment (credit: Dr adjustments / Cr the wallet; debit: the mirror) with the reason in the memo, and audits it. ' +
    "It works on the live wallet of either kind. A staff member's credits to wallets of one kind within 24 hours, this one included and, " +
    'for merchant wallets, counted with the parts by which they raised credit limits, above the approval limit of that kind (settings ' +
    '`wallet.adjust_approval_limit` for merchant wallets, default $10,000, and `wallet.customer.adjust_approval_limit` for store ' +
    'balances, default $500), or a single debit above it, are refused with `409 APPROVAL_REQUIRED`; an Owner is not limited and a retry of ' +
    'an accepted adjustment is answered as before (decision 049). A merchant debit below the credit limit is `CREDIT_LIMIT_EXCEEDED`; a ' +
    'store debit below zero is `INSUFFICIENT_FUNDS`; a store credit needs an account that can sign in and is not anonymized (`NO_ACCOUNT`, ' +
    '`ANONYMIZED`) and mails the customer. The `Idempotency-Key` header is required for both kinds: a retry with the same key and body ' +
    'answers the first adjustment (`idempotency-replayed: true`), also for a store adjustment made before the accounts merged; the same key ' +
    'with another body is `IDEMPOTENCY_KEY_REUSED`. Works while the wallet is on hold.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:adjust',
  params: z.object({ id: zIdParam }),
  headers: WalletKeyHeader,
  body: AdjustBody,
  success: { status: 200, schema: z.object({ transactionId: zId, wallet: AccountWalletSchema }) },
  errors: [
    ...STAFF_WRITE_ERRORS,
    'APPROVAL_REQUIRED',
    'CREDIT_LIMIT_EXCEEDED',
    'INSUFFICIENT_FUNDS',
    'NO_ACCOUNT',
    'ANONYMIZED',
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
  summary: 'Set the credit limit of a merchant wallet',
  description:
    'Sets the overdraft limit of the merchant wallet; `0.0000` removes the credit. A limit above zero needs a rank that allows credit ' +
    '(`422` on `creditLimit` otherwise), and a store balance has no credit limit (`422` on `creditLimit`, `not_allowed`). Lowering the ' +
    'limit below the credit in use is allowed: new orders are refused until a top-up. Raising it on a wallet that is on hold is refused ' +
    '(`409 WALLET_FROZEN`). Raising the limit above the approval limit of adjustments (`wallet.adjust_approval_limit`, default $10,000) ' +
    "needs an Owner (`403 FORBIDDEN`, decision 049), and so does a raise that takes the staff member's credits to merchant wallets and " +
    'credit-limit raises within 24 hours above it (the raised part counts); lowering it never does. A rank change of the same account and ' +
    'this change are judged one after the other. The `Idempotency-Key` header is required: a retry with the same key and body answers ' +
    'the first result (`idempotency-replayed: true`) and changes nothing twice; the same key with another body is `IDEMPOTENCY_KEY_REUSED`. ' +
    'No ledger entry; audited.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:credit_limit',
  params: z.object({ id: zIdParam }),
  headers: WalletKeyHeader,
  body: z.object({ creditLimit: zMoney }),
  success: { status: 200, schema: AccountWalletSchema },
  errors: [...STAFF_WRITE_ERRORS, 'WALLET_FROZEN', 'IDEMPOTENCY_KEY_REUSED'],
  examples: { request: { creditLimit: '2000.0000' }, response: wallet },
});

/** `POST /admin/clients/:id/wallet/freeze`. */
export const freezeClientWallet = defineRoute({
  key: 'POST /admin/clients/:id/wallet/freeze',
  summary: 'Put the live wallet of an account on hold',
  description:
    'Puts the live wallet, of either kind, on hold. A merchant wallet on hold takes no new order hold (`409 WALLET_FROZEN`) and no credit-limit ' +
    'raise, while settlement and release of holds that exist, credits and staff debits still post; a store balance stops paying from ' +
    'the balance and card top-ups. Freezing a wallet that is on hold changes nothing (still audited). Audited; a store balance owner is ' +
    'emailed. The `Idempotency-Key` header is required: a retry with the same key and body answers the first result ' +
    '(`idempotency-replayed: true`), also after a later unfreeze, and changes nothing; the same key with another body is ' +
    '`IDEMPOTENCY_KEY_REUSED`.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:adjust',
  params: z.object({ id: zIdParam }),
  headers: WalletKeyHeader,
  body: ReasonBody,
  success: { status: 200, schema: AccountWalletSchema },
  errors: [...STAFF_WRITE_ERRORS, 'IDEMPOTENCY_KEY_REUSED'],
  examples: {
    request: { reason: 'Checking a disputed top-up' },
    response: { ...wallet, frozen: { at: '2026-11-10T10:00:00.000Z', reason: 'Checking a disputed top-up' } },
  },
});

/** `POST /admin/clients/:id/wallet/unfreeze`. */
export const unfreezeClientWallet = defineRoute({
  key: 'POST /admin/clients/:id/wallet/unfreeze',
  summary: 'Lift the hold on the live wallet of an account',
  description:
    'Clears the hold on the live wallet. Refused while a store balance is below zero (`409 CONFLICT`: bring it to zero first) or while a ' +
    'dispute of one of the account top-ups is open (`409 OPEN_DISPUTE`). Unfreezing a wallet that is not on hold changes nothing. ' +
    "Audited. The `Idempotency-Key` header is required and is stored and replayed like the freeze's.",
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'wallet:adjust',
  params: z.object({ id: zIdParam }),
  headers: WalletKeyHeader,
  body: ReasonBody,
  success: { status: 200, schema: AccountWalletSchema },
  errors: [...STAFF_WRITE_ERRORS, 'CONFLICT', 'OPEN_DISPUTE', 'IDEMPOTENCY_KEY_REUSED'],
  examples: { request: { reason: 'The dispute was won' }, response: wallet },
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
  errors: ['UNAUTHORIZED'],
  examples: { response: merchantWallet },
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
  errors: ['UNAUTHORIZED', 'VALIDATION_FAILED'],
  examples: { response: [statementRow] },
});
