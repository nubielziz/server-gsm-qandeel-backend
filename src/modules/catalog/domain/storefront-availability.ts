// The smallest quantity a buyer can order of a service (feature 22, slice B): the amount of stock that makes the shop say "in stock".
// Pure; the SQL twin is IN_STOCK_SQL (infra/storefront-services.repository.ts), kept equal by test/integration/storefront-availability.test.ts.

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
