// Route contract of the rank change (decision 064): `POST /admin/clients/:id/rank`, the one way an account's rank changes. The route is
// beyond the map (scripts/map-additions/48-accounts.mjs); the answer is what the console reads to show the moved amount and to read the
// account again.
import { z } from 'zod';
import { defineRoute, zId, zIdParam, zMoney } from '../../../common/contract';
import { AccountWalletSchema } from './wallet.contracts';

/**
 * The `Idempotency-Key` the rank change requires: 1 to 100 printable ASCII characters, no spaces.
 *
 * Why: a rank change ends sessions, revokes keys and may move money, so a retry of the same dialog must change nothing twice. A request
 * without the header is a `422`. The key is kept with the change (unique per account), so a retry after the first answer was lost
 * answers the same result.
 */
export const RankChangeHeaders = z.object({
  'idempotency-key': z
    .string()
    .trim()
    .min(1, 'Send an Idempotency-Key header.')
    .max(100, 'Keep the Idempotency-Key to 100 characters or fewer.')
    .regex(/^[\x21-\x7e]+$/, 'Use printable ASCII characters without spaces.'),
});

/** The body of the rank change: the new rank only (a credit limit is set afterwards, through its own route). */
export const RankChangeBody = z.object({ groupId: zId.describe('The rank the account moves to.') }).strict();

/** The rank now held, as the history row stores it. */
export const RankChangeRankSchema = z.object({
  id: zId,
  name: z.string(),
  kind: z.enum(['retail', 'merchant']),
});

/** The answer of the rank change. */
export const RankChangeResultSchema = z.object({
  rank: RankChangeRankSchema,
  // The same keys as every wallet write: the console shows the wallet after the change without another read.
  wallet: AccountWalletSchema.nullable().describe(
    'The live wallet after the change; `null` when the account has no wallet yet.',
  ),
  movedAmount: zMoney.describe('The balance moved to the wallet of the new kind (zero inside one kind).'),
  transactionId: zId
    .nullable()
    .describe('The journal of the move (`GET /admin/ledger/transactions/:id`); `null` when nothing moved.'),
  sessionsEnded: z.number().int().min(0),
  apiKeysRevoked: z.number().int().min(0),
});

const wallet = {
  kind: 'store' as const,
  currency: 'USD',
  balance: '42.5000',
  reserved: '0.0000',
  creditLimit: '0.0000',
  available: '42.5000',
  creditAllowed: false,
  frozen: null,
  enabled: true,
  pendingTopUps: { count: 0, amount: '0.0000' },
  openDisputes: 0,
  adjustApprovalLimit: '500.0000',
};

/** `POST /admin/clients/:id/rank`. */
export const changeAccountRank = defineRoute({
  key: 'POST /admin/clients/:id/rank',
  summary: 'Change the rank of an account',
  description:
    'The one way an account changes rank. Only the Owner may do it (`403 FORBIDDEN` otherwise), and the `Idempotency-Key` header is ' +
    'required (`422` without it): a retry with the same key and the same `groupId` answers the recorded change with the response header ' +
    '`idempotency-replayed: true`, another `groupId` under the key is `IDEMPOTENCY_KEY_REUSED`. The new rank must exist and differ ' +
    'from the current one (`422` on `groupId`). Inside one kind (merchant to merchant) only the rank changes, and a rank that allows no ' +
    'credit is refused while the credit limit is above zero (`409 RANK_CHANGE_BLOCKED`, code `credit_limit`). Across kinds the account ' +
    'must be free of everything that is still in flight: every reason found is listed together in `errors[]` on `groupId` with its code ' +
    '(`guest`, `open_hold`, `live_order`, `open_topup`, `open_dispute`, `open_refund`, `open_checkout`, `frozen`, `negative_balance`), ' +
    'and nothing is written. Otherwise the whole balance moves to the wallet of the new kind in one journal (kind `wallet_transfer`), ' +
    'the credit limit of a merchant wallet that is left is set to zero, every session of the account ends, every live API key is revoked ' +
    'when the account leaves the merchant kind, and an account without a password raised to a merchant rank is sent an invitation. The ' +
    'change and its blockers are audited. An anonymized account is `409 ANONYMIZED`.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:update',
  params: z.object({ id: zIdParam }),
  headers: RankChangeHeaders,
  body: RankChangeBody,
  success: { status: 200, schema: RankChangeResultSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'ANONYMIZED',
    'RANK_CHANGE_BLOCKED',
    'IDEMPOTENCY_KEY_REUSED',
  ],
  examples: {
    request: { groupId: 4 },
    response: {
      rank: { id: 4, name: 'Storefront retail', kind: 'retail' },
      wallet,
      movedAmount: '42.5000',
      transactionId: 9013,
      sessionsEnded: 2,
      apiKeysRevoked: 1,
    },
  },
});
