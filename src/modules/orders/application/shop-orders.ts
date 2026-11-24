// ShopOrderReads: the orders module's implementation of the `ShopOrders` seam (decision 064), the list behind `GET /store/v1/me/orders`.
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { listShopOrderRows } from '../infra/order-read.repository';
import { ShopOrders, type ShopOrderPage } from '../ports/shop-orders';

/**
 * Lists an account's own store orders for the account page of the shop.
 *
 * Why: the shop's account page shows what the account bought through the shop (the `store` door), newest first, whatever its rank is today:
 * an account that was a retail buyer and became a merchant still sees what it paid for in the shop, and a merchant's portal orders are never
 * listed here (they are another door, read by `GET /client/orders`). The account id is the session's, never the request's, so no account can
 * read another's orders. The customers module depends on the abstract `ShopOrders` and never reads the orders tables (decision 016).
 *
 * Side effects: none; reads `orders`, `services` and `service_listings` (never cached: the order status is shown as it is, decision 022).
 *
 * @see GET /store/v1/me/orders
 */
@Injectable()
export class ShopOrderReads extends ShopOrders {
  /**
   * Lists the account's store orders.
   *
   * @param db the database or a transaction
   * @param accountId the signed-in account
   * @param query the parsed list request (a `status` filter, sorts `createdAt` or `totalPrice`)
   * @returns the page and the exact total
   */
  listShopOrders(
    db: DbExecutor,
    accountId: number,
    query: ParsedListQuery<'createdAt' | 'totalPrice'>,
  ): Promise<ShopOrderPage> {
    return listShopOrderRows(db, accountId, query);
  }
}
