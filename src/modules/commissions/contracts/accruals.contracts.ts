// Route contracts of the commission accruals (map domain F, routes /admin/commission-accruals*, stage 11): list, show and the bulk
// approval. Shapes match the console's `src/features/commissions/types` (docs/contract/endpoints/commissions.md, resolutions
// health-commissions-3, -4 and -11, ANSWERS commissions Q1 to Q8).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { COMMISSION_ACCRUAL_STATUSES } from '../db/schema';

/** The most accruals one approval may carry (the console's "Select all" reads up to 1000). */
export const MAX_APPROVAL_IDS = 1000;

const Status = z.enum(COMMISSION_ACCRUAL_STATUSES);

const NamedRef = z.object({ id: zId, name: z.string() });

/** An accrual as the accruals tab reads it. */
const AccrualRow = z.object({
  id: zId,
  planId: zId,
  beneficiaryId: zId,
  orderId: zId.describe('The completed order the commission comes from: an accrual always has one.'),
  period: z.string().describe('The completion month, `YYYY-MM`.'),
  basisAmount: zMoney.describe("The order's revenue."),
  percent: zDecimal.describe("The plan's rate when the order completed; a later rate change never touches it."),
  amount: zMoney.describe('`basisAmount x percent / 100`, 4 decimals.'),
  status: Status.describe(
    "`accrued` (earned, waiting), `approved` (paid into the agent's wallet) or `reversed` (the order was refunded or reopened before approval).",
  ),
  ledgerTxId: zId.nullable().describe('The `commission` posting that paid it; `null` until approved.'),
  approvedAt: zIsoDateTime
    .nullable()
    .optional()
    .describe('Extra: when it was approved; `null` until then; kept when an approved accrual is paid back.'),
  reversedAt: zIsoDateTime
    .nullable()
    .optional()
    .describe(
      'Extra: when the order was refunded or reopened; an `approved` accrual with it set was paid back with a reversing entry.',
    ),
  createdAt: zIsoDateTime.describe('When it was earned.'),
  updatedAt: zIsoDateTime,
  beneficiary: NamedRef.nullable().describe('The agent that earns it.'),
  merchant: NamedRef.nullable().describe(
    "The order's merchant: the referred merchant, or the agent itself for a rebate.",
  ),
});

const ACCRUAL_EXAMPLE = {
  id: 1,
  planId: 1,
  beneficiaryId: 1,
  orderId: 48101,
  period: '2026-10',
  basisAmount: '16.2600',
  percent: '3.0000',
  amount: '0.4900',
  status: 'approved',
  ledgerTxId: 422,
  approvedAt: '2026-10-10T21:37:21.644Z',
  reversedAt: null,
  createdAt: '2026-10-03T21:37:21.644Z',
  updatedAt: '2026-10-10T21:37:21.644Z',
  beneficiary: { id: 1, name: 'Zain Mobile Hub' },
  merchant: { id: 8, name: 'Casablanca Unlock' },
} as const;

/** `GET /admin/commission-accruals`. */
export const listCommissionAccruals = defineRoute({
  key: 'GET /admin/commission-accruals',
  summary: 'List commission accruals',
  description:
    'Commissions earned by agents, newest first by default, with the agent (`beneficiary`) and the referred merchant (`merchant`) ' +
    'joined. Filters: `status` (`accrued`, `approved`, `reversed`), `beneficiaryId` (the agent), `orderId`, `period`, `createdAt_gte` ' +
    '/ `_lte` and `approvedAt_gte` / `_lte` (ISO times); sorts `createdAt`, `approvedAt`, `basisAmount`, `percent`, `amount`, ' +
    '`status` (names are not sortable). The console reads 25 a page, and `_start=0&_end=1000` with `status=accrued` for "Select all"; its ' +
    'counts use `_end=1` and the `x-total-count` header.',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:read',
  query: listQuery({
    sorts: ['createdAt', 'approvedAt', 'basisAmount', 'percent', 'amount', 'status', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: COMMISSION_ACCRUAL_STATUSES, ops: ['eq', 'ne'] },
      beneficiaryId: { type: 'id', ops: ['eq'] },
      orderId: { type: 'id', ops: ['eq'] },
      period: { type: 'string', ops: ['eq'] },
      createdAt: { type: 'datetime' },
      approvedAt: { type: 'datetime' },
    },
  }),
  success: { status: 200, schema: AccrualRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ACCRUAL_EXAMPLE] },
});

/** `GET /admin/commission-accruals/:id`. */
export const showCommissionAccrual = defineRoute({
  key: 'GET /admin/commission-accruals/:id',
  summary: 'Show a commission accrual',
  description: 'The same row as the list.',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: AccrualRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: ACCRUAL_EXAMPLE },
});

/** `POST /admin/commission-accruals/approve`. */
export const approveCommissionAccruals = defineRoute({
  key: 'POST /admin/commission-accruals/approve',
  summary: 'Approve and pay out commissions in bulk',
  description:
    `Body \`{ ids }\`: 1 to ${MAX_APPROVAL_IDS} accrual ids (\`422\` on \`ids\` otherwise; a repeated id counts once). The ready ones are ` +
    "grouped by agent and each agent is paid with one `commission` posting for the sum (Dr `commission_expense` / Cr the agent's " +
    '`client_wallet`), all in one transaction; each accrual becomes `approved` with its `ledgerTxId` and `approvedAt`. An unknown id ' +
    '("This accrual does not exist."), an accrual that is not `accrued` ("Already approved.") and one whose order was refunded or ' +
    'reopened ("Reversed: the order was refunded or reopened.") are skipped with their reason, never failed; so is an accrual of 0 ("Nothing to ' +
    'pay: the amount is 0."), which stays `accrued`. `total` is the money actually posted. One audit row per agent paid.',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:approve',
  body: z.object({
    ids: z
      .array(zId)
      .min(1, 'Tick at least one accrual.')
      .max(MAX_APPROVAL_IDS, `Approve at most ${MAX_APPROVAL_IDS} accruals at a time.`),
  }),
  success: {
    status: 200,
    schema: z.object({
      approved: z.number().int().min(0).describe('How many accruals were approved.'),
      total: zMoney.describe("The money posted to the agents' wallets."),
      skipped: z.array(z.object({ id: zId, reason: z.string() })),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { ids: [4, 5, 6] },
    response: { approved: 2, total: '0.8800', skipped: [{ id: 6, reason: 'Already approved.' }] },
  },
});
