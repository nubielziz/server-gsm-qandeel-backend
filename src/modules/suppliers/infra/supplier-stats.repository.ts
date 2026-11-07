// Aggregates over `supplier_api_logs` and the latest periodic check of each supplier: the health figures of the suppliers page and the
// 24-hour history of its detail (resolution orders-suppliers-5, B22). Reads `service_checks` (health module, feature 9 writes it) with
// a plain select: the health module exports no reader yet.
import { inArray, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import type { CallCounts, LatestCheck } from '../domain/supplier-health';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** What the calls of one supplier say, over three windows. */
export interface CallFigures {
  readonly total1h: number;
  readonly ok1h: number;
  readonly total24h: number;
  readonly ok24h: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  /** The last 15 minutes, for the health word. */
  readonly last15: CallCounts;
}

/**
 * Aggregates the calls of suppliers over the last hour, 24 hours and 15 minutes.
 *
 * Why: B22: none of health, rates or latency are columns; they are computed from `supplier_api_logs` (the index `(supplier_id,
 * created_at desc)` covers the window). Latency is the median and 95th percentile of the time waited over the last 24 hours.
 *
 * @param db the database
 * @param supplierIds the suppliers
 * @param now the clock's time
 * @returns the figures by supplier id (a supplier with no call in 24 hours has no entry)
 */
export async function callFigures(
  db: DbExecutor,
  supplierIds: readonly number[],
  now: Date,
): Promise<Map<number, CallFigures>> {
  const figures = new Map<number, CallFigures>();
  if (supplierIds.length === 0) return figures;
  const hour = new Date(now.getTime() - HOUR_MS);
  const quarter = new Date(now.getTime() - 15 * MINUTE_MS);
  const day = new Date(now.getTime() - 24 * HOUR_MS);
  const log = s.supplierApiLogs;
  const rows = await db
    .select({
      supplierId: log.supplierId,
      total1h: sql<number>`(count(*) filter (where ${log.createdAt} >= ${hour}))::int`,
      ok1h: sql<number>`(count(*) filter (where ${log.createdAt} >= ${hour} and ${log.outcome} = 'ok'))::int`,
      total24h: sql<number>`count(*)::int`,
      ok24h: sql<number>`(count(*) filter (where ${log.outcome} = 'ok'))::int`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${log.durationMs})`,
      p95: sql<number | null>`percentile_cont(0.95) within group (order by ${log.durationMs})`,
      total15: sql<number>`(count(*) filter (where ${log.createdAt} >= ${quarter}))::int`,
      errors15: sql<number>`(count(*) filter (where ${log.createdAt} >= ${quarter} and ${log.outcome} = 'error'))::int`,
      timeouts15: sql<number>`(count(*) filter (where ${log.createdAt} >= ${quarter} and ${log.outcome} = 'timeout'))::int`,
    })
    .from(log)
    .where(
      sql`${log.supplierId} in (${sql.join(
        supplierIds.map((id) => sql`${id}`),
        sql`, `,
      )}) and ${log.createdAt} >= ${day}`,
    )
    .groupBy(log.supplierId);
  for (const row of rows) {
    figures.set(row.supplierId, {
      total1h: row.total1h,
      ok1h: row.ok1h,
      total24h: row.total24h,
      ok24h: row.ok24h,
      p50Ms: row.p50 === null ? null : Math.round(Number(row.p50)),
      p95Ms: row.p95 === null ? null : Math.round(Number(row.p95)),
      last15: { total: row.total15, errors: row.errors15, timeouts: row.timeouts15 },
    });
  }
  return figures;
}

/**
 * Reads the latest periodic check of suppliers.
 *
 * @param db the database
 * @param supplierIds the suppliers
 * @param now the clock's time
 * @returns the latest check by supplier id, with its age
 */
export async function latestChecks(
  db: DbExecutor,
  supplierIds: readonly number[],
  now: Date,
): Promise<Map<number, LatestCheck>> {
  const checks = new Map<number, LatestCheck>();
  if (supplierIds.length === 0) return checks;
  const check = s.serviceChecks;
  const rows = await db
    .selectDistinctOn([check.supplierId], {
      supplierId: check.supplierId,
      status: check.status,
      checkedAt: check.checkedAt,
    })
    .from(check)
    .where(inArray(check.supplierId, [...supplierIds]))
    .orderBy(check.supplierId, sql`${check.checkedAt} desc`);
  for (const row of rows) {
    if (row.supplierId !== null) {
      checks.set(row.supplierId, { status: row.status, ageMs: now.getTime() - row.checkedAt.getTime() });
    }
  }
  return checks;
}

/** One hour of the supplier's calls. */
export interface HourFigure {
  readonly at: Date;
  readonly successRate: number;
  readonly medianMs: number;
}

/**
 * The last 24 hours of a supplier's calls, hour by hour.
 *
 * Why: the detail's two charts (`history`): the share of calls that worked and the median time, per hour start in UTC, oldest first.
 * An hour with no call has no point; no calls at all gives an empty list, which hides the charts.
 *
 * @param db the database
 * @param supplierId the supplier
 * @param now the clock's time
 * @returns the points, oldest first
 */
export async function hourlyHistory(db: DbExecutor, supplierId: number, now: Date): Promise<HourFigure[]> {
  const log = s.supplierApiLogs;
  const since = new Date(now.getTime() - 24 * HOUR_MS);
  const hourStart = sql<Date>`date_trunc('hour', ${log.createdAt} at time zone 'UTC') at time zone 'UTC'`;
  const rows = await db
    .select({
      hour: hourStart,
      total: sql<number>`count(*)::int`,
      ok: sql<number>`(count(*) filter (where ${log.outcome} = 'ok'))::int`,
      median: sql<number>`percentile_cont(0.5) within group (order by ${log.durationMs})`,
    })
    .from(log)
    .where(sql`${log.supplierId} = ${supplierId} and ${log.createdAt} >= ${since}`)
    .groupBy(hourStart)
    .orderBy(hourStart);
  return rows.map((row) => ({
    at: new Date(row.hour),
    successRate: Math.round((row.ok / row.total) * 1000) / 10,
    medianMs: Math.round(Number(row.median)),
  }));
}
