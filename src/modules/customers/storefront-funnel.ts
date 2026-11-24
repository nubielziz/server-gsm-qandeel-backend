// The storefront funnel (customers module, resolution b2c-10): checkouts started, paid and delivered over a window. One
// read-only function shared by the dashboard's storefront block (feature 9, always 30 days) and `GET /admin/reports/funnel` (feature 19).
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../infra/db';

/** The numbers of the funnel over a window. */
export interface StorefrontFunnel {
  /** Distinct IP addresses seen on checkout sessions in the window: an estimate, a lower bound of real visitors. */
  readonly visitorsEstimated: number;
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
 * Why: b2c-10: the window is `[now - days x 24 h, now)` (the start is included, the end is not); `paymentStarted` counts
 * `checkout_sessions` created in it (any status); `paid` those with an order; `delivered` those whose order is `completed`. Until
 * checkouts exist (14a, 16) every number is zero. The visitor estimate counts the addresses of checkout sessions.
 *
 * Side effects: reads `checkout_sessions` and `orders`; no writes.
 *
 * @param db the database or a transaction
 * @param now the injected clock's time (decision 031)
 * @param days the window length in days
 * @returns the four numbers
 */
export async function storefrontFunnel(db: DbExecutor, now: Date, days: number): Promise<StorefrontFunnel> {
  const from = new Date(now.getTime() - days * DAY_MS);
  const sessions = s.checkoutSessions;
  const [sessionRow, visitors] = await Promise.all([
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
      select count(distinct ip)::int as n from checkout_sessions
      where created_at >= ${from} and created_at < ${now} and ip is not null`),
  ]);
  return {
    visitorsEstimated: visitors.rows[0]?.n ?? 0,
    paymentStarted: sessionRow[0]?.started ?? 0,
    paid: sessionRow[0]?.paid ?? 0,
    delivered: sessionRow[0]?.delivered ?? 0,
  };
}
