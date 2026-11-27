// SQL fragments of the order read model that more than one query shares: the derived queue, the channel (the door), the scopes of the
// merchant's and the shop's own orders, the order figures of the account list and the one past-SLA predicate (B92, RESOLUTIONS
// orders-suppliers-1, identity-platform-10, health-commissions-10, decision 064). Features 9 (dashboard, System health) import
// `pastSlaPredicate` through the module's public API.
import { type SQL, and, eq, sql } from 'drizzle-orm';
import type { OrderFigure } from '../../identity';
import { orderEvents, orders } from '../db/schema';
import { prepaidOrderSql } from '../domain/door';
import { foreignTables } from './foreign-reads.repository';

/**
 * The console's queue of an order as a SQL expression (decision 025): `review` = held; `needs_attention` = needs_attention;
 * `verification` = completed with a requested verification; `manual` = pending + manual; `pending` = pending + dispatch
 * pending or dispatching (decision 044); otherwise null. The same rules as `deriveQueue` in `domain/order-machine.ts` (a test
 * compares them).
 */
export const queueSql: SQL = sql`(case
  when ${orders.dispatchState} = 'held' then 'review'
  when ${orders.dispatchState} = 'needs_attention' then 'needs_attention'
  when ${orders.status} = 'completed' and ${orders.verificationStatus} = 'requested' then 'verification'
  when ${orders.status} = 'pending' and ${orders.dispatchState} = 'manual' then 'manual'
  when ${orders.status} = 'pending' and ${orders.dispatchState} in ('pending', 'dispatching') then 'pending'
  else null end)`;

/**
 * True once the order has a `dispatch` event: it was claimed for a supplier call at least once (decision 044).
 *
 * Why: the merchant's cancel is refused for good once an order was claimed, even when a failed or lost send reads `pending` again; the order
 * read model (`canCancel`) and the cancel window of the dispatch job (decision 075) read the same fact. One `EXISTS` in the select (never a
 * query per row); `order_events_order_idx` serves it.
 */
export const everDispatchedSql = sql<boolean>`exists (select 1 from ${orderEvents} where ${orderEvents.orderId} = ${orders.id} and ${orderEvents.type} = 'dispatch')`;

/** The condition "this order was paid first, through the shop": the `store` door (`isPrepaidOrder`), never a null in another column. */
const prepaidSql: SQL = prepaidOrderSql(sql`${orders.source}`);

/**
 * The channel of an order as a SQL expression: `b2c` for the `store` door, `b2b` for every door that holds the amount from the merchant
 * wallet (portal, Dhru and the older REST and admin doors).
 *
 * Why: the console branches on the channel; it is derived from `orders.source`, which is written once, so it never disagrees with the door and
 * never depends on the buyer's rank today (decision 064).
 */
export const channelSql: SQL = sql`(case when ${prepaidSql} then 'b2c' else 'b2b' end)`;

/**
 * The orders a merchant sees as its own: placed by this account through a door that holds from the wallet.
 *
 * Why: `GET /client/orders*`, the portal dashboard and the Dhru status answer for the account's merchant-door orders only; a store order of
 * the same account (paid first, from the shop) is another door and is never listed, cancelled or answered here (decision 064).
 *
 * @param accountId the signed-in account (taken from the session, never from the request)
 * @returns the condition
 */
export function merchantDoorSql(accountId: number): SQL {
  return and(eq(orders.accountId, accountId), sql`not ${prepaidSql}`) as SQL;
}

/**
 * The orders of an account that were paid first, through the shop.
 *
 * Why: `GET /store/v1/me/orders` lists the account's own store orders (the `ShopOrders` seam), whatever its rank is today.
 *
 * @param accountId the signed-in account
 * @returns the condition
 */
export function shopDoorSql(accountId: number): SQL {
  return and(eq(orders.accountId, accountId), prepaidSql) as SQL;
}

/**
 * The SQL of one order figure of an account, for the staff account list.
 *
 * Why: `GET /admin/clients` shows and sorts by the count of orders, the date of the last one and the total spent. The list is
 * built by identity, which may not read `orders`; the orders module registers this builder with `AccountListSql`. The figures cover every order
 * of the account, both doors and any status, except `totalSpent`, which leaves out rejected orders and adds the tax (gross).
 *
 * @param figure which figure
 * @param accountIdColumn the column of the list query that holds the account id
 * @returns a correlated scalar subquery (NULL for `lastOrderAt` when the account never ordered; `ordersCount` and `totalSpent` are zero)
 */
export function orderFigureSql(figure: OrderFigure, accountIdColumn: SQL): SQL {
  switch (figure) {
    case 'ordersCount':
      return sql`(select count(*)::int from orders o where o.account_id = ${accountIdColumn})`;
    case 'lastOrderAt':
      return sql`(select max(o.created_at) from orders o where o.account_id = ${accountIdColumn})`;
    case 'totalSpent':
      return sql`(select coalesce(sum(o.total_price + o.tax_amount) filter (where o.status <> 'rejected'), 0)::numeric(18,4) from orders o where o.account_id = ${accountIdColumn})`;
  }
}

/**
 * The past-SLA predicate: an open order older than its service's SLA.
 *
 * Why: B92 and decision 025: one age-only predicate with no queue exclusion, shared by `GET /admin/orders?pastSla=true`, the
 * dashboard queues and attention rows, the sidebar counts and `GET /admin/system/orders-health`: `status IN ('pending',
 * 'processing')` and `placed_at < now - sla_minutes`. The clock is `placed_at` (the partial index `orders_open_idx` covers it;
 * placement never sets it, so it equals `created_at`). A service without a positive SLA is never past SLA. The time is the
 * injected clock's, passed in (decision 031).
 *
 * The caller's query must select `FROM orders` joined to `services` on `services.id = orders.service_id`.
 *
 * @param now the current time from the injected clock
 * @returns the boolean SQL condition
 */
export function pastSlaPredicate(now: Date): SQL {
  return sql`(${orders.status} in ('pending', 'processing')
    and ${foreignTables.services.slaMinutes} > 0
    and ${orders.placedAt} < ${now.toISOString()}::timestamptz - make_interval(mins => ${foreignTables.services.slaMinutes}))`;
}
