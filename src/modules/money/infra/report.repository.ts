// Drizzle queries of the five reports (stage 11, routes /admin/reports/*): profit from settled orders, wallet exposure from the ledger
// accounts (merchant wallets and store balances), supplier spend and speed from orders and the supplier call log, top accounts from orders.
// Every query adds up in SQL; the money stays text until the service turns it into `Money`.
//
// DEVIATION to resolve later: decision 016 wants the reads of other modules' tables through the owning module's public service. orders,
// clients, client_groups, services, suppliers and the supplier call log export no reader for these figures, so this file reads them with
// plain selects, like the other modules' foreign-read files. Nothing outside this file knows; the ledger accounts are the money module's own.
//
// The door of an order is `orders.source` (decision 064): `store` is the prepaid door of the shop, every other value a merchant door. The
// orders module's `prepaidOrderSql` says the same; money does not import the orders barrel (orders imports money: a load cycle, decision
// 032), so the one comparison is written here. No reader infers the kind of buyer from a null column.
import { type SQL, and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { ledgerAccounts } from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';
import type { ProfitGroup, TopScope, WalletBalances } from '../domain/report-figures';

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
 * What the books took back of a storefront order's sale, as a correlated subquery over the order id the SQL passes in: the signed
 * `revenue` lines of the order's refund journals (a refund of the delivered order adds its net, the reversal of such a refund takes it
 * off again) and the signed `customer_funds` and `chargeback_loss` lines of the chargeback journals of disputes on the order's own
 * payment, the one with the order's receipt (what the chargeback booked, the dispute fee included). The `customer_funds` lines of a
 * refund journal are left out: they return money that never became revenue (a second payment of a checkout already paid, refunded in
 * full, or a refund before delivery), so they take nothing off the sale. For the same reason a chargeback of such a second payment (it
 * is recorded without a receipt) takes nothing off the sale either, although its journal carries the order as reference.
 */
const takenBack = (orderId: unknown): SQL => sql`(
  select coalesce(sum(le.amount), 0) from ledger_transactions lt
  join ledger_entries le on le.transaction_id = lt.id
  join ledger_accounts la on la.id = le.account_id
  where lt.ref_type = 'order' and lt.ref_id = ${orderId}
    and ((lt.kind = 'refund' and la.kind = 'revenue')
      or (lt.kind = 'chargeback' and la.kind in ('customer_funds', 'chargeback_loss')
        and exists (select 1 from disputes d
          join payments p on p.id = d.payment_id
          join invoices i on i.id = p.invoice_id and i.kind = 'receipt' and i.order_id = lt.ref_id
          where d.ledger_tx_id = lt.id))))`;

/**
 * Adds up completed orders by completion time, grouped by day, service, supplier or merchant.
 *
 * Why: `GET /admin/reports/profit`: revenue is the order's selling price without VAT, cost the supplier cost, both stored on the
 * order; only orders that are `completed` now count (a refunded or reopened order is not revenue), by the time they completed. A
 * delivered storefront order (the `store` door) stays `completed` when it is refunded or charged back, so its revenue is the price less
 * what the books took back of it ({@link takenBack}), never below zero; the supplier cost stays. A storefront order belongs to no merchant
 * door (key `0`, "Storefront customers"; the merchant split names the buyer's account of every other door) and an order no supplier
 * executed has none (key `0`, "No supplier").
 *
 * @param db the database
 * @param groupBy what to split by
 * @param start the first instant of the first day (UTC)
 * @param end the first instant after the last day
 * @returns one entry per group, unordered
 */
export async function profitSums(db: DbExecutor, groupBy: ProfitGroup, start: Date, end: Date): Promise<ProfitSums[]> {
  const o = s.orders;
  const storeDoor = eq(o.source, 'store');
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
      key: sql<string>`(case when ${storeDoor} then 0 else ${o.accountId} end)::text`,
      label: sql<string>`(case when ${storeDoor} then 'Storefront customers' else ${s.clients.name} end)`,
    },
  }[groupBy];
  return db
    .select({
      key: group.key,
      label: group.label,
      orders: sql<number>`count(*)::int`,
      revenue: REVENUE(
        sql`case when ${storeDoor} then greatest(${o.totalPrice} - ${takenBack(o.id)}, 0) else ${o.totalPrice} end`,
      ),
      cost: REVENUE(o.totalCost),
    })
    .from(o)
    .innerJoin(s.services, eq(s.services.id, o.serviceId))
    .leftJoin(s.suppliers, eq(s.suppliers.id, o.supplierId))
    .leftJoin(s.clients, eq(s.clients.id, o.accountId))
    .where(and(eq(o.status, 'completed'), gte(o.completedAt, start), lt(o.completedAt, end)))
    .groupBy(sql`1`, sql`2`);
}

/** The wallet of one merchant in the exposure report, money as text (`clientId` is the account id). */
export interface WalletFigures {
  readonly clientId: number;
  readonly name: string;
  readonly balance: string;
  readonly reserved: string;
  readonly overdraftLimit: string;
}

/** The exposure report's totals over every merchant-rank account with a wallet, money as text. */
export interface ExposureTotals {
  readonly clients: number;
  readonly balance: string;
  readonly reserved: string;
  readonly overdraftLimit: string;
  readonly overdraftUsed: string;
  readonly inOverdraft: number;
}

/** The store balances of the exposure report: the live wallets of retail-rank accounts, money as text. */
export interface StoreBalanceFigures {
  /** How many store balances exist (one per retail-rank account that has one). */
  readonly accounts: number;
  readonly balance: string;
  /** How many are below zero (only a chargeback clawback can take one there). */
  readonly negative: number;
  /** How many staff or a dispute keep on hold. */
  readonly frozen: number;
}

const hold = alias(ledgerAccounts, 'merchant_hold');

/** The stored group kind that gives merchant rights; `rankKindOf` of the identity module reads the same word, and every other kind is retail. */
const MERCHANT_GROUP_KIND = 'b2b';

/**
 * Adds up the merchants' wallets: balance, held for open orders, credit limit and credit in use.
 *
 * Why: `GET /admin/reports/wallet-exposure`: the balance is the `client_wallet` account of an account with a merchant rank (negative
 * while credit is used), reserved is its `client_hold` account, the limit is the wallet's `overdraft_limit`, credit in use is
 * `max(0, -balance)`. The merchant wallet of an account that moved to a retail rank is the inactive kind (it holds zero after a rank change) and is not
 * counted. The totals cover every such wallet, not only the rows that are listed.
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
    .innerJoin(s.clients, eq(s.clients.id, wallet.ownerId))
    .innerJoin(
      s.clientGroups,
      and(eq(s.clientGroups.id, s.clients.groupId), eq(s.clientGroups.kind, MERCHANT_GROUP_KIND)),
    )
    .leftJoin(
      hold,
      and(
        eq(hold.ownerType, 'account'),
        eq(hold.ownerId, wallet.ownerId),
        eq(hold.kind, 'client_hold'),
        eq(hold.currency, wallet.currency),
      ),
    )
    .where(and(eq(wallet.ownerType, 'account'), eq(wallet.kind, 'client_wallet'), eq(wallet.currency, BASE_CURRENCY)));
  return row!;
}

/**
 * Adds up the store balances: how many there are, what they hold, how many are below zero and how many are on hold.
 *
 * Why: `GET /admin/reports/wallet-exposure` answers `storeBalances` beside `totals` (the console reads it so): the `customer_wallet`
 * accounts of accounts whose rank is not a merchant rank, in the base currency. The merchant figures never include them, so a store
 * balance (money owed to retail buyers, never credit) is not mixed with a merchant's credit exposure.
 *
 * @param db the database
 * @returns the totals; all zero when no store balance exists
 */
export async function storeBalanceTotals(db: DbExecutor): Promise<StoreBalanceFigures> {
  const wallet = ledgerAccounts;
  const [row] = await db
    .select({
      accounts: sql<number>`count(*)::int`,
      balance: REVENUE(wallet.balance),
      negative: sql<number>`(count(*) filter (where ${wallet.balance} < 0))::int`,
      frozen: sql<number>`(count(*) filter (where ${wallet.frozenAt} is not null))::int`,
    })
    .from(wallet)
    .innerJoin(s.clients, eq(s.clients.id, wallet.ownerId))
    .innerJoin(
      s.clientGroups,
      and(eq(s.clientGroups.id, s.clients.groupId), ne(s.clientGroups.kind, MERCHANT_GROUP_KIND)),
    )
    .where(
      and(eq(wallet.ownerType, 'account'), eq(wallet.kind, 'customer_wallet'), eq(wallet.currency, BASE_CURRENCY)),
    );
  return row!;
}

/**
 * Lists the largest merchant wallets, largest balance first.
 *
 * @param db the database
 * @param limit how many rows to return
 * @returns the wallets (merchant-rank accounts only), ties by account id
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
    .innerJoin(
      s.clientGroups,
      and(eq(s.clientGroups.id, s.clients.groupId), eq(s.clientGroups.kind, MERCHANT_GROUP_KIND)),
    )
    .leftJoin(
      hold,
      and(
        eq(hold.ownerType, 'account'),
        eq(hold.ownerId, wallet.ownerId),
        eq(hold.kind, 'client_hold'),
        eq(hold.currency, wallet.currency),
      ),
    )
    .where(and(eq(wallet.ownerType, 'account'), eq(wallet.kind, 'client_wallet'), eq(wallet.currency, BASE_CURRENCY)))
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

/** One account of the top list, money as text; the rank is as stored, the service turns its kind into the wire word. */
export interface TopAccountFigures {
  readonly id: number;
  readonly name: string;
  readonly country: string;
  readonly rankId: number;
  readonly rankName: string;
  /** The stored `client_groups.kind` of the account's rank. */
  readonly rankGroupKind: string;
  /** False for a guest row (it has no login and no wallet). */
  readonly hasAccount: boolean;
  readonly orders: number;
  readonly spend: string;
  readonly profit: string;
}

/**
 * Ranks the accounts that ordered since a moment by what they spent.
 *
 * Why: `GET /admin/reports/top-clients` (decision 064): the one Top accounts list of the dashboard. Every account with an
 * order created in the window is a candidate, whatever its rank, guests included (a guest checkout is an account row without a login);
 * anonymized accounts are left out. `scope` is the door of the order: `b2c` counts the `store` door, `b2b` every other door, `all`
 * both, so an account that crossed ranks counts the orders of each door it used. Spend is the price (before VAT) of the non-rejected
 * orders, profit is price minus cost of the completed ones. Highest spend first, ties by account id.
 *
 * @param db the database
 * @param since the start of the window
 * @param limit how many accounts to return
 * @param scope which doors count
 * @returns the ranked accounts
 */
export async function topAccountFigures(
  db: DbExecutor,
  since: Date,
  limit: number,
  scope: TopScope,
): Promise<TopAccountFigures[]> {
  const o = s.orders;
  const spend = sql`coalesce(sum(${o.totalPrice}) filter (where ${o.status} <> 'rejected'), 0)`;
  const door = scope === 'b2c' ? eq(o.source, 'store') : scope === 'b2b' ? ne(o.source, 'store') : undefined;
  return db
    .select({
      id: s.clients.id,
      name: s.clients.name,
      country: s.clients.country,
      rankId: s.clientGroups.id,
      rankName: s.clientGroups.name,
      rankGroupKind: s.clientGroups.kind,
      hasAccount: s.clients.hasAccount,
      orders: sql<number>`count(${o.id})::int`,
      spend: sql<string>`${spend}::numeric(18,4)::text`,
      profit: sql<string>`coalesce(sum(${o.totalPrice} - ${o.totalCost}) filter (where ${o.status} = 'completed'), 0)::numeric(18,4)::text`,
    })
    .from(o)
    .innerJoin(s.clients, eq(s.clients.id, o.accountId))
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(and(gte(o.createdAt, since), ne(s.clients.status, 'anonymized'), door))
    .groupBy(
      s.clients.id,
      s.clients.name,
      s.clients.country,
      s.clients.hasAccount,
      s.clientGroups.id,
      s.clientGroups.name,
      s.clientGroups.kind,
    )
    .orderBy(desc(spend), asc(s.clients.id))
    .limit(limit);
}

/**
 * Reads the wallet balances of some accounts, both kinds.
 *
 * Why: the top list shows the balance of the `live` wallet, which depends on the rank (the service picks it with `liveWalletBalance`); a
 * wallet of the inactive kind holds zero but is returned too, so the caller never needs a second read.
 *
 * @param db the database
 * @param accountIds the accounts
 * @returns the balances by account id, as text, keyed by ledger kind; an account without a wallet has no entry
 */
export async function walletBalances(
  db: DbExecutor,
  accountIds: readonly number[],
): Promise<Map<number, WalletBalances>> {
  if (accountIds.length === 0) return new Map();
  const wallet = ledgerAccounts;
  const rows = await db
    .select({ accountId: wallet.ownerId, kind: wallet.kind, balance: wallet.balance })
    .from(wallet)
    .where(
      and(
        eq(wallet.ownerType, 'account'),
        inArray(wallet.kind, ['client_wallet', 'customer_wallet']),
        eq(wallet.currency, BASE_CURRENCY),
        inArray(wallet.ownerId, [...accountIds]),
      ),
    );
  const byAccount = new Map<number, WalletBalances>();
  for (const row of rows) {
    if (row.accountId === null || (row.kind !== 'client_wallet' && row.kind !== 'customer_wallet')) continue;
    byAccount.set(row.accountId, { ...byAccount.get(row.accountId), [row.kind]: row.balance });
  }
  return byAccount;
}
