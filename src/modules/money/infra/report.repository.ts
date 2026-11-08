// Drizzle queries of the five reports (stage 11, routes /admin/reports/*): profit from settled orders, wallet exposure from the ledger
// accounts, supplier spend and speed from orders and the supplier call log, top merchants from orders. Every query adds up in SQL;
// the money stays text until the service turns it into `Money`.
//
// DEVIATION to resolve later: decision 016 wants the reads of other modules' tables through the owning module's public service. orders,
// clients, services, suppliers and the supplier call log export no reader for these figures, so this file reads them with plain selects,
// like the other modules' foreign-read files. Nothing outside this file knows; the ledger accounts are the money module's own.
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { ledgerAccounts } from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';
import type { ProfitGroup } from '../domain/report-figures';

/** One group of settled orders with its sums, money as text. */
export interface ProfitSums {
  readonly key: string;
  readonly label: string;
  readonly orders: number;
  readonly revenue: string;
  readonly cost: string;
}

const REVENUE = (column: unknown) => sql<string>`coalesce(sum(${column}), 0)::numeric(18,4)::text`;

/**
 * Adds up completed orders by completion time, grouped by day, service, supplier or merchant.
 *
 * Why: `GET /admin/reports/profit`: revenue is the order's selling price without VAT, cost the supplier cost, both stored on the
 * order; only orders that are `completed` now count (a refunded or reopened order is not revenue), by the time they completed. A
 * storefront order has no merchant (key `0`, "Storefront customers") and an order no supplier executed has none (key `0`, "No supplier").
 *
 * @param db the database
 * @param groupBy what to split by
 * @param start the first instant of the first day (UTC)
 * @param end the first instant after the last day
 * @returns one entry per group, unordered
 */
export async function profitSums(db: DbExecutor, groupBy: ProfitGroup, start: Date, end: Date): Promise<ProfitSums[]> {
  const o = s.orders;
  const group = {
    day: {
      key: sql<string>`to_char(${o.completedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      label: sql<string>`to_char(${o.completedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
    },
    service: { key: sql<string>`${o.serviceId}::text`, label: sql<string>`${s.services.name}` },
    supplier: {
      key: sql<string>`coalesce(${o.supplierId}, 0)::text`,
      label: sql<string>`coalesce(${s.suppliers.name}, 'No supplier')`,
    },
    client: {
      key: sql<string>`coalesce(${o.clientId}, 0)::text`,
      label: sql<string>`coalesce(${s.clients.name}, 'Storefront customers')`,
    },
  }[groupBy];
  return db
    .select({
      key: group.key,
      label: group.label,
      orders: sql<number>`count(*)::int`,
      revenue: REVENUE(o.totalPrice),
      cost: REVENUE(o.totalCost),
    })
    .from(o)
    .innerJoin(s.services, eq(s.services.id, o.serviceId))
    .leftJoin(s.suppliers, eq(s.suppliers.id, o.supplierId))
    .leftJoin(s.clients, eq(s.clients.id, o.clientId))
    .where(and(eq(o.status, 'completed'), gte(o.completedAt, start), lt(o.completedAt, end)))
    .groupBy(sql`1`, sql`2`);
}

/** The wallet of one merchant in the exposure report, money as text. */
export interface WalletFigures {
  readonly clientId: number;
  readonly name: string;
  readonly balance: string;
  readonly reserved: string;
  readonly overdraftLimit: string;
}

/** The exposure report's totals over every merchant with a wallet, money as text. */
export interface ExposureTotals {
  readonly clients: number;
  readonly balance: string;
  readonly reserved: string;
  readonly overdraftLimit: string;
  readonly overdraftUsed: string;
  readonly inOverdraft: number;
}

const hold = alias(ledgerAccounts, 'merchant_hold');

/**
 * Adds up the merchants' wallets: balance, held for open orders, credit limit and credit in use.
 *
 * Why: `GET /admin/reports/wallet-exposure`: the balance is the `client_wallet` account (negative while credit is used), reserved is
 * the `client_hold` account, the limit is the wallet's `overdraft_limit`, credit in use is `max(0, -balance)`. The totals cover every
 * merchant that has a wallet, not only the rows that are listed.
 *
 * @param db the database
 * @returns the totals
 */
export async function exposureTotals(db: DbExecutor): Promise<ExposureTotals> {
  const wallet = ledgerAccounts;
  const [row] = await db
    .select({
      clients: sql<number>`count(*)::int`,
      balance: REVENUE(wallet.balance),
      reserved: REVENUE(hold.balance),
      overdraftLimit: REVENUE(wallet.overdraftLimit),
      overdraftUsed: sql<string>`coalesce(sum(greatest(-${wallet.balance}, 0)), 0)::numeric(18,4)::text`,
      inOverdraft: sql<number>`(count(*) filter (where ${wallet.balance} < 0))::int`,
    })
    .from(wallet)
    .leftJoin(
      hold,
      and(
        eq(hold.ownerType, 'client'),
        eq(hold.ownerId, wallet.ownerId),
        eq(hold.kind, 'client_hold'),
        eq(hold.currency, wallet.currency),
      ),
    )
    .where(and(eq(wallet.ownerType, 'client'), eq(wallet.kind, 'client_wallet'), eq(wallet.currency, BASE_CURRENCY)));
  return row!;
}

/**
 * Lists the largest merchant wallets, largest balance first.
 *
 * @param db the database
 * @param limit how many rows to return
 * @returns the wallets, ties by merchant id
 */
export async function largestWallets(db: DbExecutor, limit: number): Promise<WalletFigures[]> {
  const wallet = ledgerAccounts;
  const rows = await db
    .select({
      clientId: s.clients.id,
      name: s.clients.name,
      balance: wallet.balance,
      reserved: sql<string>`coalesce(${hold.balance}, 0)::numeric(18,4)::text`,
      overdraftLimit: wallet.overdraftLimit,
    })
    .from(wallet)
    .innerJoin(s.clients, eq(s.clients.id, wallet.ownerId))
    .leftJoin(
      hold,
      and(
        eq(hold.ownerType, 'client'),
        eq(hold.ownerId, wallet.ownerId),
        eq(hold.kind, 'client_hold'),
        eq(hold.currency, wallet.currency),
      ),
    )
    .where(and(eq(wallet.ownerType, 'client'), eq(wallet.kind, 'client_wallet'), eq(wallet.currency, BASE_CURRENCY)))
    .orderBy(desc(wallet.balance), asc(s.clients.id))
    .limit(limit);
  return rows;
}

/** What the orders of one supplier say over a window, money as text. */
export interface SupplierOrderFigures {
  readonly supplierId: number;
  readonly supplierName: string;
  readonly orders: number;
  readonly completed: number;
  readonly rejected: number;
  readonly spend: string;
  /** The mean seconds from sending (or creating) to completing, or `null` when none completed. */
  readonly averageSeconds: number | null;
}

/**
 * Adds up the orders of every supplier created since a moment, suppliers without orders included.
 *
 * Why: `GET /admin/reports/suppliers`: orders with that supplier created in the window; spend is the supplier cost of the completed ones;
 * speed is the mean of `completed_at - coalesce(sent_at, created_at)` over the completed ones.
 *
 * @param db the database
 * @param since the start of the window
 * @returns one entry per supplier, by supplier id
 */
export async function supplierOrderFigures(db: DbExecutor, since: Date): Promise<SupplierOrderFigures[]> {
  const o = s.orders;
  const rows = await db
    .select({
      supplierId: s.suppliers.id,
      supplierName: s.suppliers.name,
      orders: sql<number>`count(${o.id})::int`,
      completed: sql<number>`(count(${o.id}) filter (where ${o.status} = 'completed'))::int`,
      rejected: sql<number>`(count(${o.id}) filter (where ${o.status} = 'rejected'))::int`,
      spend: sql<string>`coalesce(sum(${o.totalCost}) filter (where ${o.status} = 'completed'), 0)::numeric(18,4)::text`,
      averageSeconds: sql<
        string | null
      >`avg(extract(epoch from (${o.completedAt} - coalesce(${o.sentAt}, ${o.createdAt})))) filter (where ${o.status} = 'completed' and ${o.completedAt} is not null)`,
    })
    .from(s.suppliers)
    .leftJoin(o, and(eq(o.supplierId, s.suppliers.id), gte(o.createdAt, since)))
    .groupBy(s.suppliers.id, s.suppliers.name)
    .orderBy(asc(s.suppliers.id));
  return rows.map((row) => ({
    ...row,
    averageSeconds: row.averageSeconds === null ? null : Number(row.averageSeconds),
  }));
}

/** What the call log says about one supplier over a window. */
export interface SupplierCallFigures {
  readonly calls: number;
  readonly errorCalls: number;
  readonly timeoutCalls: number;
}

/**
 * Counts the supplier calls of each supplier since a moment by outcome.
 *
 * Why: feature 6 logs every call with an outcome (`ok`, `error`, `timeout`); the supplier report adds them as extra figures next to
 * the order figures, so a supplier that fails calls without rejecting orders shows.
 *
 * @param db the database
 * @param since the start of the window
 * @returns the counts by supplier id (a supplier with no call has no entry)
 */
export async function supplierCallFigures(db: DbExecutor, since: Date): Promise<Map<number, SupplierCallFigures>> {
  const log = s.supplierApiLogs;
  const rows = await db
    .select({
      supplierId: log.supplierId,
      calls: sql<number>`count(*)::int`,
      errorCalls: sql<number>`(count(*) filter (where ${log.outcome} = 'error'))::int`,
      timeoutCalls: sql<number>`(count(*) filter (where ${log.outcome} = 'timeout'))::int`,
    })
    .from(log)
    .where(gte(log.createdAt, since))
    .groupBy(log.supplierId);
  return new Map(rows.map(({ supplierId, ...figures }) => [supplierId, figures]));
}

/** One merchant of the top list, money as text. */
export interface TopClientFigures {
  readonly id: number;
  readonly name: string;
  readonly country: string;
  readonly orders: number;
  readonly spend: string;
  readonly profit: string;
}

/**
 * Ranks the merchants that ordered since a moment by what they spent.
 *
 * Why: `GET /admin/reports/top-clients` (MISMATCHES B88): orders created in the window (every status); spend is the price of the
 * non-rejected ones; profit is price minus cost of the completed ones; merchants waiting for approval are left out, and so are
 * merchants with no order in the window. Highest spend first, ties by merchant id.
 *
 * @param db the database
 * @param since the start of the window
 * @param limit how many merchants to return
 * @returns the ranked merchants
 */
export async function topClientFigures(db: DbExecutor, since: Date, limit: number): Promise<TopClientFigures[]> {
  const o = s.orders;
  const spend = sql`coalesce(sum(${o.totalPrice}) filter (where ${o.status} <> 'rejected'), 0)`;
  return db
    .select({
      id: s.clients.id,
      name: s.clients.name,
      country: s.clients.country,
      orders: sql<number>`count(${o.id})::int`,
      spend: sql<string>`${spend}::numeric(18,4)::text`,
      profit: sql<string>`coalesce(sum(${o.totalPrice} - ${o.totalCost}) filter (where ${o.status} = 'completed'), 0)::numeric(18,4)::text`,
    })
    .from(o)
    .innerJoin(s.clients, eq(s.clients.id, o.clientId))
    .where(and(gte(o.createdAt, since), ne(s.clients.status, 'pending')))
    .groupBy(s.clients.id, s.clients.name, s.clients.country)
    .orderBy(desc(spend), asc(s.clients.id))
    .limit(limit);
}

/**
 * Reads the wallet balances of some merchants.
 *
 * @param db the database
 * @param clientIds the merchants
 * @returns the `client_wallet` balance by merchant id, as text; a merchant without a wallet has no entry
 */
export async function walletBalances(db: DbExecutor, clientIds: readonly number[]): Promise<Map<number, string>> {
  if (clientIds.length === 0) return new Map();
  const wallet = ledgerAccounts;
  const rows = await db
    .select({ clientId: wallet.ownerId, balance: wallet.balance })
    .from(wallet)
    .where(
      and(
        eq(wallet.ownerType, 'client'),
        eq(wallet.kind, 'client_wallet'),
        eq(wallet.currency, BASE_CURRENCY),
        inArray(wallet.ownerId, [...clientIds]),
      ),
    );
  return new Map(rows.flatMap((row) => (row.clientId === null ? [] : [[row.clientId, row.balance] as const])));
}
