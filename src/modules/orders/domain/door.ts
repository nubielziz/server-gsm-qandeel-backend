// The door an order came through (decision 064): `orders.source` says how the money moves, whatever rank the buyer has today. Pure.
import { type SQL, sql } from 'drizzle-orm';
import type { OrderSource } from '../db/schema';

/**
 * Tells whether an order was paid first, through the shop checkout.
 *
 * Why: the money path of an existing order follows its door, never the buyer's current rank: a `store` order was paid before it was placed (retail
 * price, VAT, risk screening); the portal, Dhru and the older REST doors hold the amount from the merchant wallet and settle on delivery. This
 * replaces every "the order has no merchant" test.
 *
 * @param order the order, or anything with its source
 * @returns true for the `store` door
 */
export function isPrepaidOrder(order: { readonly source: OrderSource }): boolean {
  return order.source === 'store';
}

/**
 * The SQL condition of {@link isPrepaidOrder}.
 *
 * Why: readers scope merchant views with `NOT <this>` and the shop's own views with it, in SQL.
 *
 * @param sourceColumn the `orders.source` column (or an alias of it)
 * @returns a boolean SQL expression, true for a prepaid order
 */
export function prepaidOrderSql(sourceColumn: SQL): SQL {
  return sql`${sourceColumn} = 'store'`;
}
