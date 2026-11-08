// The storefront funnel (customers module, resolution b2c-10): IMEI checks, checkouts started, paid and delivered over a window. One
// read-only function shared by the dashboard's storefront block (feature 9, always 30 days) and `GET /admin/reports/funnel` (feature 19).
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../infra/db';

/** The numbers of the funnel over a window. */
export interface StorefrontFunnel {
  /** Distinct IP addresses seen on IMEI checks and checkout sessions in the window: an estimate, a lower bound of real visitors. */
  readonly visitorsEstimated: number;
  /** IMEI checks made on the storefront (`storefront_free` and `pre_order` sources). */
  readonly imeiChecks: number;
  /** Checkout sessions opened, whatever their status (the console's `paymentStarted` and the dashboard's `checkoutsStarted`). */
  readonly paymentStarted: number;
  /** Those sessions that created an order (paid). */
  readonly paid: number;
  /** Those paid sessions whose order is `completed`. */
  readonly delivered: number;
}

const DAY_MS = 86_400_000;

/**
 * Counts the storefront funnel over the last `days` days.
 *
 * Why: b2c-10: the window is `[now - days x 24 h, now)` (the start is included, the end is not); `imeiChecks` counts `imei_checks` with source `storefront_free` or
 * `pre_order`; `paymentStarted` counts `checkout_sessions` created in it (any status); `paid` those with an order; `delivered` those
 * whose order is `completed`. Until checkouts exist (14a, 16) every number is zero.
 *
 * Side effects: reads `imei_checks`, `checkout_sessions` and `orders`; no writes. `imei_checks` belongs to the risk module, which
 * exports no reader yet, so it is read with a plain select (the only foreign read of this file).
 *
 * @param db the database or a transaction
 * @param now the injected clock's time (decision 031)
 * @param days the window length in days
 * @returns the five numbers
 */
export async function storefrontFunnel(db: DbExecutor, now: Date, days: number): Promise<StorefrontFunnel> {
  const from = new Date(now.getTime() - days * DAY_MS);
  const checks = s.imeiChecks;
  const sessions = s.checkoutSessions;
  const [checkRow, sessionRow, visitors] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(checks)
      .where(
        and(
          inArray(checks.source, ['storefront_free', 'pre_order']),
          gte(checks.createdAt, from),
          lt(checks.createdAt, now),
        ),
      ),
    db
      .select({
        started: sql<number>`count(*)::int`,
        paid: sql<number>`(count(*) filter (where ${sessions.orderId} is not null))::int`,
        delivered: sql<number>`(count(*) filter (where ${s.orders.status} = 'completed'))::int`,
      })
      .from(sessions)
      .leftJoin(s.orders, eq(s.orders.id, sessions.orderId))
      .where(and(gte(sessions.createdAt, from), lt(sessions.createdAt, now))),
    db.execute<{ n: number }>(sql`
      select count(distinct ip)::int as n from (
        select ip from imei_checks where source in ('storefront_free', 'pre_order') and created_at >= ${from} and created_at < ${now} and ip is not null
        union all
        select ip from checkout_sessions where created_at >= ${from} and created_at < ${now} and ip is not null
      ) seen`),
  ]);
  return {
    visitorsEstimated: visitors.rows[0]?.n ?? 0,
    imeiChecks: checkRow[0]?.n ?? 0,
    paymentStarted: sessionRow[0]?.started ?? 0,
    paid: sessionRow[0]?.paid ?? 0,
    delivered: sessionRow[0]?.delivered ?? 0,
  };
}
