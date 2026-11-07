// Drizzle queries on `service_checks` (health module): the checker's inserts, the latest row and the start of the current status
// per component, uptime over 24 hours, 7 and 30 days, the platform uptime by minute, the history buckets, and the purge.
import { type SQL, and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type CheckStatus, type NewServiceCheck, serviceChecks } from '../db/schema';
import { CORE_COMPONENTS, type BucketCounts } from '../domain/checks';

const DAY_MS = 86_400_000;

/** The latest check of one component and when its current status began. */
export interface ComponentState {
  readonly component: string;
  readonly status: CheckStatus;
  readonly latencyMs: number | null;
  readonly detail: string | null;
  readonly checkedAt: Date;
  /** The first check of the unbroken run of this status that ends with the latest check. */
  readonly since: Date;
}

/** Uptime counters of one component. */
export interface UptimeCounts {
  readonly total24: number;
  readonly failed24: number;
  readonly total7: number;
  readonly failed7: number;
  readonly total30: number;
  readonly failed30: number;
}

/**
 * Inserts the results of one checker run.
 *
 * @param db the database
 * @param rows the checks, each with its own `checkedAt` from the injected clock
 */
export async function insertChecks(db: DbExecutor, rows: readonly NewServiceCheck[]): Promise<void> {
  if (rows.length > 0) await db.insert(serviceChecks).values([...rows]);
}

/**
 * The latest check of every component and the start of its current status.
 *
 * Why: the health page shows `since` (how long it has been like this) next to each status. The start is the first check after
 * the newest check with another status (or the first check in the window), looked up over the last 30 days only.
 *
 * @param db the database
 * @param now the clock's time
 * @returns one entry per component that has a check in the last 30 days
 */
export async function componentStates(db: DbExecutor, now: Date): Promise<Map<string, ComponentState>> {
  const from = new Date(now.getTime() - 30 * DAY_MS);
  const result = await db.execute<{
    component: string;
    status: CheckStatus;
    latency_ms: number | null;
    detail: string | null;
    checked_at: Date;
    since: Date;
  }>(sql`
    with latest as (
      select distinct on (component) component, status, latency_ms, detail, checked_at
      from service_checks where checked_at >= ${from}
      order by component, checked_at desc, id desc
    )
    select l.component, l.status, l.latency_ms, l.detail, l.checked_at,
      (select min(c.checked_at) from service_checks c
        where c.component = l.component and c.checked_at >= ${from}
          and c.checked_at > coalesce(
            (select max(x.checked_at) from service_checks x
              where x.component = l.component and x.checked_at >= ${from} and x.status <> l.status),
            '-infinity'::timestamptz)) as since
    from latest l`);
  const states = new Map<string, ComponentState>();
  for (const row of result.rows) {
    states.set(row.component, {
      component: row.component,
      status: row.status,
      latencyMs: row.latency_ms,
      detail: row.detail,
      checkedAt: new Date(row.checked_at),
      since: new Date(row.since),
    });
  }
  return states;
}

/**
 * Uptime counters per component over the three windows (checks that were not `down` over all checks).
 *
 * @param db the database
 * @param now the clock's time
 * @returns the counters by component key
 */
export async function uptimeCounts(db: DbExecutor, now: Date): Promise<Map<string, UptimeCounts>> {
  const t24 = new Date(now.getTime() - DAY_MS);
  const t7 = new Date(now.getTime() - 7 * DAY_MS);
  const t30 = new Date(now.getTime() - 30 * DAY_MS);
  const c = serviceChecks;
  const rows = await db
    .select({
      component: c.component,
      total24: sql<number>`(count(*) filter (where ${c.checkedAt} >= ${t24}))::int`,
      failed24: sql<number>`(count(*) filter (where ${c.checkedAt} >= ${t24} and ${c.status} = 'down'))::int`,
      total7: sql<number>`(count(*) filter (where ${c.checkedAt} >= ${t7}))::int`,
      failed7: sql<number>`(count(*) filter (where ${c.checkedAt} >= ${t7} and ${c.status} = 'down'))::int`,
      total30: sql<number>`count(*)::int`,
      failed30: sql<number>`(count(*) filter (where ${c.status} = 'down'))::int`,
    })
    .from(c)
    .where(sql`${c.checkedAt} >= ${t30}`)
    .groupBy(c.component);
  return new Map(rows.map(({ component, ...counts }) => [component, counts]));
}

/** Platform uptime: minutes with checks and minutes in which a core component was down. */
export interface PlatformUptime {
  readonly windows: {
    readonly h24: { readonly minutes: number; readonly down: number };
    readonly d7: { readonly minutes: number; readonly down: number };
    readonly d30: { readonly minutes: number; readonly down: number };
  };
  /** The last 30 UTC days, oldest first; a day without checks has `minutes` 0. */
  readonly daily: ReadonlyArray<{ readonly day: string; readonly minutes: number; readonly down: number }>;
}

/**
 * The platform uptime by minute: a minute counts as down when any core component had a `down` check in it.
 *
 * @param db the database
 * @param now the clock's time
 * @returns the three windows and the 30 daily points
 */
export async function platformUptime(db: DbExecutor, now: Date): Promise<PlatformUptime> {
  const t24 = new Date(now.getTime() - DAY_MS);
  const t7 = new Date(now.getTime() - 7 * DAY_MS);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const t30 = new Date(today.getTime() - 29 * DAY_MS);
  const core = sql.join(
    CORE_COMPONENTS.map((key) => sql`${key}`),
    sql`, `,
  );
  const rows = await db.execute<{ minute: Date; down: boolean }>(sql`
    select date_trunc('minute', checked_at) as minute, bool_or(status = 'down') as down
    from service_checks
    where checked_at >= ${t30} and component in (${core})
    group by 1`);
  const windows = { h24: { minutes: 0, down: 0 }, d7: { minutes: 0, down: 0 }, d30: { minutes: 0, down: 0 } };
  const perDay = new Map<string, { minutes: number; down: number }>();
  for (const row of rows.rows) {
    const at = new Date(row.minute);
    const day = at.toISOString().slice(0, 10);
    const entry = perDay.get(day) ?? { minutes: 0, down: 0 };
    entry.minutes += 1;
    if (row.down) entry.down += 1;
    perDay.set(day, entry);
    const sets: Array<{ minutes: number; down: number }> = [windows.d30];
    if (at >= t7) sets.push(windows.d7);
    if (at >= t24) sets.push(windows.h24);
    for (const set of sets) {
      set.minutes += 1;
      if (row.down) set.down += 1;
    }
  }
  const daily = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(t30.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    return { day, ...(perDay.get(day) ?? { minutes: 0, down: 0 }) };
  });
  return { windows, daily };
}

/**
 * History of checks in buckets, per component.
 *
 * Why: `GET /admin/system/checks`: the worst check, the number of checks and failures and the p95 response time of answered
 * checks, grouped by `floor(epoch / width)` so the buckets align with the ones the service builds.
 *
 * @param db the database
 * @param from the start of the first bucket
 * @param bucketSeconds the bucket width
 * @param component one component key, or `undefined` for all
 * @returns counts by component key, then by bucket index (`floor(epoch / width)`)
 */
export async function checkBuckets(
  db: DbExecutor,
  from: Date,
  bucketSeconds: number,
  component: string | undefined,
): Promise<Map<string, Map<number, BucketCounts>>> {
  const c = serviceChecks;
  // The width is inlined (a whole number from our own range table): a bound parameter in both the select list and GROUP BY would not match.
  const bucket = sql<number>`floor(extract(epoch from ${c.checkedAt}) / ${sql.raw(String(Math.trunc(bucketSeconds)))})::bigint`;
  const where: SQL[] = [sql`${c.checkedAt} >= ${from}`];
  if (component !== undefined) where.push(eq(c.component, component));
  const rows = await db
    .select({
      component: c.component,
      bucket,
      down: sql<number>`(count(*) filter (where ${c.status} = 'down'))::int`,
      degraded: sql<number>`(count(*) filter (where ${c.status} = 'degraded'))::int`,
      ok: sql<number>`(count(*) filter (where ${c.status} = 'ok'))::int`,
      unknown: sql<number>`(count(*) filter (where ${c.status} = 'unknown'))::int`,
      p95: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${c.latencyMs}) filter (where ${c.status} in ('ok', 'degraded') and ${c.latencyMs} is not null)`,
    })
    .from(c)
    .where(and(...where))
    .groupBy(c.component, bucket);
  const out = new Map<string, Map<number, BucketCounts>>();
  for (const row of rows) {
    const byBucket = out.get(row.component) ?? new Map<number, BucketCounts>();
    byBucket.set(Number(row.bucket), {
      down: row.down,
      degraded: row.degraded,
      ok: row.ok,
      unknown: row.unknown,
      p95: row.p95 === null ? null : Math.round(Number(row.p95)),
    });
    out.set(row.component, byBucket);
  }
  return out;
}

/**
 * The latest check latency of some components within a window.
 *
 * @param db the database
 * @param components the component keys
 * @param from how far back to look
 * @returns the latest latency by component (`null` when the latest check had none)
 */
export async function latestLatencies(
  db: DbExecutor,
  components: readonly string[],
  from: Date,
): Promise<Map<string, number | null>> {
  if (components.length === 0) return new Map();
  const c = serviceChecks;
  const rows = await db
    .selectDistinctOn([c.component], { component: c.component, latencyMs: c.latencyMs })
    .from(c)
    .where(and(inArray(c.component, [...components]), sql`${c.checkedAt} >= ${from}`))
    .orderBy(c.component, sql`${c.checkedAt} desc, ${c.id} desc`);
  return new Map(rows.map((row) => [row.component, row.latencyMs]));
}

/**
 * Deletes checks older than a cut-off.
 *
 * @param db the database
 * @param before rows older than this go
 * @returns how many rows were deleted
 */
export async function purgeChecks(db: DbExecutor, before: Date): Promise<number> {
  const rows = await db
    .delete(serviceChecks)
    .where(lt(serviceChecks.checkedAt, before))
    .returning({ id: serviceChecks.id });
  return rows.length;
}
