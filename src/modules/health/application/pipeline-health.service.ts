// The order pipeline, supplier and webhook health views (`GET /admin/system/orders-health`, `/suppliers`, `/webhooks`): what an outage
// costs in orders, how each supplier is doing and whether webhooks arrive. Postgres-sourced, so valid while Prometheus is down.
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { CLOCK, type Clock } from '../../../common/clock';
import { CacheKeys } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import { RedisService } from '../../../infra/redis';
import { bucketStarts } from '../domain/checks';
import { type Measure, SPEC, measure } from '../domain/measure';
import {
  attentionAndHeld,
  completedSpendBySupplier,
  dispatchP95Seconds,
  lastOkCalls,
  oldestIncomingEvent,
  outgoingWebhooks,
  stuckOrders,
  stuckTrend,
  supplierCalls,
  suppliersForHealth,
  typeOutcomes,
} from '../infra/foreign-reads.repository';
import { componentStates } from '../infra/service-checks.repository';
import { suppliers as suppliersApi } from '../infra/sibling-modules';
import { orUnavailable } from './database-guard';

const QUARTER_HOUR_MS = 15 * 60_000;
const WEEK_MS = 7 * 86_400_000;
const LABELS: Readonly<Record<string, string>> = {
  pending: 'Pending',
  processing: 'Processing',
  needs_attention: 'Needs attention',
};
const ORDER: readonly string[] = ['pending', 'processing', 'needs_attention'];

const rate = (count: number, total: number): number | null => (total <= 0 ? null : (count / total) * 100);

/** A count in the incoming-callback counters of one hour. */
export interface IntakeCounts {
  readonly delivered: number;
  readonly failed: number;
  readonly retrying: number;
}

/**
 * Builds the pipeline, supplier and webhook views.
 *
 * Why: the Orders tab shows orders past SLA with the money held for them, the pipeline's dispatch time and outcomes, and each
 * supplier's health; the Queues tab shows webhook delivery. The past-SLA rule is feature 5's exported predicate (B92); the supplier
 * health word is feature 6's shared computation (orders-suppliers-5), with error and timeout rates from `supplier_api_logs.outcome`
 * (health-commissions-8).
 *
 * Side effects: reads Postgres and the cache Redis counters; no writes.
 */
@Injectable()
export class PipelineHealthService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `GET /admin/system/orders-health`.
   *
   * @returns past-SLA orders, dispatch time, outcomes per service type and held orders
   * @throws {AppError} `DATABASE_UNAVAILABLE` when Postgres is down
   */
  ordersHealth() {
    return orUnavailable(async () => {
      const now = this.clock.now();
      const db = this.db.db;
      const points = bucketStarts(now, 900, 96);
      const [stuck, trend, p95, outcomes, held] = await Promise.all([
        stuckOrders(db, now),
        stuckTrend(db, points),
        dispatchP95Seconds(db, now),
        typeOutcomes(db, now),
        attentionAndHeld(db),
      ]);
      const total = stuck.reduce((sum, row) => sum + row.count, 0);
      const heldTotal = stuck.reduce((sum, row) => sum.plus(row.held), new Decimal(0));
      return {
        checkedAt: now.toISOString(),
        stuck: {
          total: measure(SPEC.pastSla, total),
          heldAmount: heldTotal.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
          byStatus: ORDER.flatMap((status) => {
            const row = stuck.find((candidate) => candidate.status === status);
            return row
              ? [
                  {
                    status,
                    label: LABELS[status] ?? status,
                    count: row.count,
                    oldestAgeSeconds: row.oldestPlacedAt
                      ? Math.max(0, Math.floor((now.getTime() - row.oldestPlacedAt.getTime()) / 1000))
                      : null,
                    heldAmount: new Decimal(row.held).toFixed(4),
                  },
                ]
              : [];
          }),
          trend: points.map((point, index) => ({ at: point.toISOString(), value: trend[index] ?? 0 })),
        },
        needsAttention: held.needsAttention,
        dispatchP95: measure(SPEC.dispatch, p95),
        byServiceType: (['imei', 'server', 'remote', 'file'] as const).map((type) => {
          const row = outcomes.find((candidate) => candidate.type === type);
          const finished = (row?.completed ?? 0) + (row?.rejected ?? 0);
          return {
            type,
            total: finished,
            success: measure(SPEC.success, rate(row?.completed ?? 0, finished)),
            failure: measure(SPEC.failure, rate(row?.rejected ?? 0, finished)),
          };
        }),
        heldByRisk: {
          count: held.heldCount,
          amount: new Decimal(held.heldAmount).toFixed(4),
          oldestAt: held.heldOldest?.toISOString() ?? null,
        },
      };
    });
  }

  /**
   * `GET /admin/system/suppliers`.
   *
   * @returns one row per supplier
   * @throws {AppError} `DATABASE_UNAVAILABLE` when Postgres is down
   */
  suppliersHealth() {
    return orUnavailable(async () => {
      const now = this.clock.now();
      const db = this.db.db;
      const { isLowBalance, runwayDays, supplierHealth } = await suppliersApi();
      const [suppliers, calls, lastOk, states, spend] = await Promise.all([
        suppliersForHealth(db),
        supplierCalls(db, new Date(now.getTime() - QUARTER_HOUR_MS)),
        lastOkCalls(db),
        componentStates(db, now),
        completedSpendBySupplier(db, new Date(now.getTime() - WEEK_MS)),
      ]);
      return {
        checkedAt: now.toISOString(),
        suppliers: suppliers.map((supplier) => {
          const state = states.get(`supplier:${supplier.id}`);
          const figure = calls.get(supplier.id);
          const counts = figure ?? { total: 0, errors: 0, timeouts: 0, p50Ms: null };
          const health =
            supplier.status === 'disabled'
              ? 'unknown'
              : supplierHealth({
                  status: supplier.status,
                  check: state ? { status: state.status, ageMs: now.getTime() - state.checkedAt.getTime() } : null,
                  calls: counts,
                });
          const okCheck = state && state.status === 'ok' ? state.checkedAt : null;
          const lastSuccess = [lastOk.get(supplier.id) ?? null, okCheck]
            .filter((at): at is Date => at !== null)
            .sort((a, b) => b.getTime() - a.getTime())[0];
          const synced = [supplier.balanceCheckedAt, supplier.pricesSyncedAt]
            .filter((at): at is Date => at !== null)
            .sort((a, b) => b.getTime() - a.getTime())[0];
          const rateOf = (part: number, spec: typeof SPEC.supplierErrors): Measure =>
            measure(spec, rate(part, counts.total));
          // The suppliers page's verdict (orders-suppliers-7, M65): below the alert amount or under two days of runway at the
          // 7-day completed-order cost, so `balance.state` never disagrees with `lowBalance` of `GET /admin/suppliers`.
          const runway = runwayDays({
            balance: supplier.balance,
            creditRate: supplier.creditRate,
            weeklySpend: spend.get(supplier.id) ?? '0.0000',
          });
          const low = isLowBalance({
            balance: supplier.balance,
            lowBalanceAlert: supplier.lowBalanceAlert,
            runwayDays: runway,
          });
          // Critical is a low balance near zero: with no alert amount set (0), a zero balance is not low, so it is not critical either.
          const critical = low && new Decimal(supplier.balance).lte(new Decimal(supplier.lowBalanceAlert).mul('0.1'));
          return {
            id: supplier.id,
            name: supplier.name,
            status: supplier.status,
            health,
            since: supplier.status === 'disabled' || !state ? null : state.since.toISOString(),
            lastSuccessAt: lastSuccess?.toISOString() ?? null,
            latency: measure(
              SPEC.supplierLatency,
              supplier.status === 'disabled' ? null : (state?.latencyMs ?? figure?.p50Ms ?? null),
            ),
            errorRate: rateOf(counts.errors, SPEC.supplierErrors),
            timeoutRate: rateOf(counts.timeouts, SPEC.supplierErrors),
            circuit: 'closed' as const,
            lastSyncAt: synced?.toISOString() ?? null,
            balance: {
              amount: new Decimal(supplier.balance).toFixed(4),
              currency: supplier.currency,
              state: critical ? ('crit' as const) : low ? ('warn' as const) : ('ok' as const),
              checkedAt: supplier.balanceCheckedAt?.toISOString() ?? null,
            },
          };
        }),
      };
    });
  }

  /**
   * `GET /admin/system/webhooks`.
   *
   * @returns delivery health of outgoing and incoming webhooks over the last 24 hours
   * @throws {AppError} `DATABASE_UNAVAILABLE` when Postgres is down
   */
  webhooksHealth() {
    return orUnavailable(async () => {
      const now = this.clock.now();
      const [out, oldestIn, intake] = await Promise.all([
        outgoingWebhooks(this.db.db, now),
        oldestIncomingEvent(this.db.db),
        this.intake(now),
      ]);
      const direction = (counts: IntakeCounts, oldest: Date | null) => ({
        successRate: measure(SPEC.webhookSuccess, rate(counts.delivered, counts.delivered + counts.failed)),
        delivered: counts.delivered,
        failed: counts.failed,
        retrying: counts.retrying,
        oldestUndeliveredAt: oldest?.toISOString() ?? null,
        oldestAge: measure(SPEC.webhookAge, oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0),
      });
      return { outgoing: direction(out, out.oldestUndelivered), incoming: direction(intake, oldestIn) };
    });
  }

  /** The incoming callback counters of the last 24 hours (25 hourly hashes in the cache Redis; a missing hash is zero). */
  private async intake(now: Date): Promise<IntakeCounts> {
    const hours = Array.from({ length: 25 }, (_, i) => new Date(now.getTime() - i * 3_600_000));
    const label = (at: Date) => at.toISOString().slice(0, 13).replace(/\D/g, '');
    try {
      const rows = await Promise.all(hours.map((at) => this.redis.cache.hgetall(this.keys.webhookIntake(label(at)))));
      const sum = (field: string) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
      return { delivered: sum('delivered'), failed: sum('failed'), retrying: sum('retrying') };
    } catch {
      // The counters are a cache: without Redis the incoming side reads as "nothing seen" rather than failing the page.
      return { delivered: 0, failed: 0, retrying: 0 };
    }
  }
}
