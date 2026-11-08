// Read-only lookups into tables other modules own (merchants and orders), kept in this one file: the names and referrers of
// merchants, the merchant behind an order, who a merchant referred and what the referred merchants sold.
//
// DEVIATION to resolve later: decision 016 wants these reads through the owning module's public service. identity and orders export
// no directory for them, so this file reads `clients` and `orders` with plain selects, like the other modules' foreign-read files.
// Nothing outside this file knows; replace the bodies with calls to those services once they exist.
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/** A merchant as the commission screens need it. */
export interface MerchantRef {
  readonly id: number;
  readonly name: string;
  readonly country: string;
  readonly referredById: number | null;
}

/**
 * Finds merchants by id.
 *
 * @param db the database or a transaction
 * @param ids the merchant ids
 * @returns the merchants by id; an unknown id has no entry
 */
export async function findMerchants(db: DbExecutor, ids: readonly number[]): Promise<Map<number, MerchantRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: s.clients.id,
      name: s.clients.name,
      country: s.clients.country,
      referredById: s.clients.referredById,
    })
    .from(s.clients)
    .where(inArray(s.clients.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Finds the merchant behind each order.
 *
 * Why: an accrual's `merchant` is the order's client (the referred merchant, or the agent itself for a rebate), and the accrual
 * table only keeps the order id.
 *
 * @param db the database or a transaction
 * @param orderIds the order ids
 * @returns the merchant's id and name by order id; a storefront order has no entry
 */
export async function merchantsOfOrders(
  db: DbExecutor,
  orderIds: readonly number[],
): Promise<Map<number, { id: number; name: string }>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({ orderId: s.orders.id, id: s.clients.id, name: s.clients.name })
    .from(s.orders)
    .innerJoin(s.clients, eq(s.clients.id, s.orders.clientId))
    .where(inArray(s.orders.id, [...orderIds]));
  return new Map(rows.map((row) => [row.orderId, { id: row.id, name: row.name }]));
}

/**
 * Counts how many merchants each agent referred.
 *
 * @param db the database or a transaction
 * @param agentIds the agents
 * @returns the count by agent id; an agent that referred nobody has no entry
 */
export async function referredCounts(db: DbExecutor, agentIds: readonly number[]): Promise<Map<number, number>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select({ agentId: s.clients.referredById, total: sql<number>`count(*)::int` })
    .from(s.clients)
    .where(inArray(s.clients.referredById, [...agentIds]))
    .groupBy(s.clients.referredById);
  return new Map(rows.flatMap((row) => (row.agentId === null ? [] : [[row.agentId, row.total] as const])));
}

/**
 * Adds up the revenue the referred merchants of each agent completed since a moment.
 *
 * Why: M155 and the demo's agents table ("Their revenue, 30 d"): the completed merchant orders of the merchants an agent referred.
 *
 * @param db the database or a transaction
 * @param agentIds the agents
 * @param since the start of the window (30 days before the clock's time)
 * @returns the revenue by agent id as a 4-decimal string; an agent with none has no entry
 */
export async function referredRevenueSince(
  db: DbExecutor,
  agentIds: readonly number[],
  since: Date,
): Promise<Map<number, string>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select({
      agentId: s.clients.referredById,
      revenue: sql<string>`coalesce(sum(${s.orders.totalPrice}), 0)::numeric(18,4)::text`,
    })
    .from(s.orders)
    .innerJoin(s.clients, eq(s.clients.id, s.orders.clientId))
    .where(
      and(
        inArray(s.clients.referredById, [...agentIds]),
        eq(s.orders.status, 'completed'),
        gte(s.orders.completedAt, since),
      ),
    )
    .groupBy(s.clients.referredById);
  return new Map(rows.flatMap((row) => (row.agentId === null ? [] : [[row.agentId, row.revenue] as const])));
}

/** What the referral page shows of a merchant's own record. */
export interface ReferralSource {
  readonly name: string;
  readonly referralCode: string;
}

/**
 * Finds a merchant's name and referral code.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @returns the name and the code, or `undefined` when the merchant is gone
 */
export async function referralSourceOf(db: DbExecutor, clientId: number): Promise<ReferralSource | undefined> {
  const [row] = await db
    .select({ name: s.clients.name, referralCode: s.clients.referralCode })
    .from(s.clients)
    .where(eq(s.clients.id, clientId))
    .limit(1);
  return row;
}

/** A merchant an agent referred: only what the agent may see (a name and a date, never an id). */
export interface ReferredMerchant {
  readonly name: string;
  readonly joinedAt: Date;
}

/**
 * Lists the merchants an agent referred, newest first.
 *
 * Why: B164: the merchant portal shows the names and join dates of the merchants that signed up with the agent's code.
 *
 * @param db the database or a transaction
 * @param agentId the referring merchant
 * @param limit the most rows to return
 * @returns the page of referred merchants and how many there are in all
 */
export async function referredMerchantsOf(
  db: DbExecutor,
  agentId: number,
  limit: number,
): Promise<{ rows: ReferredMerchant[]; total: number }> {
  const [rows, [count]] = await Promise.all([
    db
      .select({ name: s.clients.name, joinedAt: s.clients.createdAt })
      .from(s.clients)
      .where(eq(s.clients.referredById, agentId))
      .orderBy(desc(s.clients.createdAt), desc(s.clients.id))
      .limit(limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(s.clients)
      .where(eq(s.clients.referredById, agentId)),
  ]);
  return { rows, total: count?.total ?? 0 };
}
