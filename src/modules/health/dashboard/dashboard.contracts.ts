// Route contract of the console's Dashboard read model: `GET /admin/dashboard` (map domain G, stage 9; MISMATCHES B87; resolutions
// identity-platform-8, -9, -10, catalog-1, b2c-10). The shapes are the console's `Dashboard` type (src/features/dashboard/types).
import { z } from 'zod';
import { defineRoute, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { zServiceType } from '../contracts/system-common';

const severity = z.enum(['critical', 'high', 'medium', 'low']);
const base = { id: z.string(), severity };
const supplierItem = <K extends 'supplier_down' | 'supplier_degraded'>(kind: K) =>
  z.object({
    ...base,
    kind: z.literal(kind),
    supplierId: zId,
    supplierName: z.string(),
    successRate: z.number().nullable(),
    openOrders: z.number().int(),
  });

/** One thing that needs a person, as facts; the console writes the sentence (`AttentionItem`). */
export const AttentionItem = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('orders_past_sla'),
    count: z.number().int(),
    oldestOrderId: zId,
    overdueSeconds: z.number(),
    targetSeconds: z.number(),
  }),
  z.object({
    ...base,
    kind: z.literal('orders_review'),
    count: z.number().int(),
    topReason: z.string().nullable(),
    topReasonCount: z.number().int(),
  }),
  supplierItem('supplier_down'),
  supplierItem('supplier_degraded'),
  z.object({
    ...base,
    kind: z.literal('supplier_balance_low'),
    supplierId: zId,
    supplierName: z.string(),
    balance: zMoney,
    minimum: zMoney,
    runwayDays: z.number().nullable(),
  }),
  z.object({
    ...base,
    kind: z.literal('services_below_floor'),
    count: z.number().int(),
    serviceNames: z.array(z.string()),
  }),
  z.object({
    ...base,
    kind: z.literal('deposits_pending'),
    count: z.number().int(),
    total: zMoney,
    oldestAt: zIsoDateTime,
  }),
  z.object({
    ...base,
    kind: z.literal('wallets_negative'),
    count: z.number().int(),
    clients: z.array(z.object({ id: zId, name: z.string(), balance: zMoney })),
  }),
  z.object({ ...base, kind: z.literal('merchants_pending'), count: z.number().int(), names: z.array(z.string()) }),
  z.object({
    ...base,
    kind: z.literal('commissions_accrued'),
    count: z.number().int(),
    total: zMoney,
    agents: z.number().int(),
  }),
  z.object({
    ...base,
    kind: z.literal('orders_held'),
    count: z.number().int(),
    captured: zMoney,
    oldestAt: zIsoDateTime,
  }),
  z.object({
    ...base,
    kind: z.literal('disputes_due'),
    count: z.number().int(),
    firstDisputeId: zId,
    dueAt: zIsoDateTime,
    amount: zMoney,
    fee: zMoney,
  }),
  z.object({
    ...base,
    kind: z.literal('tickets_late'),
    count: z.number().int(),
    oldestTicketId: zId,
    waitingSince: zIsoDateTime,
    subject: z.string(),
  }),
  z.object({ ...base, kind: z.literal('refunds_requested'), count: z.number().int(), total: zMoney }),
  z.object({
    ...base,
    kind: z.literal('refunds_failed'),
    count: z.number().int(),
    firstRefundId: zId,
    reason: z.string(),
  }),
  z.object({ ...base, kind: z.literal('fx_stale'), currencies: z.array(z.string()), oldestUpdatedAt: zIsoDateTime }),
]);

const PeriodStats = z.object({
  revenue: zMoney,
  profit: zMoney,
  orders: z.number().int(),
  successRate: z.number().nullable(),
  medianTurnaroundSeconds: z.number().nullable(),
});
const typeCounts = {
  imei: z.number().int(),
  server: z.number().int(),
  remote: z.number().int(),
  file: z.number().int(),
};

const Dashboard = z.object({
  generatedAt: zIsoDateTime,
  stats: z.object({ current: PeriodStats, previous: PeriodStats.nullable() }),
  attention: z.array(AttentionItem),
  queues: z.array(
    z.object({
      type: zServiceType,
      open: z.number().int(),
      review: z.number().int(),
      pastSla: z.number().int(),
      oldestCreatedAt: zIsoDateTime.nullable(),
    }),
  ),
  suppliers: z.array(
    z.object({
      id: zId,
      name: z.string(),
      enabled: z.boolean(),
      health: z.enum(['up', 'degraded', 'down']),
      successRate1h: z.number().nullable(),
      p50Ms: z.number().nullable(),
      balance: zMoney,
      lowBalance: z.boolean(),
    }),
  ),
  ordersByType: z.object({
    daily: z.array(z.object({ date: z.string(), ...typeCounts })),
    monthly: z.array(z.object({ month: z.string(), ...typeCounts })).nullable(),
  }),
  revenueByChannel: z
    .object({
      daily: z.array(z.object({ date: z.string(), b2b: zMoney, b2c: zMoney })),
      totals: z.object({
        last7Days: z.object({ b2b: zMoney, b2c: zMoney }),
        last30Days: z.object({ b2b: zMoney, b2c: zMoney }),
      }),
    })
    .nullable(),
  storefront: z
    .object({
      funnel: z.object({
        visitorsEstimated: z.number().int(),
        imeiChecks: z.number().int(),
        checkoutsStarted: z.number().int(),
        paid: z.number().int(),
        delivered: z.number().int(),
      }),
      averageOrder: zMoney.nullable(),
      refundRate: z.number().nullable(),
      disputeRate: z.number().nullable(),
      firstReplySeconds: z.number().nullable(),
      satisfaction: z.object({ average: z.number(), ratings: z.number().int() }).nullable(),
      heldForReview: z.number().int(),
    })
    .nullable(),
  topCustomers: z
    .array(z.object({ id: zId, name: z.string(), country: z.string(), orders: z.number().int(), spend: zMoney }))
    .nullable(),
  navCounts: z.object({
    orders: z.object({ open: z.number().int(), pastSla: z.number().int() }),
    finance: z.object({ pendingDeposits: z.number().int() }),
    merchants: z.object({ pendingApproval: z.number().int() }),
    support: z.object({ open: z.number().int(), late: z.number().int() }),
    refunds: z.object({ open: z.number().int(), disputesDueSoon: z.number().int() }),
    risk: z.object({ held: z.number().int() }),
  }),
});

/** `GET /admin/dashboard`: everything the Dashboard shows, from one snapshot. */
export const getDashboard = defineRoute({
  key: 'GET /admin/dashboard',
  summary: 'Dashboard',
  description:
    'One object, every section from one snapshot, cached about 15 seconds per (`scope`, `days`) (the sidebar reads it every minute for its counts). `scope` is `all`, `b2b` (merchants) or `b2c` (the storefront); `days` is 1, 7 or 14. ' +
    '`stats` covers orders created in the rolling window; `previous` is the window of the same length before it, or `null` when it had no order. `attention` is every item ranked critical, high, medium, low (stable): ' +
    '`supplier_down` and `supplier_degraded` come only from a real down or degraded check, never from an unknown or missing one, and supplier items only for active suppliers. Each kind has its own fixed severity (RULES dashboard 3): `disputes_due` counts every dispute that needs a response and is critical when the first is due within 3 days; `orders_review` counts merchant orders only (a held storefront order is `orders_held`); `fx_stale` uses the currencies page rule (older than 24 hours). `queues` has one row per service type; `pastSla` is the one age-only rule shared with `GET /admin/orders?pastSla=true`. ' +
    '`suppliers` maps the latest check to `up`, `degraded`, `down`, and an unknown or missing check to `degraded`. `services_below_floor` is judged on the effective cost (user rule 9). Money is USD as a 4-decimal string; ' +
    "payments, refunds and disputes convert per row at the checkout's locked rate or the current currency rate and the sum is rounded once. `storefront` and `topCustomers` are `null` for `b2b`, `revenueByChannel` is `null` unless `scope=all`; " +
    "`storefront` always covers the last 30 days and its funnel is the customers module's `storefrontFunnel(30)`.",
  tags: ['dashboard'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'dashboard:read',
  query: z.object({
    scope: z.enum(['all', 'b2b', 'b2c']).default('all'),
    days: z
      .enum(['1', '7', '14'])
      .default('7')
      .transform((value) => Number(value) as 1 | 7 | 14),
  }),
  success: { status: 200, schema: Dashboard },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED', 'DATABASE_UNAVAILABLE'],
});
