// Route contract of the growth pages of the customers module (map stage 19, domain I): the storefront sales funnel. The shape matches the
// console's `src/features/checkouts/types` (RULES checkouts, ANSWERS checkouts).
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';

const DAYS_MESSAGE = 'Use 7, 30 or 90 days.';

const FunnelResult = z.object({
  days: z.number().int().describe('The period asked for.'),
  paymentStarted: z.number().int().min(0).describe('Checkout sessions opened in the period, any status.'),
  paid: z.number().int().min(0).describe('Those sessions that made an order.'),
  delivered: z.number().int().min(0).describe('Those orders that are completed.'),
});

/** `GET /admin/reports/funnel`: the three steps of the storefront sales funnel. */
export const getFunnel = defineRoute({
  key: 'GET /admin/reports/funnel',
  summary: 'Storefront sales funnel',
  description:
    'Records, not people, storefront only, over `[now - days x 24 h, now)` (b2c-10): a record made exactly `days` x 24 h ago is counted, one ' +
    "made at this very moment is not (the end is exclusive, like the dashboard's). `paymentStarted` counts the checkout sessions " +
    'created in the period; `paid` those with an order; `delivered` those whose order is ' +
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
  examples: { response: { days: 30, paymentStarted: 94, paid: 41, delivered: 38 } },
});
