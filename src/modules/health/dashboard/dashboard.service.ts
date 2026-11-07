// The dashboard read model (`GET /admin/dashboard`): stats, the ranked attention list, queues by type, supplier health, two charts, the
// storefront block, top customers and the sidebar counts, built from one clock reading and cached 15 s per (scope, days).
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { CLOCK, type Clock } from '../../../common/clock';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import { orUnavailable } from '../application/database-guard';
import { customers, suppliers as suppliersApi } from '../infra/sibling-modules';
import {
  ATTENTION_SEVERITY,
  dashboardHealth,
  disputesDueSeverity,
  rankAttention,
  supplierAttentionKind,
  type Severity,
} from './attention';
import {
  type Scope,
  moneyFacts,
  orderCounts,
  ordersByType,
  pastSlaDetail,
  periodStats,
  queuesByType,
  reviewQueues,
  revenueByChannel,
  servicesBelowFloor,
  storefrontExtras,
  supplierRows,
} from './dashboard-reads';

/** Seconds a payload is cached: the sidebar polls it every minute from every page (ANSWERS dashboard Q3). */
export const DASHBOARD_TTL_SECONDS = 15;
const DAY_MS = 86_400_000;
const QUEUE_WORDS: Readonly<Record<string, string>> = {
  manual: 'Manual orders',
  needs_attention: 'Needs attention',
  review: 'Held for review',
  verification: 'Verification requested',
};
const TYPES = ['imei', 'server', 'remote', 'file'] as const;

/** The share of calls that worked, in percent with one decimal, or `null` without calls. */
const successRate = (ok: number, total: number): number | null =>
  total <= 0 ? null : Math.round((ok / total) * 1000) / 10;

/**
 * Builds the dashboard.
 *
 * Why: one `GET /admin/dashboard` call feeds every card of the Dashboard and the sidebar's six counts (B87), so every section comes from
 * one snapshot (one clock reading) and the whole payload is cached per (scope, days). Resolutions: identity-platform-8 (USD money and
 * the supplier health mapping), -9 (attention only from real checks), -10 (the age-only past-SLA rule), catalog-1 (floor on the effective
 * cost), b2c-10 (the funnel is `storefrontFunnel(30)`).
 *
 * Side effects: reads Postgres; caches the payload in the cache Redis.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The dashboard payload.
   *
   * @param scope `all`, `b2b` or `b2c`
   * @param days the period of the stat strip, the top lists and the attention facts
   * @returns the read model
   * @throws {AppError} `DATABASE_UNAVAILABLE` when Postgres is down
   */
  get(scope: Scope, days: number): Promise<Record<string, unknown>> {
    return this.cache.getOrLoad(this.keys.dashboard(scope, days), DASHBOARD_TTL_SECONDS, () =>
      orUnavailable(() => this.build(scope, days)),
    );
  }

  private async build(scope: Scope, days: number): Promise<Record<string, unknown>> {
    const now = this.clock.now();
    const db = this.db.db;
    const from = new Date(now.getTime() - days * DAY_MS);
    const before = new Date(from.getTime() - days * DAY_MS);
    const month = new Date(now.getTime() - 30 * DAY_MS);
    const withStorefront = scope !== 'b2b';
    // Merchant items (and the merchant orders in review) only for `all` and `b2b`, storefront items only for `all` and `b2c` (RULES dashboard 4).
    const b2b = scope !== 'b2c';
    const b2c = scope !== 'b2b';
    const { isLowBalance, runwayDays } = await suppliersApi();
    const { storefrontFunnel } = await customers();
    const [
      current,
      previous,
      queueRows,
      suppliers,
      past,
      review,
      floor,
      facts,
      byType,
      channel,
      funnel,
      extras,
      counts,
    ] = await Promise.all([
      periodStats(db, from, now, scope),
      periodStats(db, before, from, scope),
      queuesByType(db, now, scope),
      supplierRows(db, now),
      pastSlaDetail(db, now, scope),
      b2b ? reviewQueues(db) : Promise.resolve(new Map<string, number>()),
      servicesBelowFloor(db, now),
      moneyFacts(db, now),
      ordersByType(db, now, scope),
      scope === 'all' ? revenueByChannel(db, now) : Promise.resolve(null),
      withStorefront ? storefrontFunnel(db, now, 30) : Promise.resolve(null),
      withStorefront ? storefrontExtras(db, now, month, from) : Promise.resolve(null),
      orderCounts(db, now),
    ]);

    const suppliersView = suppliers.map((row) => {
      const runway = runwayDays({ balance: row.balance, creditRate: row.creditRate, weeklySpend: row.weeklySpend });
      return {
        row,
        runway,
        low: isLowBalance({ balance: row.balance, lowBalanceAlert: row.lowBalanceAlert, runwayDays: runway }),
      };
    });

    const items: Array<{ id: string; severity: Severity } & Record<string, unknown>> = [];
    if (past.count > 0 && past.oldestOrderId !== null) {
      items.push({
        id: 'orders_past_sla',
        severity: ATTENTION_SEVERITY.orders_past_sla,
        kind: 'orders_past_sla',
        count: past.count,
        oldestOrderId: past.oldestOrderId,
        overdueSeconds: past.overdueSeconds,
        targetSeconds: past.targetSeconds,
      });
    }
    const reviewTotal = [...review.values()].reduce((sum, n) => sum + n, 0);
    if (reviewTotal > 0) {
      const [topQueue, topCount] = [...review.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
      items.push({
        id: 'orders_review',
        severity: ATTENTION_SEVERITY.orders_review,
        kind: 'orders_review',
        count: reviewTotal,
        topReason: QUEUE_WORDS[topQueue] ?? null,
        topReasonCount: topCount,
      });
    }
    for (const { row, low, runway } of suppliersView) {
      // Enabled suppliers only (RULES dashboard 3): a paused or disabled supplier is off on purpose and raises nothing.
      if (row.status !== 'active') continue;
      const kind = supplierAttentionKind(row.check?.status ?? null);
      if (kind) {
        items.push({
          id: `${kind}:${row.id}`,
          severity: ATTENTION_SEVERITY[kind],
          kind,
          supplierId: row.id,
          supplierName: row.name,
          successRate: successRate(row.ok1h, row.total1h),
          openOrders: row.openOrders,
        });
      }
      if (low) {
        items.push({
          id: `supplier_balance_low:${row.id}`,
          severity: ATTENTION_SEVERITY.supplier_balance_low,
          kind: 'supplier_balance_low',
          supplierId: row.id,
          supplierName: row.name,
          balance: new Decimal(row.balanceUsd).toFixed(4),
          minimum: new Decimal(row.minimumUsd).toFixed(4),
          runwayDays: runway,
        });
      }
    }
    if (floor.count > 0) {
      items.push({
        id: 'services_below_floor',
        severity: ATTENTION_SEVERITY.services_below_floor,
        kind: 'services_below_floor',
        count: floor.count,
        serviceNames: floor.names,
      });
    }
    if (b2b && facts.depositsPending.count > 0 && facts.depositsPending.oldestAt) {
      items.push({
        id: 'deposits_pending',
        severity: ATTENTION_SEVERITY.deposits_pending,
        kind: 'deposits_pending',
        count: facts.depositsPending.count,
        total: facts.depositsPending.total,
        oldestAt: facts.depositsPending.oldestAt.toISOString(),
      });
    }
    if (b2b && facts.walletsNegative.count > 0) {
      items.push({
        id: 'wallets_negative',
        severity: ATTENTION_SEVERITY.wallets_negative,
        kind: 'wallets_negative',
        count: facts.walletsNegative.count,
        clients: facts.walletsNegative.clients,
      });
    }
    if (b2b && facts.merchantsPending.count > 0) {
      items.push({
        id: 'merchants_pending',
        severity: ATTENTION_SEVERITY.merchants_pending,
        kind: 'merchants_pending',
        count: facts.merchantsPending.count,
        names: facts.merchantsPending.names,
      });
    }
    if (b2b && facts.commissions.count > 0) {
      items.push({
        id: 'commissions_accrued',
        severity: ATTENTION_SEVERITY.commissions_accrued,
        kind: 'commissions_accrued',
        count: facts.commissions.count,
        total: facts.commissions.total,
        agents: facts.commissions.agents,
      });
    }
    if (b2c && facts.held.count > 0 && facts.held.oldestAt) {
      items.push({
        id: 'orders_held',
        severity: ATTENTION_SEVERITY.orders_held,
        kind: 'orders_held',
        count: facts.held.count,
        captured: facts.held.captured,
        oldestAt: facts.held.oldestAt.toISOString(),
      });
    }
    if (b2c && facts.disputesDue.count > 0 && facts.disputesDue.firstId !== null && facts.disputesDue.dueAt) {
      items.push({
        id: 'disputes_due',
        severity: disputesDueSeverity(facts.disputesDue.dueAt, now),
        kind: 'disputes_due',
        count: facts.disputesDue.count,
        firstDisputeId: facts.disputesDue.firstId,
        dueAt: facts.disputesDue.dueAt.toISOString(),
        amount: facts.disputesDue.amount,
        fee: facts.disputesDue.fee,
      });
    }
    if (b2c && facts.ticketsLate.count > 0 && facts.ticketsLate.oldestId !== null && facts.ticketsLate.since) {
      items.push({
        id: 'tickets_late',
        severity: ATTENTION_SEVERITY.tickets_late,
        kind: 'tickets_late',
        count: facts.ticketsLate.count,
        oldestTicketId: facts.ticketsLate.oldestId,
        waitingSince: facts.ticketsLate.since.toISOString(),
        subject: facts.ticketsLate.subject,
      });
    }
    if (b2c && facts.refundsRequested.count > 0) {
      items.push({
        id: 'refunds_requested',
        severity: ATTENTION_SEVERITY.refunds_requested,
        kind: 'refunds_requested',
        count: facts.refundsRequested.count,
        total: facts.refundsRequested.total,
      });
    }
    if (b2c && facts.refundsFailed.count > 0 && facts.refundsFailed.firstId !== null) {
      items.push({
        id: 'refunds_failed',
        severity: ATTENTION_SEVERITY.refunds_failed,
        kind: 'refunds_failed',
        count: facts.refundsFailed.count,
        firstRefundId: facts.refundsFailed.firstId,
        reason: facts.refundsFailed.reason,
      });
    }
    if (facts.fxStale.currencies.length > 0 && facts.fxStale.oldest) {
      items.push({
        id: 'fx_stale',
        severity: ATTENTION_SEVERITY.fx_stale,
        kind: 'fx_stale',
        currencies: facts.fxStale.currencies,
        oldestUpdatedAt: facts.fxStale.oldest.toISOString(),
      });
    }

    const totalOf = (rows: Array<{ b2b: string; b2c: string }>) =>
      rows.reduce((sum, row) => ({ b2b: sum.b2b.plus(row.b2b), b2c: sum.b2c.plus(row.b2c) }), {
        b2b: new Decimal(0),
        b2c: new Decimal(0),
      });
    const wire = (value: { b2b: Decimal; b2c: Decimal }) => ({ b2b: value.b2b.toFixed(4), b2c: value.b2c.toFixed(4) });
    const stats = (row: typeof current) => ({ ...row });
    return {
      generatedAt: now.toISOString(),
      stats: { current: stats(current), previous: previous.orders === 0 ? null : stats(previous) },
      attention: rankAttention(items),
      queues: TYPES.map((type) => {
        const row = queueRows.find((candidate) => candidate.type === type);
        return {
          type,
          open: row?.open ?? 0,
          review: row?.review ?? 0,
          pastSla: row?.pastSla ?? 0,
          oldestCreatedAt: row?.oldestCreatedAt?.toISOString() ?? null,
        };
      }),
      suppliers: suppliersView.map(({ row, low }) => ({
        id: row.id,
        name: row.name,
        enabled: row.status === 'active',
        health: dashboardHealth(row.check?.status ?? null),
        successRate1h: successRate(row.ok1h, row.total1h),
        p50Ms: row.p50Ms,
        balance: new Decimal(row.balanceUsd).toFixed(4),
        lowBalance: low,
      })),
      ordersByType: {
        daily: byType.daily.map((day) => ({ date: day.date, ...day.counts })),
        monthly: byType.monthly.every((entry) => Object.values(entry.counts).every((n) => n === 0))
          ? null
          : byType.monthly.map((entry) => ({ month: entry.month, ...entry.counts })),
      },
      revenueByChannel: channel
        ? {
            daily: channel,
            totals: { last7Days: wire(totalOf(channel.slice(-7))), last30Days: wire(totalOf(channel)) },
          }
        : null,
      storefront:
        funnel && extras
          ? {
              funnel: {
                visitorsEstimated: funnel.visitorsEstimated,
                imeiChecks: funnel.imeiChecks,
                checkoutsStarted: funnel.paymentStarted,
                paid: funnel.paid,
                delivered: funnel.delivered,
              },
              averageOrder: extras.averageOrder,
              refundRate: extras.refundRate,
              disputeRate: extras.disputeRate,
              firstReplySeconds: extras.firstReplySeconds,
              satisfaction: extras.satisfaction,
              heldForReview: facts.held.count,
            }
          : null,
      topCustomers: extras ? extras.topCustomers : null,
      navCounts: {
        orders: counts,
        finance: { pendingDeposits: facts.depositsPending.count },
        merchants: { pendingApproval: facts.merchantsPending.count },
        support: { open: facts.ticketsOpen, late: facts.ticketsLate.count },
        refunds: {
          open: facts.refundsRequested.count + facts.refundsFailed.count + facts.disputesDue.count,
          disputesDueSoon: facts.disputesDue.dueSoon,
        },
        risk: { held: facts.held.count },
      },
    };
  }
}
