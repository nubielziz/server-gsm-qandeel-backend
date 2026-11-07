// SQL fragments of the order read model that more than one query shares: the derived queue, the channel and the one past-SLA
// predicate (B92, RESOLUTIONS orders-suppliers-1, identity-platform-10, health-commissions-10). Features 9 (dashboard, System
// health) import `pastSlaPredicate` through the module's public API.
import { type SQL, sql } from 'drizzle-orm';
import { orders } from '../db/schema';
import { foreignTables } from './foreign-reads.repository';

/**
 * The console's queue of an order as a SQL expression (decision 025): `review` = held; `needs_attention` = needs_attention;
 * `verification` = completed with a requested verification; `manual` = pending + manual; `pending` = pending + dispatch
 * pending; otherwise null. The same rules as `deriveQueue` in `domain/order-machine.ts` (a test compares them).
 */
export const queueSql: SQL = sql`(case
  when ${orders.dispatchState} = 'held' then 'review'
  when ${orders.dispatchState} = 'needs_attention' then 'needs_attention'
  when ${orders.status} = 'completed' and ${orders.verificationStatus} = 'requested' then 'verification'
  when ${orders.status} = 'pending' and ${orders.dispatchState} = 'manual' then 'manual'
  when ${orders.status} = 'pending' and ${orders.dispatchState} = 'pending' then 'pending'
  else null end)`;

/** `b2b` when the order has a merchant, `b2c` when it has a storefront customer. */
export const channelSql: SQL = sql`(case when ${orders.clientId} is not null then 'b2b' else 'b2c' end)`;

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
