// Read queries on `alert_events` and `incidents` (health module) for the System health overview: the open alerts and incidents and
// how many alerts were open at each moment of the last 24 hours. Alert rules, the evaluator and the routes that change alerts
// are feature 12b's; this file only reads. Supplier and gateway names for an alert's subject come from a plain join.
import { desc, eq, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { alertEvents, incidents } from '../db/schema';

/** An open alert with the name of what it is about. */
export interface OpenAlert {
  readonly id: number;
  readonly ruleName: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly status: 'firing' | 'acknowledged';
  readonly subjectLabel: string | null;
  readonly startedAt: Date;
}

/**
 * The alerts that are firing or acknowledged, critical first and then newest.
 *
 * @param db the database
 * @returns the open alerts
 */
export async function openAlerts(db: DbExecutor): Promise<OpenAlert[]> {
  const a = alertEvents;
  const rows = await db
    .select({
      id: a.id,
      ruleName: a.ruleName,
      severity: a.severity,
      status: a.status,
      subjectType: a.subjectType,
      subjectId: a.subjectId,
      startedAt: a.startedAt,
      supplierName: s.suppliers.name,
      gatewayName: s.paymentGateways.name,
    })
    .from(a)
    .leftJoin(s.suppliers, sql`${a.subjectType} = 'supplier' and ${s.suppliers.id} = ${a.subjectId}`)
    .leftJoin(s.paymentGateways, sql`${a.subjectType} = 'gateway' and ${s.paymentGateways.id} = ${a.subjectId}`)
    .where(sql`${a.status} in ('firing', 'acknowledged')`)
    .orderBy(sql`(case when ${a.severity} = 'critical' then 0 else 1 end)`, desc(a.startedAt), desc(a.id));
  return rows.map((row) => ({
    id: row.id,
    ruleName: row.ruleName,
    severity: row.severity,
    status: row.status as 'firing' | 'acknowledged',
    subjectLabel:
      row.supplierName ??
      row.gatewayName ??
      (row.subjectType === 'system' || row.subjectId === null ? null : `${row.subjectType} #${row.subjectId}`),
    startedAt: row.startedAt,
  }));
}

/**
 * How many alerts were open at each of some moments.
 *
 * @param db the database
 * @param points the moments (15 minutes apart)
 * @returns the count at each moment
 */
export async function alertTrend(db: DbExecutor, points: readonly Date[]): Promise<number[]> {
  if (points.length === 0) return [];
  const a = alertEvents;
  const result = await db.execute<{ t: Date; n: number }>(sql`
    select g.t as t, count(a.id)::int as n
    from generate_series(${(points[0] as Date).toISOString()}::timestamptz, ${(points[points.length - 1] as Date).toISOString()}::timestamptz, interval '15 minutes') as g(t)
    left join ${a} a on a.started_at <= g.t and (a.resolved_at is null or a.resolved_at > g.t)
    group by g.t order by g.t`);
  const counts = new Map(result.rows.map((row) => [new Date(row.t).getTime(), row.n]));
  return points.map((point) => counts.get(point.getTime()) ?? 0);
}

/** An unresolved incident. */
export interface OpenIncident {
  readonly id: number;
  readonly title: string;
  readonly severity: 'minor' | 'major' | 'critical';
  readonly status: 'investigating' | 'identified' | 'monitoring';
  readonly components: string[];
  readonly startedAt: Date;
}

/**
 * The incidents that are not resolved, newest first.
 *
 * @param db the database
 * @returns the open incidents
 */
export async function openIncidents(db: DbExecutor): Promise<OpenIncident[]> {
  const rows = await db
    .select()
    .from(incidents)
    .where(sql`${incidents.status} <> 'resolved'`)
    .orderBy(desc(incidents.startedAt), desc(incidents.id));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    severity: row.severity,
    status: row.status as OpenIncident['status'],
    components: row.components ?? [],
    startedAt: row.startedAt,
  }));
}

/**
 * When the last incident was resolved.
 *
 * @param db the database
 * @returns the time, or `null` when no incident was ever resolved
 */
export async function lastIncidentResolvedAt(db: DbExecutor): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${incidents.resolvedAt})` })
    .from(incidents)
    .where(eq(incidents.status, 'resolved'));
  return row?.at ? new Date(row.at) : null;
}

/**
 * Whether the alert evaluator ran lately.
 *
 * Why: M213: while the rules cannot be evaluated, "no open alerts" must not read as healthy. Feature 12b's evaluator records its
 * runs in `job_runs` under the job name {@link ALERT_EVALUATION_JOB}; until it exists no run is found.
 *
 * @param db the database
 * @param since how far back a succeeded run counts
 * @returns true when a succeeded run started since then
 */
export async function alertsEvaluatedSince(db: DbExecutor, since: Date): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from job_runs where job = ${ALERT_EVALUATION_JOB} and status = 'succeeded' and started_at >= ${since}`,
  );
  return (rows.rows[0]?.n ?? 0) > 0;
}

/** The `job_runs.job` of the alert evaluator of feature 12b. */
export const ALERT_EVALUATION_JOB = 'alert_evaluation';
