// CustomerDirectory: what other modules may know about the account behind a shop order link (decision 016, decision 064). It tells whether
// the link speaks for that account, whether the account was anonymized and whom the order's receipt names; its module fills the slots of
// orders and money with those answers at boot (decision 032). It reads `clients` by account id; making a guest row is the
// identity module's `AccountDirectory`, never this class.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import type { ReceiptBuyer, ReceiptBuyerPort } from '../../money';
import type { TrackingCustomerPort } from '../../orders';
import { findCustomerById, findCheckoutOfOrder } from '../infra/customer.repository';

/**
 * What a shop order's tracking link says about who holds it.
 *
 * - `speaks-for-customer`: the account itself opened the checkout signed in, or the buyer row has no login (a guest): the holder is that
 *   buyer.
 * - `unconfirmed`: a checkout of a login account that it did not open itself (an order placed before decision 064 by a guest checkout
 *   typed with the address of an account): anyone could have typed the address, so the link proves nothing about the account holder.
 * - `erased`: the account was anonymized (or is gone): the link opens nothing.
 */
export type OrderLinkStanding = 'speaks-for-customer' | 'unconfirmed' | 'erased';

/**
 * Answers the questions the orders, support and money modules ask about the buyer of a shop order.
 *
 * Why: a guest checkout never attaches to a login account any more: its order belongs to the guest row of the typed address. Holding
 * the order's tracking link proves who is writing only when the account itself opened the checkout signed in (`checkout_sessions.opened_signed_in`)
 * or the buyer row has no login. The support module asks before it counts a ticket as the buyer's (decision 053); the receipt names the
 * stored name only on the same condition; the links of an anonymized account open nothing. Orders and money cannot import this module, so
 * `CustomerDirectoryModule` registers the directory in their slots (`TrackingCustomerPorts`, `ReceiptBuyerPorts`) when it starts.
 *
 * Side effects: none; it only reads `clients` and `checkout_sessions`.
 */
@Injectable()
export class CustomerDirectory implements TrackingCustomerPort, ReceiptBuyerPort {
  /**
   * Tells what a shop order's tracking link says about who holds it.
   *
   * Why: decision 053 counts the order link as proof of the requester of a ticket. Under decision 064 an order of a login account was
   * placed signed in, except the orders placed before it by a guest checkout typed with the account's address; an anonymized account's
   * link opens nothing.
   *
   * @param db the database or the caller's transaction
   * @param order the order the link names and its buyer (`customerId` holds the account id; the name is the port's, kept until the
   *   orders module renames it)
   * @returns the standing of the link ({@link OrderLinkStanding})
   */
  async orderLinkStanding(
    db: DbExecutor,
    order: { readonly id: number; readonly customerId: number },
  ): Promise<OrderLinkStanding> {
    const account = await findCustomerById(db, order.customerId);
    if (!account || account.status === 'anonymized') return 'erased';
    const checkout = await findCheckoutOfOrder(db, order.id);
    if (checkout?.openedSignedIn === true && checkout.accountId === account.id) return 'speaks-for-customer';
    return account.hasAccount ? 'unconfirmed' : 'speaks-for-customer';
  }

  /**
   * Tells whether an account is anonymized or gone.
   *
   * Why: after the erasure, the tracking link of the account's orders answers as an unknown link (`TrackingCustomerPorts`).
   *
   * @param db the database or the caller's transaction
   * @param customerId the buyer account of the order
   * @returns true when the account was anonymized or no longer exists
   */
  async isErased(db: DbExecutor, customerId: number): Promise<boolean> {
    const account = await findCustomerById(db, customerId);
    return !account || account.status === 'anonymized';
  }

  /**
   * Says whom the receipt of a shop order names.
   *
   * Why: the receipt is handed to whoever holds the order's tracking link (`ReceiptBuyerPorts`). It prints the account's stored name and
   * address only when the account itself opened the checkout signed in; any other checkout prints the address it was opened with and no
   * stored name.
   *
   * @param db the database or the caller's transaction
   * @param orderId the order of the receipt
   * @returns the name (empty for no stored name) and address, or `undefined` for an order without a checkout
   */
  async buyerOf(db: DbExecutor, orderId: number): Promise<ReceiptBuyer | undefined> {
    const checkout = await findCheckoutOfOrder(db, orderId);
    if (!checkout) return undefined;
    if (checkout.openedSignedIn && checkout.accountId !== null) {
      const account = await findCustomerById(db, checkout.accountId);
      if (account) return { name: account.name, email: account.email };
    }
    return { name: '', email: checkout.email };
  }
}
