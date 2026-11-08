// Route contracts of the growth pages of the customers module (map stage 19, domain I): the abandoned checkouts, the recovery send and
// the storefront sales funnel. Shapes match the console's `src/features/checkouts/types` (RULES checkouts, ANSWERS checkouts).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIsoDateTime, zJsonObject, zMoney } from '../../../common/contract';
import { CHECKOUT_SESSION_STATUSES } from '../db/schema';
import { RECOVERY_MAX_IDS, SKIP_REASONS } from '../domain/recovery';

/** One abandoned checkout as the console's table reads it. */
export const AbandonedCheckoutRow = z.object({
  id: zId,
  email: z
    .string()
    .describe("The buyer's address with most of it hidden (`ab•••@domain`); `q` searches the full address."),
  grossAmount: zMoney.describe('The basket in USD including VAT (`checkout_sessions.gross_amount`).'),
  fxRate: zDecimal.describe(
    'Units of the buyer currency per 1 USD, locked on the session; the console shows `grossAmount` x `fxRate`.',
  ),
  currencyCode: z.string().describe('The currency the buyer pays in.'),
  serviceName: z.string().describe('The service in the basket (`Unknown service` when it no longer exists).'),
  status: z
    .enum(CHECKOUT_SESSION_STATUSES)
    .describe(
      '`open` until paid; `expired` once the session ran out unpaid (judged on the clock, no job flips it); `paid` when it made an order.',
    ),
  utm: zJsonObject.describe('Where the buyer came from; the console reads `source`.'),
  createdAt: zIsoDateTime,
  recoveryEmailedAt: zIsoDateTime
    .nullable()
    .describe('`null` until a recovery email is sent, automatic or manual; set when the email is queued.'),
  orderId: zId
    .nullable()
    .describe(
      'Set when the session was paid; the console calls a row recovered when this and `recoveryEmailedAt` are both set.',
    ),
  marketingConsent: z
    .boolean()
    .describe(
      "True when the latest `marketing` consent record of the buyer's customer is a grant and the customer's own switch is on.",
    ),
  canRecover: z
    .boolean()
    .describe(
      'The server verdict: consent, customer active, no email sent, not paid, older than `abandonedMinutes` and not older than 30 days.',
    ),
});

const ROW_EXAMPLE = {
  id: 3000,
  email: 'al•••@mail.example',
  grossAmount: '4.7900',
  fxRate: '0.92000000',
  currencyCode: 'EUR',
  serviceName: 'Apple Warranty & Activation Date',
  status: 'expired',
  utm: { source: 'Direct' },
  createdAt: '2026-11-07T08:50:00.000Z',
  recoveryEmailedAt: null,
  orderId: null,
  marketingConsent: true,
  canRecover: true,
} as const;

/** `GET /admin/checkouts/abandoned`: the sessions people left, with the consent and the recovery verdict. */
export const listAbandonedCheckouts = defineRoute({
  key: 'GET /admin/checkouts/abandoned',
  summary: 'List abandoned checkouts',
  description:
    'Checkout sessions created in the last 30 days that are not paid, plus paid ones that had a recovery email (recovered). A session ' +
    'younger than `abandonedMinutes` (the storefront policy, 5 to 1440, default 60) is listed with `canRecover: false`. `q` is a ' +
    'case-insensitive contains over the FULL email while rows carry it masked. `canRecover=true` is the "Needs a reminder" filter and ' +
    'uses the same rule as the row flag. Default order: newest first. Needs `growth:read` only (the delay is applied by the server).',
  tags: ['checkouts'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'growth:read',
  query: listQuery({
    sorts: ['createdAt', 'grossAmount', 'recoveryEmailedAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { canRecover: { type: 'boolean', ops: ['eq'] } },
    search: ['email'],
  }),
  success: { status: 200, schema: AbandonedCheckoutRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ROW_EXAMPLE] },
});

const RecoverBody = z.object({
  ids: z
    .array(zId)
    .min(1, 'Choose at least one checkout.')
    .max(RECOVERY_MAX_IDS, `Send at most ${RECOVERY_MAX_IDS} checkouts at a time.`)
    .describe('The ticked checkouts. A repeated id counts once.'),
});

const RecoverResult = z.object({
  sent: z
    .number()
    .int()
    .min(0)
    .describe('How many recovery emails were queued (the worker sends them within moments).'),
  skipped: z
    .array(
      z.object({
        id: zId,
        reason: z
          .enum(SKIP_REASONS)
          .describe('Why this checkout was left out; the console prints a new code with spaces for underscores.'),
      }),
    )
    .describe('The checkouts left out, in the order they were sent.'),
});

/** `POST /admin/checkouts/recover`: queue one recovery email for each eligible checkout. */
export const recoverCheckouts = defineRoute({
  key: 'POST /admin/checkouts/recover',
  summary: 'Send recovery emails',
  description:
    'Decides each id again on the server, in this order: `not_found`, `already_emailed`, `already_paid`, `no_marketing_consent`, ' +
    '`recipient_suspended` (a suspended or blocked customer), `too_recent` (still inside the `abandonedMinutes` delay), `expired` (older ' +
    'than 30 days), then `no_template` or `template_off` when the `checkout.abandoned` email has no active template. An eligible ' +
    'checkout gets `recovery_emailed_at` set (once only, under a row lock, so two calls never mail one checkout twice) and one email ' +
    'queued; the worker sends it with a one-click link back to the saved basket, after checking consent again. One audit entry ' +
    'records the call. The answer is `200` even when everything was skipped.',
  tags: ['checkouts'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'growth:send',
  body: RecoverBody,
  success: { status: 200, schema: RecoverResult },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { ids: [3000, 3001, 3099] },
    response: {
      sent: 1,
      skipped: [
        { id: 3001, reason: 'already_emailed' },
        { id: 3099, reason: 'not_found' },
      ],
    },
  },
});

const DAYS_MESSAGE = 'Use 7, 30 or 90 days.';

const FunnelResult = z.object({
  days: z.number().int().describe('The period asked for.'),
  imeiChecks: z
    .number()
    .int()
    .min(0)
    .describe('IMEI checks made on the storefront (sources `storefront_free` and `pre_order`).'),
  paymentStarted: z.number().int().min(0).describe('Checkout sessions opened in the period, any status.'),
  paid: z.number().int().min(0).describe('Those sessions that made an order.'),
  delivered: z.number().int().min(0).describe('Those orders that are completed.'),
});

/** `GET /admin/reports/funnel`: the four steps of the storefront sales funnel. */
export const getFunnel = defineRoute({
  key: 'GET /admin/reports/funnel',
  summary: 'Storefront sales funnel',
  description:
    'Records, not people, storefront only, over `[now - days x 24 h, now)` (b2c-10): a record made exactly `days` x 24 h ago is counted, one ' +
    "made at this very moment is not (the end is exclusive, like the dashboard's). `imeiChecks` counts `imei_checks` from the storefront " +
    'sources; `paymentStarted` the checkout sessions created in the period; `paid` those with an order; `delivered` those whose order is ' +
    "completed. The dashboard's storefront block calls the same function (`storefrontFunnel`). `days` is 7, 30 or 90 (default 30); " +
    'anything else is `422` on `days`.',
  tags: ['checkouts'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'reports:growth',
  query: z.object({
    days: z.coerce
      .number({ error: DAYS_MESSAGE })
      .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)], { error: DAYS_MESSAGE }))
      .default(30),
  }),
  success: { status: 200, schema: FunnelResult },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: { days: 30, imeiChecks: 312, paymentStarted: 94, paid: 41, delivered: 38 } },
});
