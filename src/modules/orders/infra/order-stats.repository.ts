// Aggregate queries on `orders` for the account figures: the 30-day stats of the account list (identity's ClientStatsDirectory), the lifetime
// figures and the portal dashboard's counts. Read only. The buyer is `account_id` (decision 064): the 30-day and lifetime figures cover every
// order of the account, whatever the door; the dashboard counts only the orders of the merchant doors.
import { and, gte, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { orders } from '../db/schema';
import { merchantDoorSql } from './order-sql';

/** The 30-day aggregates of one account, as the database computed them. */
export interface RawAccountStats {
  readonly accountId: number;
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
 * Aggregates the orders of several accounts created since a moment, in one query.
 *
 * Why: the window is "the last 30 days": it has a start and no end, so an order stamped a moment after the application's clock (the
 * database stamps `created_at`) is never left out. Every order of the account counts, the shop's and the merchant's alike.
 *
 * @param db the database or a transaction
 * @param accountIds the accounts of a page
 * @param from the start of the window (inclusive): the injected clock's now minus 30 days
 * @returns one row per account that has orders in the window
 */
export async function accountStatsRows(
  db: DbExecutor,
  accountIds: readonly number[],
  from: Date,
): Promise<RawAccountStats[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({
      accountId: orders.accountId,
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
    .where(and(inArray(orders.accountId, [...accountIds]), gte(orders.createdAt, from)))
    .groupBy(orders.accountId);
  return rows.map((row) => ({
    accountId: row.accountId,
    orders: row.total,
    spend: row.spend,
    profit: row.profit,
    completed: row.completed,
    rejected: row.rejected,
    lastOrderAt: row.lastOrderAt,
  }));
}

/** The lifetime figures of one account over every order it ever placed, as the database computed them. */
export interface RawLifetimeStats {
  readonly accountId: number;
  readonly ordersCount: number;
  readonly firstOrderAt: Date;
  readonly lastOrderAt: Date;
  /** Sum of `total_price + tax_amount` of non-rejected orders (4 decimals): what the account paid, tax included. */
  readonly totalSpent: string;
}

/**
 * Aggregates every order of several accounts, whatever the door, status and date.
 *
 * Why: decision 064: the lifetime figures of an account are the same over the shop's orders and the merchant's, so an account that
 * changed rank keeps one history.
 *
 * @param db the database or a transaction
 * @param accountIds the accounts
 * @returns one row per account that has at least one order
 */
export async function lifetimeStatsRows(db: DbExecutor, accountIds: readonly number[]): Promise<RawLifetimeStats[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({
      accountId: orders.accountId,
      ordersCount: sql<number>`count(*)::int`,
      firstOrderAt: sql<Date>`min(${orders.createdAt})`.mapWith(orders.createdAt),
      lastOrderAt: sql<Date>`max(${orders.createdAt})`.mapWith(orders.createdAt),
      totalSpent: sql<string>`coalesce(sum(${orders.totalPrice} + ${orders.taxAmount}) filter (where ${orders.status} <> 'rejected'), 0)::numeric(18,4)::text`,
    })
    .from(orders)
    .where(inArray(orders.accountId, [...accountIds]))
    .groupBy(orders.accountId);
  return rows;
}

/** How many orders of an account are in each status. */
export interface StatusCounts {
  readonly pending: number;
  readonly processing: number;
  readonly completed: number;
  readonly rejected: number;
}

/**
 * Counts an account's orders of the merchant doors by status.
 *
 * Why: the portal dashboard counts what the merchant ordered through the portal and Dhru; an order the same account paid first in the shop is
 * not part of the portal's numbers (decision 064).
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns the four counts (zero for a status with no orders)
 */
export async function statusCountsOf(db: DbExecutor, accountId: number): Promise<StatusCounts> {
  const rows = await db
    .select({ status: orders.status, total: sql<number>`count(*)::int` })
    .from(orders)
    .where(merchantDoorSql(accountId))
    .groupBy(orders.status);
  const counts = { pending: 0, processing: 0, completed: 0, rejected: 0 };
  for (const row of rows) counts[row.status] = row.total;
  return counts;
}
