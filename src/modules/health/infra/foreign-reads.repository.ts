// Read-only lookups into tables other modules own, kept in this one file: the suppliers, their call log, the payment gateways, the
// orders (age, queue, outcome), webhook deliveries and the outbox that the System health routes summarise.
//
// DEVIATION to resolve when those modules export readers: decision 016 wants these reads through the owning module's public
// service. Suppliers export the health rules (pure) but no reader of the call log, orders export only the SQL fragments, and
// webhook deliveries, the outbox backlog by type and the gateways export nothing, so this file reads `suppliers`,
// `supplier_api_logs`, `payment_gateways`, `orders`, `services`, `webhook_deliveries` and `outbox_events` with plain selects, like
// the suppliers module's own `foreign-reads.repository.ts`. The orders reads use feature 5's exported `pastSlaPredicate` and
// `queueSql`, so the age-only past-SLA rule (B92) stays in one place. Replace the bodies when readers exist; nothing outside this
// file knows.
import { and, eq, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { orders } from './sibling-modules';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A supplier as the health views need it. */
export interface HealthSupplier {
  readonly id: number;
  readonly name: string;
  readonly status: 'active' | 'disabled' | 'paused';
  readonly currency: string;
  readonly balance: string;
  /** USD per supplier credit: the runway compares the balance in USD with the USD spend. */
  readonly creditRate: string;
  readonly lowBalanceAlert: string;
  readonly balanceCheckedAt: Date | null;
  readonly pricesSyncedAt: Date | null;
}

/**
 * Lists every supplier, disabled ones included, by id.
 *
 * @param db the database
 * @returns the suppliers
 */
export async function suppliersForHealth(db: DbExecutor): Promise<HealthSupplier[]> {
  return db
    .select({
      id: s.suppliers.id,
      name: s.suppliers.name,
      status: s.suppliers.status,
      currency: s.suppliers.currency,
      balance: s.suppliers.balance,
      creditRate: s.suppliers.creditRate,
      lowBalanceAlert: s.suppliers.lowBalanceAlert,
      balanceCheckedAt: s.suppliers.balanceCheckedAt,
      pricesSyncedAt: s.suppliers.pricesSyncedAt,
    })
    .from(s.suppliers)
    .orderBy(s.suppliers.id);
}

/**
 * Lists the payment gateways (id and name) for the health components.
 *
 * @param db the database
 * @returns the gateways by id
 */
export async function gatewaysForHealth(db: DbExecutor): Promise<Array<{ id: number; name: string }>> {
  return db
    .select({ id: s.paymentGateways.id, name: s.paymentGateways.name })
    .from(s.paymentGateways)
    .orderBy(s.paymentGateways.id);
}

/** Calls of one supplier in a window, counted by outcome (`supplier_api_logs.outcome`, resolution health-commissions-8). */
export interface SupplierCalls {
  readonly total: number;
  readonly errors: number;
  readonly timeouts: number;
  readonly p50Ms: number | null;
}

/**
 * Counts the calls of suppliers since a time, by outcome.
 *
 * @param db the database
 * @param since the start of the window
 * @returns the counts by supplier id (a supplier with no call has no entry)
 */
export async function supplierCalls(db: DbExecutor, since: Date): Promise<Map<number, SupplierCalls>> {
  const log = s.supplierApiLogs;
  const rows = await db
    .select({
      supplierId: log.supplierId,
      total: sql<number>`count(*)::int`,
      errors: sql<number>`(count(*) filter (where ${log.outcome} = 'error'))::int`,
      timeouts: sql<number>`(count(*) filter (where ${log.outcome} = 'timeout'))::int`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${log.durationMs})`,
    })
    .from(log)
    .where(sql`${log.createdAt} >= ${since}`)
    .groupBy(log.supplierId);
  return new Map(
    rows.map((row) => [
      row.supplierId,
      {
        total: row.total,
        errors: row.errors,
        timeouts: row.timeouts,
        p50Ms: row.p50 === null ? null : Math.round(Number(row.p50)),
      },
    ]),
  );
}

/**
 * The time of each supplier's latest call that worked.
 *
 * @param db the database
 * @returns the latest `ok` call by supplier id
 */
export async function lastOkCalls(db: DbExecutor): Promise<Map<number, Date>> {
  const log = s.supplierApiLogs;
  const rows = await db
    .select({ supplierId: log.supplierId, at: sql<Date>`max(${log.createdAt})` })
    .from(log)
    .where(eq(log.outcome, 'ok'))
    .groupBy(log.supplierId);
  return new Map(rows.map((row) => [row.supplierId, new Date(row.at)]));
}

/**
 * What each supplier cost on the orders completed since a time.
 *
 * Why: orders-suppliers-7: the 7-day spending rate behind `runwayDays` is the supplier cost (`total_cost`, USD) of the supplier's
 * completed orders with `completed_at` in the window, the same sum the suppliers page uses, so the two pages judge a low balance alike.
 *
 * @param db the database
 * @param since the start of the window
 * @returns the cost in USD, 4 decimals, by supplier id (a supplier with no completed order has no entry)
 */
export async function completedSpendBySupplier(db: DbExecutor, since: Date): Promise<Map<number, string>> {
  const o = s.orders;
  const rows = await db
    .select({
      supplierId: o.supplierId,
      total: sql<string>`coalesce(sum(${o.totalCost}), 0)::numeric(18,4)::text`,
    })
    .from(o)
    .where(sql`${o.supplierId} is not null and ${o.status} = 'completed' and ${o.completedAt} >= ${since}`)
    .groupBy(o.supplierId);
  return new Map(rows.flatMap((row) => (row.supplierId === null ? [] : [[row.supplierId, row.total] as const])));
}

/** Past-SLA orders of one status bucket. */
export interface StuckRow {
  readonly status: 'pending' | 'processing' | 'needs_attention';
  readonly count: number;
  readonly oldestPlacedAt: Date | null;
  readonly held: string;
}

/**
 * Orders past their SLA, by the status bucket the console links to.
 *
 * Why: orders-suppliers-1 / B92: the one age-only predicate (`pastSlaPredicate`); an order in the `needs_attention` queue is
 * counted there and not again under `pending` or `processing`. Held money is the hold of a merchant order (its total) or the
 * captured payment of a paid storefront order (total plus VAT).
 *
 * @param db the database
 * @param now the clock's time
 * @returns one row per status bucket that has orders
 */
export async function stuckOrders(db: DbExecutor, now: Date): Promise<StuckRow[]> {
  const { pastSlaPredicate } = await orders();
  const o = s.orders;
  const bucket = sql<
    StuckRow['status']
  >`(case when ${o.dispatchState} = 'needs_attention' then 'needs_attention' else ${o.status} end)`;
  const rows = await db
    .select({
      status: bucket,
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${o.placedAt})`,
      held: sql<string>`coalesce(sum(${o.totalPrice} + (case when ${o.clientId} is null then ${o.taxAmount} else 0 end)), 0)::numeric(20,4)::text`,
    })
    .from(o)
    .innerJoin(s.services, eq(s.services.id, o.serviceId))
    .where(pastSlaPredicate(now))
    .groupBy(bucket);
  return rows.map((row) => ({
    status: row.status,
    count: row.count,
    oldestPlacedAt: row.oldest === null ? null : new Date(row.oldest),
    held: row.held,
  }));
}

/**
 * How many orders were past their SLA at each of some moments.
 *
 * Why: the orders tab's 24-hour trend. No status history is kept, so an order counts as open at a moment when it was placed
 * before it and not finished by then (a finished order ends at `completed_at`, or its last update when it has none).
 *
 * @param db the database
 * @param points the moments, oldest first (15 minutes apart)
 * @returns the count at each moment
 */
export async function stuckTrend(db: DbExecutor, points: readonly Date[]): Promise<number[]> {
  if (points.length === 0) return [];
  const first = points[0] as Date;
  const last = points[points.length - 1] as Date;
  const o = s.orders;
  const closedAt = sql`(case when ${o.status} in ('completed', 'rejected') then coalesce(${o.completedAt}, ${o.updatedAt}) else null end)`;
  const result = await db.execute<{ t: Date; n: number }>(sql`
    select g.t as t, count(o.id)::int as n
    from generate_series(${first.toISOString()}::timestamptz, ${last.toISOString()}::timestamptz, interval '15 minutes') as g(t)
    left join lateral (
      select orders.id from orders
      join services on services.id = orders.service_id
      where orders.placed_at >= ${new Date(first.getTime() - 30 * DAY_MS).toISOString()}::timestamptz
        and services.sla_minutes > 0
        and orders.placed_at < g.t - make_interval(mins => services.sla_minutes)
        and (${closedAt} is null or ${closedAt} > g.t)
    ) o on true
    group by g.t order by g.t`);
  const counts = new Map(result.rows.map((row) => [new Date(row.t).getTime(), row.n]));
  return points.map((point) => counts.get(point.getTime()) ?? 0);
}

/**
 * The 95th percentile of the time from placement to the supplier call, over 24 hours.
 *
 * @param db the database
 * @param now the clock's time
 * @returns seconds, or `null` when no order was sent in the window
 */
export async function dispatchP95Seconds(db: DbExecutor, now: Date): Promise<number | null> {
  const o = s.orders;
  const [row] = await db
    .select({
      p95: sql<
        number | null
      >`percentile_cont(0.95) within group (order by extract(epoch from (${o.sentAt} - ${o.placedAt})))`,
    })
    .from(o)
    .where(sql`${o.sentAt} is not null and ${o.sentAt} >= ${new Date(now.getTime() - DAY_MS)}`);
  return row?.p95 === null || row?.p95 === undefined ? null : Number(row.p95);
}

/** Finished orders of one service type in the last 24 hours. */
export interface TypeOutcome {
  readonly type: string;
  readonly completed: number;
  readonly rejected: number;
}

/**
 * Finished orders by service type over the last 24 hours.
 *
 * @param db the database
 * @param now the clock's time
 * @returns completed and rejected counts per type that has any
 */
export async function typeOutcomes(db: DbExecutor, now: Date): Promise<TypeOutcome[]> {
  const o = s.orders;
  const finishedAt = sql`coalesce(${o.completedAt}, ${o.updatedAt})`;
  return db
    .select({
      type: o.type,
      completed: sql<number>`(count(*) filter (where ${o.status} = 'completed'))::int`,
      rejected: sql<number>`(count(*) filter (where ${o.status} = 'rejected'))::int`,
    })
    .from(o)
    .where(sql`${o.status} in ('completed', 'rejected') and ${finishedAt} >= ${new Date(now.getTime() - DAY_MS)}`)
    .groupBy(o.type);
}

/**
 * Orders in the needs-attention queue and paid storefront orders the risk rules hold.
 *
 * @param db the database
 * @returns the counts, the held amount (VAT included, as captured) and the oldest held order
 */
export async function attentionAndHeld(db: DbExecutor): Promise<{
  needsAttention: number;
  heldCount: number;
  heldAmount: string;
  heldOldest: Date | null;
}> {
  const { queueSql } = await orders();
  const o = s.orders;
  const [row] = await db
    .select({
      needsAttention: sql<number>`(count(*) filter (where ${queueSql} = 'needs_attention'))::int`,
      heldCount: sql<number>`(count(*) filter (where ${o.clientId} is null and ${o.dispatchState} = 'held'))::int`,
      heldAmount: sql<string>`coalesce(sum(${o.totalPrice} + ${o.taxAmount}) filter (where ${o.clientId} is null and ${o.dispatchState} = 'held'), 0)::numeric(20,4)::text`,
      heldOldest: sql<Date | null>`min(${o.placedAt}) filter (where ${o.clientId} is null and ${o.dispatchState} = 'held')`,
    })
    .from(o)
    .where(sql`${o.status} in ('pending', 'processing')`);
  return {
    needsAttention: row?.needsAttention ?? 0,
    heldCount: row?.heldCount ?? 0,
    heldAmount: row?.heldAmount ?? '0.0000',
    heldOldest: row?.heldOldest ? new Date(row.heldOldest) : null,
  };
}

/** Outgoing webhook deliveries of the last 24 hours. */
export interface OutgoingWebhooks {
  readonly delivered: number;
  readonly failed: number;
  readonly retrying: number;
  readonly oldestUndelivered: Date | null;
}

/**
 * Summarises the deliveries to merchants.
 *
 * @param db the database
 * @param now the clock's time
 * @returns delivered, failed (gave up) and retrying counts of the last 24 hours, and the oldest delivery still pending
 */
export async function outgoingWebhooks(db: DbExecutor, now: Date): Promise<OutgoingWebhooks> {
  const d = s.webhookDeliveries;
  const [row] = await db
    .select({
      delivered: sql<number>`(count(*) filter (where ${d.status} = 'delivered' and ${d.createdAt} >= ${new Date(now.getTime() - DAY_MS)}))::int`,
      failed: sql<number>`(count(*) filter (where ${d.status} = 'failed' and ${d.createdAt} >= ${new Date(now.getTime() - DAY_MS)}))::int`,
      retrying: sql<number>`(count(*) filter (where ${d.status} = 'pending' and ${d.nextRetryAt} is not null))::int`,
      oldest: sql<Date | null>`min(${d.createdAt}) filter (where ${d.status} = 'pending')`,
    })
    .from(d);
  return {
    delivered: row?.delivered ?? 0,
    failed: row?.failed ?? 0,
    retrying: row?.retrying ?? 0,
    oldestUndelivered: row?.oldest ? new Date(row.oldest) : null,
  };
}

/**
 * The oldest outbox event written by a gateway callback that is not relayed yet.
 *
 * Why: B97: the incoming side's "oldest unprocessed" figure is the oldest `outbox_events` row of the `payment` or `dispute`
 * aggregate.
 *
 * @param db the database
 * @returns the time it was written, or `null`
 */
export async function oldestIncomingEvent(db: DbExecutor): Promise<Date | null> {
  const e = s.outboxEvents;
  const [row] = await db
    .select({ at: sql<Date | null>`min(${e.createdAt})` })
    .from(e)
    .where(and(sql`${e.processedAt} is null`, sql`${e.aggregateType} in ('payment', 'dispute')`));
  return row?.at ? new Date(row.at) : null;
}

/**
 * Outgoing webhook deliveries that ended, since a time.
 *
 * Why: the `webhooks.success_rate` alert metric: delivered / (delivered + failed) over the rule's window, by the time a delivery was queued
 * (the same basis as {@link outgoingWebhooks}).
 *
 * @param db the database
 * @param since the start of the window
 * @returns how many deliveries were delivered and how many gave up
 */
export async function webhookOutcomes(db: DbExecutor, since: Date): Promise<{ delivered: number; failed: number }> {
  const d = s.webhookDeliveries;
  const [row] = await db
    .select({
      delivered: sql<number>`(count(*) filter (where ${d.status} = 'delivered'))::int`,
      failed: sql<number>`(count(*) filter (where ${d.status} = 'failed'))::int`,
    })
    .from(d)
    .where(sql`${d.createdAt} >= ${since}`);
  return { delivered: row?.delivered ?? 0, failed: row?.failed ?? 0 };
}
