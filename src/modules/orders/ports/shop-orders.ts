// The seam to the orders of the shop's own account page (decision 064). Declared here; the orders module implements it.
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import type { OrderStatus } from '../db/schema';

/** One of an account's shop orders as the account's own list shows it. */
export interface ShopOrderRow {
  readonly id: number;
  readonly status: OrderStatus;
  readonly serviceId: number;
  /** The title the service is published under, or its catalog name when it has no listing. */
  readonly serviceName: string;
  readonly imei: string | null;
  readonly quantity: number;
  readonly totalPrice: string;
  readonly taxAmount: string;
  readonly currency: string;
  /** The tracking token as issued: only orders placed before the tokens were sealed, until the seal pass empties it. */
  readonly publicToken: string | null;
  /** The tracking token's encrypted copy. */
  readonly publicTokenEnc: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/** A page of shop orders and the exact total. */
export interface ShopOrderPage {
  readonly rows: ShopOrderRow[];
  readonly total: number;
}

/**
 * Lists an account's own shop orders.
 *
 * Why: `GET /store/v1/me/orders` shows the account the orders it placed through the shop (the `store` door), newest first. The account id
 * comes from the session, never from the request, so no account can read another's orders; the account controller of the customers module
 * depends on this class and never reads the orders tables itself.
 *
 * Side effects (of the implementation): none; reads `orders`, `services` and the service listing.
 *
 * @see GET /store/v1/me/orders
 */
export abstract class ShopOrders {
  /**
   * Lists the account's shop orders.
   *
   * @param db the database or a transaction
   * @param accountId the signed-in account
   * @param query the parsed list request (a `status` filter, sorts `createdAt` or `totalPrice`)
   * @returns the page and the exact total
   */
  abstract listShopOrders(
    db: DbExecutor,
    accountId: number,
    query: ParsedListQuery<'createdAt' | 'totalPrice'>,
  ): Promise<ShopOrderPage>;
}
