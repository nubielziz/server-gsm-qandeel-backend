// The smallest quantity a buyer can order of a service (feature 22, slice B): the amount of stock that makes the shop say "in stock", for a
// service delivered from code stock (decision 069). Pure; the SQL twin of `showsInStock` is IN_STOCK_SQL
// (infra/storefront-services.repository.ts), kept equal by test/integration/catalog/storefront-availability.test.ts.

/**
 * Works out the smallest order a service accepts.
 *
 * Why: the storefront shows `in_stock` when the available inventory codes cover the smallest order (decision of feature 22):
 * with fixed packs that is the smallest pack, otherwise the minimum quantity. A service never reads "in stock" for an order it
 * could not deliver at once from the codes it holds.
 *
 * @param minQty the service's minimum quantity (at least 1)
 * @param qtyOptions the fixed pack sizes; empty means any quantity from `minQty`
 * @returns the smallest orderable quantity
 */
export function smallestOrder(minQty: number, qtyOptions: readonly number[]): number {
  return qtyOptions.length > 0 ? Math.min(...qtyOptions) : minQty;
}

/**
 * Tells whether the stock covers the smallest order.
 *
 * @param availableCodes how many `available` inventory codes the service holds
 * @param minQty the service's minimum quantity
 * @param qtyOptions the fixed pack sizes
 * @returns true when the available codes are at least the smallest order
 */
export function coversSmallestOrder(availableCodes: number, minQty: number, qtyOptions: readonly number[]): boolean {
  return availableCodes >= smallestOrder(minQty, qtyOptions);
}

/**
 * Tells whether the shop shows a service `in_stock`: it is delivered from code stock and its available codes cover the smallest order.
 *
 * Why: decision 069: only a service delivered from code stock takes codes at placement, so only its codes can make an order complete at
 * once; codes of any other service (none after the migration) never make it read "in stock".
 *
 * @param stockDelivery the service is delivered from code stock (`services.stock_delivery`)
 * @param availableCodes how many `available` inventory codes the service holds
 * @param minQty the service's minimum quantity
 * @param qtyOptions the fixed pack sizes
 * @returns true when the shop says `in_stock`
 */
export function showsInStock(
  stockDelivery: boolean,
  availableCodes: number,
  minQty: number,
  qtyOptions: readonly number[],
): boolean {
  return stockDelivery && coversSmallestOrder(availableCodes, minQty, qtyOptions);
}
