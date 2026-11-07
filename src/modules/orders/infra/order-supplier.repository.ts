// Drizzle queries of the supplier flows on `orders` (stage 6): the dispatch claim, the counts and spend the suppliers page shows, the
// usage a supplier delete checks, and the orders due for a status poll. The only file where the orders module reads `supplier_api_logs`.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Order, orders } from '../db/schema';

/** What the dispatch claim writes on the order. */
export interface DispatchClaim {
  readonly orderId: number;
  readonly supplierId: number;
  readonly supplierServiceId: number;
  /** The cost of one unit through the chosen link, 4 decimals. */
  readonly unitCost: string;
  readonly at: Date;
}

/**
 * Claims an order for one dispatch attempt.
 *
 * Why: decision 025 and orders-suppliers-11: the guarded `UPDATE ... WHERE dispatch_state = 'pending' AND sent_at IS NULL` runs
 * before the supplier call, so a second run of the job (a retry, a duplicate) finds the order claimed and never sends twice. It
 * also pins the supplier service the order goes to and refreshes the cost from it (`unit_cost`, `total_cost = unit_cost x quantity`).
 *
 * @param db the claim's transaction
 * @param claim the order, the chosen supplier service and the time
 * @returns the claimed order, or `undefined` when it was not claimable (not pending, already claimed, closed)
 */
export async function claimDispatch(db: DbExecutor, claim: DispatchClaim): Promise<Order | undefined> {
  const [row] = await db
    .update(orders)
    .set({
      supplierId: claim.supplierId,
      supplierServiceId: claim.supplierServiceId,
      unitCost: claim.unitCost,
      totalCost: sql`round(${claim.unitCost}::numeric * ${orders.quantity}, 4)`,
      sentAt: claim.at,
    })
    .where(
      and(
        eq(orders.id, claim.orderId),
        eq(orders.dispatchState, 'pending'),
        isNull(orders.sentAt),
        inArray(orders.status, ['pending', 'processing']),
      ),
    )
    .returning();
  return row;
}

/** Open and review order counts of a supplier. */
export interface SupplierOrderCounts {
  readonly open: number;
  readonly review: number;
}

/**
 * Counts the open orders of suppliers.
 *
 * Why: orders-suppliers-20: `openOrders` = open orders (`pending`, `processing`) of the supplier; `reviewOrders` = those whose
 * dispatch state is `needs_attention`.
 *
 * @param db the database or a transaction
 * @param supplierIds the suppliers
 * @returns the counts by supplier id (a supplier with no open order has no entry)
 */
export async function openOrderCounts(
  db: DbExecutor,
  supplierIds: readonly number[],
): Promise<Map<number, SupplierOrderCounts>> {
  const counts = new Map<number, SupplierOrderCounts>();
  if (supplierIds.length === 0) return counts;
  const rows = await db
    .select({
      supplierId: orders.supplierId,
      open: sql<number>`count(*)::int`,
      review: sql<number>`(count(*) filter (where ${orders.dispatchState} = 'needs_attention'))::int`,
    })
    .from(orders)
    .where(and(inArray(orders.supplierId, [...supplierIds]), inArray(orders.status, ['pending', 'processing'])))
    .groupBy(orders.supplierId);
  for (const row of rows)
    if (row.supplierId !== null) counts.set(row.supplierId, { open: row.open, review: row.review });
  return counts;
}

/**
 * Sums what suppliers cost on the orders completed since a time.
 *
 * Why: orders-suppliers-7: the 7-day spending rate behind `runwayDays` is the supplier cost (`total_cost`, USD) of the supplier's
 * completed orders with `completed_at` in the last seven days.
 *
 * @param db the database or a transaction
 * @param supplierIds the suppliers
 * @param since the start of the window
 * @returns the cost by supplier id, 4 decimals (a supplier with no completed order has no entry)
 */
export async function completedSpend(
  db: DbExecutor,
  supplierIds: readonly number[],
  since: Date,
): Promise<Map<number, string>> {
  const spend = new Map<number, string>();
  if (supplierIds.length === 0) return spend;
  const rows = await db
    .select({
      supplierId: orders.supplierId,
      total: sql<string>`coalesce(sum(${orders.totalCost}), 0)::numeric(18,4)::text`,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.supplierId, [...supplierIds]),
        eq(orders.status, 'completed'),
        sql`${orders.completedAt} >= ${since}`,
      ),
    )
    .groupBy(orders.supplierId);
  for (const row of rows) if (row.supplierId !== null) spend.set(row.supplierId, row.total);
  return spend;
}

/** How a supplier is used by orders. */
export interface SupplierOrderUsage {
  readonly total: number;
  readonly open: number;
}

/**
 * Counts the orders that reference a supplier.
 *
 * Why: orders-suppliers-8: a supplier any order references (open or closed) is not deleted: `409 SUPPLIER_IN_USE`.
 *
 * @param db the transaction of the delete
 * @param supplierId the supplier
 * @returns all orders and the open ones
 */
export async function supplierOrderUsage(db: DbExecutor, supplierId: number): Promise<SupplierOrderUsage> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`(count(*) filter (where ${orders.status} in ('pending', 'processing')))::int`,
    })
    .from(orders)
    .where(eq(orders.supplierId, supplierId));
  return { total: row?.total ?? 0, open: row?.open ?? 0 };
}

/** A sent order and when the supplier was last asked about it. */
export interface PollCandidate {
  readonly orderId: number;
  readonly sentAt: Date;
  readonly lastPolledAt: Date | null;
}

/**
 * Finds the sent orders whose status was not asked for the longest time.
 *
 * Why: scenario success step 8: sent orders are polled on a rhythm. The state is in Postgres (the order's `sent_at` and the
 * newest `getimeiorder` log row of the order), so a restart or a lost job loses nothing: the next tick finds the order again.
 * Candidates last asked at least a minute ago; the caller applies the rhythm of `pollIntervalMs` (suppliers module).
 *
 * @param db the database
 * @param now the clock's time
 * @param limit the most orders returned
 * @returns the candidates, the longest unasked first
 */
export async function pollCandidates(db: DbExecutor, now: Date, limit: number): Promise<PollCandidate[]> {
  // The log table is the suppliers module's: it is named in SQL text, the one place this module reads it. The outer id is written as
  // text too: in a select from one table Drizzle prints columns inside a selected `sql` without their table name, which would bind `id`
  // to the log table inside the subquery.
  const lastPolled = sql<Date | null>`(select max(l.created_at) from supplier_api_logs l where l.order_id = "orders"."id" and l.action = 'getimeiorder')`;
  const rows = await db
    .select({ orderId: orders.id, sentAt: orders.sentAt, placedAt: orders.placedAt, lastPolledAt: lastPolled })
    .from(orders)
    .where(
      and(
        inArray(orders.status, ['pending', 'processing']),
        eq(orders.dispatchState, 'sent'),
        sql`${orders.supplierRef} is not null`,
        sql`${orders.supplierId} is not null`,
        sql`coalesce(${lastPolled}, ${orders.sentAt}, ${orders.placedAt}) <= ${new Date(now.getTime() - 60_000)}`,
      ),
    )
    .orderBy(sql`coalesce(${lastPolled}, ${orders.sentAt}, ${orders.placedAt})`)
    .limit(limit);
  return rows.map((row) => ({
    orderId: row.orderId,
    sentAt: row.sentAt ?? row.placedAt,
    lastPolledAt: row.lastPolledAt === null ? null : new Date(row.lastPolledAt),
  }));
}
