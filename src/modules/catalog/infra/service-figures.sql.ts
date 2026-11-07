// The service figures as SQL expressions over `services`: the effective minimum profit, the floor price, the margin and
// "below floor". They are the SQL form of domain/service-figures.ts and domain/price-resolution.ts (a test keeps them equal), so
// the list can filter and sort on them. There is no merchant in these contexts, so only pricing rules for every group count
// (RESOLUTIONS catalog-1).
import { type SQL, sql } from 'drizzle-orm';
import { services } from '../db/schema';

/**
 * The minimum profit of the first matching rule that sets one: `pricing_rules.min_profit` above zero, in resolver order (scope
 * service, category, global; then priority; then id), among the active rules for every group inside their window at `at`.
 *
 * The service columns inside the subquery are written with their table name on purpose: in a select from one table Drizzle
 * prints a selected column without it, which would bind `id` to the rule table.
 */
function ruleMinProfitSql(at: Date): SQL {
  return sql`(
    select r.min_profit
    from pricing_rules r
    where r.is_active and r.group_id is null and r.min_profit > 0
      and (r.starts_at is null or r.starts_at <= ${at}) and (r.ends_at is null or r.ends_at > ${at})
      and (
        r.scope = 'global'
        or (r.scope = 'service' and r.target_id = "services"."id")
        or (r.scope = 'category' and r.target_id = "services"."category_id")
      )
    order by case r.scope when 'service' then 0 when 'category' then 1 else 2 end, r.priority, r.id
    limit 1
  )`;
}

/**
 * The minimum profit that counts: the service's own, else the first matching rule's, else `max(round(6 % of the effective cost, 2), 0.02)`.
 *
 * Why: RULES services 1 and RESOLUTIONS catalog-1 and catalog-4; four decimals like every `Money` on the wire.
 *
 * @param at the clock's now: rule windows are judged at it (decision 031)
 * @returns the SQL expression
 */
export function minProfitSql(at: Date): SQL<string> {
  return sql`coalesce(${services.minProfit}, ${ruleMinProfitSql(at)}, greatest(round(${services.effectiveCost} * 0.06, 2), 0.02))::numeric(18,4)`;
}

/**
 * The floor price: the effective cost plus {@link minProfitSql}.
 *
 * @param at the clock's now
 * @returns the SQL expression
 */
export function floorPriceSql(at: Date): SQL<string> {
  return sql`(${services.effectiveCost} + ${minProfitSql(at)})::numeric(18,4)`;
}

/**
 * `base_price < floor`: the price is strictly under the floor.
 *
 * @param at the clock's now
 * @returns the SQL expression
 */
export function belowFloorSql(at: Date): SQL<boolean> {
  return sql`(${services.basePrice} < ${floorPriceSql(at)})`;
}

/** The margin on the price in percent with four decimals, `(base_price - cost) / base_price x 100`; `base_price` is above zero. */
export const marginPctSql: SQL<string> = sql`round((${services.basePrice} - ${services.effectiveCost}) * 100 / ${services.basePrice}, 4)`;
