// The service figures as SQL expressions over `services`: the effective minimum profit, the floor price, the margin and
// "below floor". They are the SQL form of domain/service-figures.ts (a test keeps the two equal), so the list can filter and
// sort on them. Feature 4b adds the pricing-rule selection of catalog-4 to the minimum profit here.
import { type SQL, sql } from 'drizzle-orm';
import { services } from '../db/schema';

/**
 * The minimum profit that counts: the service's own, else `max(round(6 % of the effective cost, 2), 0.02)`.
 *
 * Why: RULES services 1 and RESOLUTIONS catalog-1; four decimals like every `Money` on the wire.
 */
export const minProfitSql: SQL<string> = sql`coalesce(${services.minProfit}, greatest(round(${services.effectiveCost} * 0.06, 2), 0.02))::numeric(18,4)`;

/** The floor price: the effective cost plus {@link minProfitSql}. */
export const floorPriceSql: SQL<string> = sql`(${services.effectiveCost} + ${minProfitSql})::numeric(18,4)`;

/** `base_price < floor`: the price is strictly under the floor. */
export const belowFloorSql: SQL<boolean> = sql`(${services.basePrice} < ${floorPriceSql})`;

/** The margin on the price in percent with four decimals, `(base_price - cost) / base_price x 100`; `base_price` is above zero. */
export const marginPctSql: SQL<string> = sql`round((${services.basePrice} - ${services.effectiveCost}) * 100 / ${services.basePrice}, 4)`;
