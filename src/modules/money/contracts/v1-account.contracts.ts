// Route contracts of the merchant's account over REST v1 (map domain E, stage 7): `GET /v1/account` (the wallet figures and the client
// group) and `GET /v1/transactions` (the account statement by cursor), plus the Dhru action `accountinfo`. No console screen calls them;
// the shapes follow ALIGNMENT § 7 and decision 026.
import { z } from 'zod';
import { defineRoute, zCursor, zCursorLimit, zCursorPage, zId, zMoney } from '../../../common/contract';
import { defineDhruAction } from '../../../common/dhru';
import { StatementRowSchema, WalletViewSchema } from './wallet.contracts';

const ACCOUNT_ERRORS = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'IP_NOT_ALLOWED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_PENDING_APPROVAL',
  'RATE_LIMITED',
] as const;

const AccountSchema = WalletViewSchema.extend({
  currency: z.string().describe('The currency of every figure: `USD`.'),
  group: z
    .object({ id: zId, name: z.string() })
    .describe("The merchant's client group, which sets its prices and limits."),
});

const ACCOUNT_EXAMPLE = {
  balance: '1209.7500',
  reserved: '71.2300',
  creditLimit: '2000.0000',
  available: '3209.7500',
  currency: 'USD',
  group: { id: 2, name: 'Gold' },
} as const;

/** `GET /v1/account`. */
export const getV1Account = defineRoute({
  key: 'GET /v1/account',
  summary: 'My account',
  description:
    "The merchant's wallet: `balance` (negative while credit is in use), `reserved` (held for open orders), `creditLimit` and " +
    '`available` (`balance` plus `creditLimit`: what the next order may spend), with the client group. Never cached. Scope `account:read`.',
  tags: ['account'],
  surface: 'v1',
  access: 'api-key',
  permission: 'account:read',
  success: { status: 200, schema: AccountSchema },
  errors: [...ACCOUNT_ERRORS],
  examples: { response: ACCOUNT_EXAMPLE },
});

const TRANSACTION_EXAMPLE = {
  id: 1394,
  transactionId: 1394,
  kind: 'deposit',
  memo: 'Deposit PAY-1000 (Bank transfer)',
  amount: '360.0000',
  balanceAfter: '1209.7500',
  createdAt: '2026-10-28T09:30:00.000Z',
} as const;

/** `GET /v1/transactions`. */
export const listV1Transactions = defineRoute({
  key: 'GET /v1/transactions',
  summary: 'My account statement',
  description:
    "The wallet's statement, newest first, in pages: `limit` (1 to 100, default 50) and `cursor` (the `nextCursor` of the previous " +
    'page). `amount` and `balanceAfter` are from the merchant side (a deposit is positive, an order hold negative). Lines that only move ' +
    'the hold never appear. Never cached. Scope `account:read`.',
  tags: ['account'],
  surface: 'v1',
  access: 'api-key',
  permission: 'account:read',
  query: z.object({ limit: zCursorLimit, cursor: zCursor }),
  success: { status: 200, schema: zCursorPage(StatementRowSchema) },
  errors: [...ACCOUNT_ERRORS, 'VALIDATION_FAILED'],
  examples: { response: { data: [TRANSACTION_EXAMPLE], nextCursor: null } },
});

/** The Dhru action `accountinfo`: `{ message, AccoutInfo: { credit, mail, currency } }` (the spelling of the standard). */
export const dhruAccountInfo = defineDhruAction({
  key: 'DHRU accountinfo',
  summary: 'Account info',
  description:
    "The merchant's available balance (`credit`: the wallet balance plus the credit limit), email and currency. The key `AccoutInfo` is " +
    'spelled as in the Dhru Fusion standard.',
  success: z.object({
    message: z.literal('Your Accout Info'),
    AccoutInfo: z.object({
      credit: zMoney.describe('What the merchant may spend now: balance plus credit limit.'),
      mail: z.string(),
      currency: z.string(),
    }),
  }),
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_APPROVAL', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: {
    response: {
      message: 'Your Accout Info',
      AccoutInfo: { credit: '3209.7500', mail: 'ops@zainmobilehub.example', currency: 'USD' },
    },
  },
});
