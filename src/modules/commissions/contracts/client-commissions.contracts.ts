// Route contracts of the merchant portal's commissions (map domain F, stage 11): the referral page and the merchant's own commissions.
// The console has no screen for these (the merchant portal is another frontend): the shapes are the lead's spec, MISMATCHES B164, and
// follow ALIGNMENT § 7, B121 and B153 (a merchant waiting for approval is refused).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { COMMISSION_ACCRUAL_STATUSES, COMMISSION_PLAN_KINDS } from '../db/schema';

/** `GET /client/referrals`. */
export const getMyReferrals = defineRoute({
  key: 'GET /client/referrals',
  summary: 'My referral link and referred merchants',
  description:
    "The signed-in merchant's referral code and link (`<PORTAL_BASE_URL>/register?ref=<code>`), the plan it is on (`null` when none) " +
    'and the merchants that signed up with its code: `referredCount` is exact, `referred` lists at most 100 of them, newest first, as a ' +
    'name and a join date each (never an id, an order or a figure of theirs).',
  tags: ['client-commissions'],
  surface: 'client',
  access: 'merchant-session',
  success: {
    status: 200,
    schema: z.object({
      referralCode: z.string(),
      referralLink: z.string(),
      plan: z
        .object({
          name: z.string(),
          kind: z.enum(COMMISSION_PLAN_KINDS),
          percent: zDecimal.describe('The rate in percent with 4 decimals.'),
          basis: z.string(),
          period: z.string(),
          startsAt: zIsoDateTime,
        })
        .nullable(),
      referredCount: z.number().int().min(0),
      referred: z.array(z.object({ name: z.string(), joinedAt: zIsoDateTime })),
    }),
  },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL'],
  examples: {
    response: {
      referralCode: 'GSM0001',
      referralLink: 'https://portal.gsm.example/register?ref=GSM0001',
      plan: {
        name: 'Referral',
        kind: 'referral',
        percent: '3.0000',
        basis: 'Order revenue of referred merchants',
        period: 'monthly',
        startsAt: '2026-09-16T12:00:00.000Z',
      },
      referredCount: 1,
      referred: [{ name: 'Casablanca Unlock', joinedAt: '2026-09-20T10:00:00.000Z' }],
    },
  },
});

/** `GET /client/commissions`. */
export const listMyCommissions = defineRoute({
  key: 'GET /client/commissions',
  summary: 'My commissions',
  description:
    'The commissions the signed-in merchant earns, newest first: `merchant.name` is the referred merchant whose order earned it (or ' +
    'the merchant itself for a rebate), `status` is `accrued` (earned, waiting for approval), `approved` (paid into the wallet) or ' +
    '`reversed` (the order was refunded or reopened before approval). Never the order id or the plan id. Filters `status` and `period` ' +
    '(`YYYY-MM`); sorts `createdAt` (default, newest first), `period`, `amount`. No totals are sent: a client filters by status and sums.',
  tags: ['client-commissions'],
  surface: 'client',
  access: 'merchant-session',
  query: listQuery({
    sorts: ['createdAt', 'period', 'amount'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: COMMISSION_ACCRUAL_STATUSES, ops: ['eq'] },
      period: { type: 'string', ops: ['eq'] },
    },
  }),
  success: {
    status: 200,
    schema: z.object({
      id: zId,
      period: z.string(),
      merchant: z.object({ name: z.string() }),
      basisAmount: zMoney.describe("The order's revenue."),
      percent: zDecimal,
      amount: zMoney,
      status: z.enum(COMMISSION_ACCRUAL_STATUSES),
      approvedAt: zIsoDateTime.nullable(),
      createdAt: zIsoDateTime,
    }),
  },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        id: 1,
        period: '2026-10',
        merchant: { name: 'Casablanca Unlock' },
        basisAmount: '16.2600',
        percent: '3.0000',
        amount: '0.4900',
        status: 'approved',
        approvedAt: '2026-10-10T21:37:21.644Z',
        createdAt: '2026-10-03T21:37:21.644Z',
      },
    ],
  },
});
