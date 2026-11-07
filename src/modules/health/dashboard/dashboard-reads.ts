// Read-only queries behind the dashboard, in one file: the orders figures, the supplier rows, and the counts and sums over the tables
// of the modules that have no reader yet (payments, refunds, disputes, tickets, commissions, merchants, wallets, currencies).
//
// DEVIATION to resolve when those modules export readers: decision 016 wants these reads through the owning module's public service.
// Orders export the SQL fragments `pastSlaPredicate` and `queueSql` (used here, so the age-only past-SLA rule of B92 stays in one place);
// the catalog exports `belowFloorSql` (user rule 9); the customers module exports `storefrontFunnel`. Everything else is read with plain
// selects, like the foreign-reads files of the other modules. Replace the bodies when readers exist; nothing outside this file knows.
// Money: orders are stored in USD; payments, refunds and disputes are converted per row at the checkout's locked rate or the current
// `rate_to_base` and summed once (decision 011, resolution identity-platform-8).
import { type SQL, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { catalog, money as moneyApi, orders } from '../infra/sibling-modules';
import { DISPUTE_DUE_SOON_MS } from './attention';

/** Which orders a dashboard figure covers. */
export type Scope = 'all' | 'b2b' | 'b2c';

const DAY_MS = 86_400_000;
const o = s.orders;
const money = (expression: SQL): SQL<string> => sql<string>`coalesce(${expression}, 0)::numeric(20,4)::text`;
/** An id read through raw SQL or `array_agg`: the driver returns a `bigint` as a string, the wire wants a number (decision 027). */
const idOf = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/** The condition that keeps the orders of a scope (`all` keeps everything). */
function inScope(scope: Scope): SQL {
  return scope === 'b2b' ? sql`${o.clientId} is not null` : scope === 'b2c' ? sql`${o.clientId} is null` : sql`true`;
}

/** The figures of one period (`PeriodStats`), money as 4-decimal strings. */
export interface PeriodRow {
  readonly revenue: string;
  readonly profit: string;
  readonly orders: number;
  readonly successRate: number | null;
  readonly medianTurnaroundSeconds: number | null;
}

/**
 * The figures of orders created in `[from, to)`.
 *
 * @param db the database
 * @param from the start of the window
 * @param to the end of the window
 * @param scope the channel
 * @returns revenue and profit of the completed orders, the count of all, the success rate and the median turnaround
 */
export async function periodStats(db: DbExecutor, from: Date, to: Date, scope: Scope): Promise<PeriodRow> {
  const [row] = await db
    .select({
      orders: sql<number>`count(*)::int`,
      completed: sql<number>`(count(*) filter (where ${o.status} = 'completed'))::int`,
      rejected: sql<number>`(count(*) filter (where ${o.status} = 'rejected'))::int`,
      revenue: money(sql`sum(${o.totalPrice}) filter (where ${o.status} = 'completed')`),
      profit: money(sql`sum(${o.totalPrice} - ${o.totalCost}) filter (where ${o.status} = 'completed')`),
      median: sql<
        number | null
      >`percentile_cont(0.5) within group (order by extract(epoch from (${o.completedAt} - ${o.createdAt}))) filter (where ${o.status} = 'completed' and ${o.completedAt} is not null)`,
    })
    .from(o)
    .where(sql`${o.createdAt} >= ${from} and ${o.createdAt} < ${to} and ${inScope(scope)}`);
  const finished = (row?.completed ?? 0) + (row?.rejected ?? 0);
  return {
    revenue: row?.revenue ?? '0.0000',
    profit: row?.profit ?? '0.0000',
    orders: row?.orders ?? 0,
    successRate: finished === 0 ? null : Math.round(((row?.completed ?? 0) / finished) * 10_000) / 100,
    medianTurnaroundSeconds: row?.median === null || row?.median === undefined ? null : Math.round(Number(row.median)),
  };
}

/** The open orders of one service type. */
export interface QueueRow {
  readonly type: string;
  readonly open: number;
  readonly review: number;
  readonly pastSla: number;
  readonly oldestCreatedAt: Date | null;
}

/**
 * Open orders, orders waiting for review and orders past their SLA per service type.
 *
 * Why: `review` counts the derived queues manual, needs_attention, review and verification (decision 025); `pastSla` is the age-only
 * predicate of B92 (a review order can be past SLA); an order accepted by staff (`operator`) has no queue and counts only in `open`.
 *
 * @param db the database
 * @param now the clock's time
 * @param scope the channel
 * @returns one row per type that has orders
 */
export async function queuesByType(db: DbExecutor, now: Date, scope: Scope): Promise<QueueRow[]> {
  const { pastSlaPredicate, queueSql } = await orders();
  const rows = await db
    .select({
      type: o.type,
      open: sql<number>`(count(*) filter (where ${o.status} in ('pending', 'processing')))::int`,
      review: sql<number>`(count(*) filter (where ${queueSql} in ('manual', 'needs_attention', 'review', 'verification')))::int`,
      pastSla: sql<number>`(count(*) filter (where ${pastSlaPredicate(now)}))::int`,
      oldest: sql<Date | null>`min(${o.createdAt}) filter (where ${o.status} in ('pending', 'processing'))`,
    })
    .from(o)
    .innerJoin(s.services, sql`${s.services.id} = ${o.serviceId}`)
    .where(
      sql`(${o.status} in ('pending', 'processing') or (${o.status} = 'completed' and ${o.verificationStatus} = 'requested')) and ${inScope(scope)}`,
    )
    .groupBy(o.type);
  return rows.map((row) => ({
    type: row.type,
    open: row.open,
    review: row.review,
    pastSla: row.pastSla,
    oldestCreatedAt: row.oldest ? new Date(row.oldest) : null,
  }));
}

/** What the past-SLA attention item states. */
export interface PastSlaDetail {
  readonly count: number;
  readonly oldestOrderId: number | null;
  readonly overdueSeconds: number;
  readonly targetSeconds: number;
}

/**
 * The count of past-SLA orders and the facts of the oldest one.
 *
 * @param db the database
 * @param now the clock's time
 * @param scope the channel
 * @returns the count, the oldest order's id, how long it is overdue and its target in seconds
 */
export async function pastSlaDetail(db: DbExecutor, now: Date, scope: Scope): Promise<PastSlaDetail> {
  const { pastSlaPredicate } = await orders();
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldestId: sql<number | null>`(array_agg(${o.id} order by ${o.placedAt}, ${o.id}))[1]`,
      oldestPlaced: sql<Date | null>`min(${o.placedAt})`,
      targetMinutes: sql<number | null>`(array_agg(${s.services.slaMinutes} order by ${o.placedAt}, ${o.id}))[1]`,
    })
    .from(o)
    .innerJoin(s.services, sql`${s.services.id} = ${o.serviceId}`)
    .where(sql`${pastSlaPredicate(now)} and ${inScope(scope)}`);
  const target = (row?.targetMinutes ?? 0) * 60;
  const placed = row?.oldestPlaced ? new Date(row.oldestPlaced).getTime() : now.getTime();
  return {
    count: row?.count ?? 0,
    oldestOrderId: idOf(row?.oldestId),
    overdueSeconds: Math.max(0, Math.floor((now.getTime() - placed) / 1000) - target),
    targetSeconds: target,
  };
}

/**
 * How many merchant orders wait in each review queue.
 *
 * Why: RULES dashboard 3: `orders_review` is about merchant orders only. A storefront order held by risk is the `orders_held` item, so
 * counting it here too would raise the same orders twice. The caller does not ask for it in the `b2c` scope.
 *
 * @param db the database
 * @returns the count per derived queue (`manual`, `needs_attention`, `review`, `verification`) over orders with a merchant
 */
export async function reviewQueues(db: DbExecutor): Promise<Map<string, number>> {
  const { queueSql } = await orders();
  const rows = await db
    .select({ queue: sql<string>`${queueSql}`, n: sql<number>`count(*)::int` })
    .from(o)
    .where(sql`${queueSql} in ('manual', 'needs_attention', 'review', 'verification') and ${o.clientId} is not null`)
    .groupBy(queueSql);
  return new Map(rows.map((row) => [row.queue, row.n]));
}

/** A supplier with the figures the dashboard row and the attention items need. */
export interface SupplierDashRow {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly balance: string;
  readonly balanceUsd: string;
  readonly lowBalanceAlert: string;
  readonly minimumUsd: string;
  readonly creditRate: string;
  readonly check: { readonly status: 'ok' | 'degraded' | 'down' | 'unknown' } | null;
  readonly total1h: number;
  readonly ok1h: number;
  readonly p50Ms: number | null;
  readonly openOrders: number;
  readonly weeklySpend: string;
}

/**
 * Every supplier with its latest check, its calls of the last hour, its open orders and its spend of the last 7 days.
 *
 * @param db the database
 * @param now the clock's time
 * @returns the suppliers by id
 */
export async function supplierRows(db: DbExecutor, now: Date): Promise<SupplierDashRow[]> {
  const hour = new Date(now.getTime() - DAY_MS / 24);
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const result = await db.execute<{
    id: number;
    name: string;
    status: string;
    balance: string;
    balance_usd: string;
    low_balance_alert: string;
    minimum_usd: string;
    credit_rate: string;
    check_status: 'ok' | 'degraded' | 'down' | 'unknown' | null;
    total1h: number;
    ok1h: number;
    p50: number | null;
    open_orders: number;
    weekly_spend: string;
  }>(sql`
    select su.id, su.name, su.status, su.balance::text as balance,
      round(su.balance * su.credit_rate, 4)::text as balance_usd, su.low_balance_alert::text as low_balance_alert,
      round(su.low_balance_alert * su.credit_rate, 4)::text as minimum_usd, su.credit_rate::text as credit_rate,
      (select c.status from service_checks c where c.supplier_id = su.id order by c.checked_at desc, c.id desc limit 1) as check_status,
      (select count(*)::int from supplier_api_logs l where l.supplier_id = su.id and l.created_at >= ${hour}) as total1h,
      (select count(*)::int from supplier_api_logs l where l.supplier_id = su.id and l.created_at >= ${hour} and l.outcome = 'ok') as ok1h,
      (select percentile_cont(0.5) within group (order by l.duration_ms) from supplier_api_logs l where l.supplier_id = su.id and l.created_at >= ${hour}) as p50,
      (select count(*)::int from orders x where x.supplier_id = su.id and x.status in ('pending', 'processing')) as open_orders,
      (select coalesce(sum(x.total_cost), 0)::numeric(20,4)::text from orders x where x.supplier_id = su.id and x.status = 'completed' and x.completed_at >= ${week}) as weekly_spend
    from suppliers su order by su.id`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    status: row.status,
    balance: row.balance,
    balanceUsd: row.balance_usd,
    lowBalanceAlert: row.low_balance_alert,
    minimumUsd: row.minimum_usd,
    creditRate: row.credit_rate,
    check: row.check_status === null ? null : { status: row.check_status },
    total1h: row.total1h,
    ok1h: row.ok1h,
    p50Ms: row.p50 === null ? null : Math.round(Number(row.p50)),
    openOrders: row.open_orders,
    weeklySpend: row.weekly_spend,
  }));
}

/**
 * Active services priced below their floor (the effective cost plus the minimum profit, user rule 9).
 *
 * @param db the database
 * @param now the clock's time (the pricing rules have windows)
 * @returns the count and the first five names
 */
export async function servicesBelowFloor(db: DbExecutor, now: Date): Promise<{ count: number; names: string[] }> {
  const { belowFloorSql } = await catalog();
  const rows = await db
    .select({ name: s.services.name })
    .from(s.services)
    .where(sql`${s.services.status} = 'active' and ${belowFloorSql(now)}`)
    .orderBy(s.services.name);
  return { count: rows.length, names: rows.slice(0, 5).map((row) => row.name) };
}

/** Counts and sums over the money and support tables, for the attention items and the sidebar. */
export interface MoneyFacts {
  readonly depositsPending: { count: number; total: string; oldestAt: Date | null };
  readonly walletsNegative: { count: number; clients: Array<{ id: number; name: string; balance: string }> };
  readonly merchantsPending: { count: number; names: string[] };
  readonly commissions: { count: number; total: string; agents: number };
  readonly held: { count: number; captured: string; oldestAt: Date | null };
  /** Every dispute that needs a response: `dueSoon` of them are due within 3 days; the first (earliest deadline) gives the rest. */
  readonly disputesDue: {
    count: number;
    dueSoon: number;
    firstId: number | null;
    dueAt: Date | null;
    amount: string;
    fee: string;
  };
  readonly ticketsLate: { count: number; oldestId: number | null; since: Date | null; subject: string };
  readonly ticketsOpen: number;
  readonly refundsRequested: { count: number; total: string };
  readonly refundsFailed: { count: number; firstId: number | null; reason: string };
  readonly fxStale: { currencies: string[]; oldest: Date | null };
}

/**
 * Reads the facts of the attention items that come from other modules' tables.
 *
 * Why: identity-platform-8: every amount in USD, converted per row (`amount / coalesce(checkout fx_rate, currency rate_to_base)`) and
 * rounded once. Tables that are still empty (billing, support and refunds are built later) give zeros and no item.
 *
 * @param db the database
 * @param now the clock's time
 * @returns the facts
 */
export async function moneyFacts(db: DbExecutor, now: Date): Promise<MoneyFacts> {
  const soon = new Date(now.getTime() + DISPUTE_DUE_SOON_MS);
  const { isRateStale } = await moneyApi();
  const one = async <T>(query: SQL): Promise<T> => (await db.execute<T & Record<string, unknown>>(query)).rows[0] as T;
  const rate = sql`coalesce(cs.fx_rate, cur.rate_to_base)`;
  const [deposits, wallets, merchants, commissions, held, dispute, late, ticketsOpen, refunds, failed, fx] =
    await Promise.all([
      one<{ n: number; total: string; oldest: Date | null }>(sql`
      select count(*)::int as n, coalesce(sum(p.amount / ${rate}), 0)::numeric(20,4)::text as total, min(p.created_at) as oldest
      from payments p join currencies cur on cur.code = p.currency
      left join orders po on po.id = p.order_id left join checkout_sessions cs on cs.id = po.checkout_session_id
      where p.purpose = 'topup' and p.status = 'pending'`),
      db.execute<{ id: number; name: string; balance: string; n: number }>(sql`
      select c.id, c.name, a.balance::text as balance, count(*) over ()::int as n
      from ledger_accounts a join clients c on c.id = a.owner_id
      where a.kind = 'client_wallet' and a.balance < 0 order by a.balance, c.id limit 5`),
      db.execute<{ name: string; n: number }>(sql`
      select name, count(*) over ()::int as n from clients where status = 'pending' order by created_at, id limit 5`),
      one<{ n: number; total: string; agents: number }>(sql`
      select count(*)::int as n, coalesce(sum(amount), 0)::numeric(20,4)::text as total, count(distinct beneficiary_id)::int as agents
      from commission_accruals where status = 'accrued'`),
      one<{ n: number; captured: string; oldest: Date | null }>(sql`
      select count(*)::int as n, coalesce(sum(total_price + tax_amount), 0)::numeric(20,4)::text as captured, min(placed_at) as oldest
      from orders where client_id is null and dispatch_state = 'held' and status in ('pending', 'processing')`),
      one<{ n: number; soon: number; id: number | null; due: Date | null; amount: string; fee: string }>(sql`
      with open_disputes as (
        select d.id, d.evidence_due_at, d.amount / ${rate} as usd_amount, d.fee / ${rate} as usd_fee
        from disputes d join currencies cur on cur.code = d.currency
        left join orders po on po.id = d.order_id left join checkout_sessions cs on cs.id = po.checkout_session_id
        where d.status = 'needs_response'),
      earliest as (select * from open_disputes order by evidence_due_at, id limit 1)
      select (select count(*) from open_disputes)::int as n,
        (select count(*) from open_disputes where evidence_due_at <= ${soon})::int as soon,
        (select id from earliest) as id, (select evidence_due_at from earliest) as due,
        coalesce((select usd_amount from earliest), 0)::numeric(20,4)::text as amount,
        coalesce((select usd_fee from earliest), 0)::numeric(20,4)::text as fee`),
      one<{ n: number; id: number | null; since: Date | null; subject: string | null }>(sql`
      with late as (select * from support_tickets where status in ('new', 'open') and sla_due_at is not null and sla_due_at < ${now})
      select (select count(*) from late)::int as n, (select id from late order by created_at, id limit 1) as id,
        (select created_at from late order by created_at, id limit 1) as since, (select subject from late order by created_at, id limit 1) as subject`),
      one<{ n: number }>(sql`select count(*)::int as n from support_tickets where status <> 'resolved'`),
      one<{ n: number; total: string }>(sql`
      select count(*)::int as n, coalesce(sum(r.amount / ${rate}), 0)::numeric(20,4)::text as total
      from refunds r join currencies cur on cur.code = r.currency
      left join orders po on po.id = r.order_id left join checkout_sessions cs on cs.id = po.checkout_session_id
      where r.status = 'requested'`),
      one<{ n: number; id: number | null; reason: string | null }>(sql`
      select count(*)::int as n, (array_agg(id order by created_at, id))[1] as id, (array_agg(reason order by created_at, id))[1] as reason
      from refunds where status = 'failed'`),
      // Active currencies only (a switched-off one needs no refresh); money's rule decides which are stale.
      db.execute<{ code: string; updated: Date }>(sql`
      select code, rate_updated_at as updated from currencies where is_active order by rate_updated_at, code`),
    ]);
  // The 24 h rule of the currencies page (`isStale`), so the item and the page never disagree (M166); oldest first.
  const staleRates = fx.rows.filter((row) => isRateStale(row.code, new Date(row.updated).getTime(), now.getTime()));
  return {
    depositsPending: {
      count: deposits.n,
      total: deposits.total,
      oldestAt: deposits.oldest ? new Date(deposits.oldest) : null,
    },
    walletsNegative: {
      count: wallets.rows[0]?.n ?? 0,
      clients: wallets.rows.map((row) => ({ id: Number(row.id), name: row.name, balance: row.balance })),
    },
    merchantsPending: { count: merchants.rows[0]?.n ?? 0, names: merchants.rows.map((row) => row.name) },
    commissions: { count: commissions.n, total: commissions.total, agents: commissions.agents },
    held: { count: held.n, captured: held.captured, oldestAt: held.oldest ? new Date(held.oldest) : null },
    disputesDue: {
      count: dispute.n,
      dueSoon: dispute.soon,
      firstId: idOf(dispute.id),
      dueAt: dispute.due ? new Date(dispute.due) : null,
      amount: dispute.amount,
      fee: dispute.fee,
    },
    ticketsLate: {
      count: late.n,
      oldestId: idOf(late.id),
      since: late.since ? new Date(late.since) : null,
      subject: late.subject ?? '',
    },
    ticketsOpen: ticketsOpen.n,
    refundsRequested: { count: refunds.n, total: refunds.total },
    refundsFailed: { count: failed.n, firstId: idOf(failed.id), reason: failed.reason ?? '' },
    fxStale: {
      currencies: staleRates.map((row) => row.code),
      oldest: staleRates[0] ? new Date(staleRates[0].updated) : null,
    },
  };
}

/**
 * The `ordersByType` series: orders created per UTC day (30) and per UTC month (12), by type.
 *
 * @param db the database
 * @param now the clock's time
 * @param scope the channel
 * @returns the counts per type for each day and each month, oldest first
 */
export async function ordersByType(
  db: DbExecutor,
  now: Date,
  scope: Scope,
): Promise<{
  daily: Array<{ date: string; counts: Record<string, number> }>;
  monthly: Array<{ month: string; counts: Record<string, number> }>;
}> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * DAY_MS);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const [days, months] = await Promise.all([
    db.execute<{ bucket: string; type: string; n: number }>(sql`
      select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as bucket, type, count(*)::int as n from orders
      where created_at >= ${dayStart} and ${inScope(scope)} group by 1, 2`),
    db.execute<{ bucket: string; type: string; n: number }>(sql`
      select to_char(created_at at time zone 'UTC', 'YYYY-MM') as bucket, type, count(*)::int as n from orders
      where created_at >= ${monthStart} and ${inScope(scope)} group by 1, 2`),
  ]);
  const fold = (rows: Array<{ bucket: string; type: string; n: number }>, keys: string[]) =>
    keys.map((key) => ({
      key,
      counts: Object.fromEntries(
        ['imei', 'server', 'remote', 'file'].map((type) => [
          type,
          rows.find((row) => row.bucket === key && row.type === type)?.n ?? 0,
        ]),
      ),
    }));
  const dayKeys = Array.from({ length: 30 }, (_, i) =>
    new Date(dayStart.getTime() + i * DAY_MS).toISOString().slice(0, 10),
  );
  const monthKeys = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 7),
  );
  return {
    daily: fold(days.rows, dayKeys).map(({ key, counts }) => ({ date: key, counts })),
    monthly: fold(months.rows, monthKeys).map(({ key, counts }) => ({ month: key, counts })),
  };
}

/**
 * Completed revenue before VAT by UTC day of completion, merchants against the storefront, over 30 days.
 *
 * @param db the database
 * @param now the clock's time
 * @returns one entry per day, oldest first
 */
export async function revenueByChannel(
  db: DbExecutor,
  now: Date,
): Promise<Array<{ date: string; b2b: string; b2c: string }>> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * DAY_MS);
  const rows = await db.execute<{ day: string; b2b: string; b2c: string }>(sql`
    select to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      coalesce(sum(total_price) filter (where client_id is not null), 0)::numeric(20,4)::text as b2b,
      coalesce(sum(total_price) filter (where client_id is null), 0)::numeric(20,4)::text as b2c
    from orders where status = 'completed' and completed_at >= ${dayStart} group by 1`);
  const byDay = new Map(rows.rows.map((row) => [row.day, row]));
  return Array.from({ length: 30 }, (_, i) => {
    const date = new Date(dayStart.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    return { date, b2b: byDay.get(date)?.b2b ?? '0.0000', b2c: byDay.get(date)?.b2c ?? '0.0000' };
  });
}

/** The storefront block's figures beyond the funnel, over a window. */
export interface StorefrontExtras {
  readonly averageOrder: string | null;
  readonly refundRate: number | null;
  readonly disputeRate: number | null;
  readonly firstReplySeconds: number | null;
  readonly satisfaction: { average: number; ratings: number } | null;
  readonly topCustomers: Array<{ id: number; name: string; country: string; orders: number; spend: string }>;
}

/**
 * The storefront figures that are not the funnel: average order, refund and dispute rates, support speed and satisfaction, top customers.
 *
 * @param db the database
 * @param now the clock's time
 * @param from the start of the window (the storefront block is always 30 days; the top customers follow the dashboard's period)
 * @param topFrom the start of the top customers' window
 * @returns the figures, `null` where there is nothing to divide by
 */
export async function storefrontExtras(
  db: DbExecutor,
  now: Date,
  from: Date,
  topFrom: Date,
): Promise<StorefrontExtras> {
  const [paid, refunds, disputes, tickets, top] = await Promise.all([
    db.execute<{ avg: string | null; n: number; total: string }>(sql`
      select round(avg(cs.gross_amount / cs.fx_rate), 4)::text as avg, count(*)::int as n,
        coalesce(sum(cs.gross_amount / cs.fx_rate), 0)::text as total
      from checkout_sessions cs where cs.order_id is not null and cs.created_at >= ${from} and cs.created_at < ${now}`),
    db.execute<{ refunded: string }>(sql`
      select coalesce(sum(r.amount / coalesce(cs.fx_rate, cur.rate_to_base)), 0)::text as refunded
      from refunds r join currencies cur on cur.code = r.currency
      left join orders po on po.id = r.order_id left join checkout_sessions cs on cs.id = po.checkout_session_id
      where r.status = 'completed' and r.customer_id is not null and r.created_at >= ${from} and r.created_at < ${now}`),
    db.execute<{ n: number }>(
      sql`select count(*)::int as n from disputes where created_at >= ${from} and created_at < ${now}`,
    ),
    db.execute<{ median: number | null; avg: string | null; ratings: number }>(sql`
      select percentile_cont(0.5) within group (order by extract(epoch from (first_response_at - created_at))) as median,
        avg(csat_score)::numeric(4,2)::text as avg, (count(*) filter (where csat_score is not null))::int as ratings
      from support_tickets where requester_type = 'customer' and created_at >= ${from} and created_at < ${now}`),
    db.execute<{ id: number; name: string; country: string | null; orders: number; spend: string }>(sql`
      select c.id, c.name, c.country, count(*)::int as orders, sum(o.total_price + o.tax_amount)::numeric(20,4)::text as spend
      from orders o join customers c on c.id = o.customer_id
      where o.status <> 'rejected' and o.created_at >= ${topFrom} and o.created_at < ${now}
      group by c.id, c.name, c.country order by sum(o.total_price + o.tax_amount) desc, c.id limit 5`),
  ]);
  const paidRow = paid.rows[0];
  const paidCount = paidRow?.n ?? 0;
  const ticketRow = tickets.rows[0];
  return {
    averageOrder: paidRow?.avg ?? null,
    refundRate:
      paidCount === 0 || Number(paidRow?.total ?? 0) === 0
        ? null
        : Math.round((Number(refunds.rows[0]?.refunded ?? 0) / Number(paidRow?.total)) * 10_000) / 100,
    disputeRate: paidCount === 0 ? null : Math.round(((disputes.rows[0]?.n ?? 0) / paidCount) * 10_000) / 100,
    firstReplySeconds:
      ticketRow?.median === null || ticketRow?.median === undefined ? null : Math.round(Number(ticketRow.median)),
    satisfaction:
      ticketRow && ticketRow.ratings > 0 && ticketRow.avg !== null
        ? { average: Number(ticketRow.avg), ratings: ticketRow.ratings }
        : null,
    topCustomers: top.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      country: row.country ?? '',
      orders: row.orders,
      spend: row.spend,
    })),
  };
}

/**
 * The counts of the sidebar that need their own query.
 *
 * @param db the database
 * @param now the clock's time
 * @returns open orders and past-SLA orders of the whole console, and the held storefront orders
 */
export async function orderCounts(db: DbExecutor, now: Date): Promise<{ open: number; pastSla: number }> {
  const { pastSlaPredicate } = await orders();
  const [row] = await db
    .select({
      open: sql<number>`(count(*) filter (where ${o.status} in ('pending', 'processing')))::int`,
      pastSla: sql<number>`(count(*) filter (where ${pastSlaPredicate(now)}))::int`,
    })
    .from(o)
    .innerJoin(s.services, sql`${s.services.id} = ${o.serviceId}`)
    .where(sql`${o.status} in ('pending', 'processing')`);
  return { open: row?.open ?? 0, pastSla: row?.pastSla ?? 0 };
}
