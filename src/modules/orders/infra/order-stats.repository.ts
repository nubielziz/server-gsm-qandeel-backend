// Aggregate queries on `orders` for the merchant figures: the 30-day stats of the merchant list (identity's ClientStatsDirectory) and
// the portal dashboard's counts. Read only.
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { orders } from '../db/schema';

/** The 30-day aggregates of one merchant, as the database computed them. */
export interface RawClientStats {
  readonly clientId: number;
  readonly orders: number;
  /** Sum of `total_price` of non-rejected orders (4 decimals). */
  readonly spend: string;
  /** Sum of `total_price - total_cost` of completed orders (4 decimals). */
  readonly profit: string;
  readonly completed: number;
  readonly rejected: number;
  readonly lastOrderAt: Date | null;
}

/**
 * Aggregates the orders of several merchants created since a moment, in one query.
 *
 * Why: the window is "the last 30 days": it has a start and no end, so an order stamped a moment after the application's clock (the
 * database stamps `created_at`) is never left out.
 *
 * @param db the database or a transaction
 * @param clientIds the merchants of a page
 * @param from the start of the window (inclusive): the injected clock's now minus 30 days
 * @returns one row per merchant that has orders in the window
 */
export async function clientStatsRows(
  db: DbExecutor,
  clientIds: readonly number[],
  from: Date,
): Promise<RawClientStats[]> {
  if (clientIds.length === 0) return [];
  const rows = await db
    .select({
      clientId: orders.clientId,
      total: sql<number>`count(*)::int`,
      spend: sql<string>`coalesce(sum(${orders.totalPrice}) filter (where ${orders.status} <> 'rejected'), 0)::numeric(18,4)::text`,
      profit: sql<string>`coalesce(sum(${orders.totalPrice} - ${orders.totalCost}) filter (where ${orders.status} = 'completed'), 0)::numeric(18,4)::text`,
      completed: sql<number>`(count(*) filter (where ${orders.status} = 'completed'))::int`,
      rejected: sql<number>`(count(*) filter (where ${orders.status} = 'rejected'))::int`,
      lastOrderAt: sql<Date | null>`max(${orders.createdAt})`.mapWith((value: unknown) =>
        value === null || value === undefined ? null : new Date(value as string),
      ),
    })
    .from(orders)
    .where(and(inArray(orders.clientId, [...clientIds]), gte(orders.createdAt, from)))
    .groupBy(orders.clientId);
  return rows.flatMap((row) =>
    row.clientId === null
      ? []
      : [
          {
            clientId: row.clientId,
            orders: row.total,
            spend: row.spend,
            profit: row.profit,
            completed: row.completed,
            rejected: row.rejected,
            lastOrderAt: row.lastOrderAt,
          },
        ],
  );
}

/** How many orders of a merchant are in each status. */
export interface StatusCounts {
  readonly pending: number;
  readonly processing: number;
  readonly completed: number;
  readonly rejected: number;
}

/**
 * Counts a merchant's orders by status.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @returns the four counts (zero for a status with no orders)
 */
export async function statusCountsOf(db: DbExecutor, clientId: number): Promise<StatusCounts> {
  const rows = await db
    .select({ status: orders.status, total: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.clientId, clientId))
    .groupBy(orders.status);
  const counts = { pending: 0, processing: 0, completed: 0, rejected: 0 };
  for (const row of rows) counts[row.status] = row.total;
  return counts;
}
