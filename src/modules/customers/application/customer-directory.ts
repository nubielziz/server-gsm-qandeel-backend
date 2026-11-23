// CustomerDirectory: the public service other modules use to find or make a guest customer (decision 016). The support module calls it
// when a visitor writes from the contact page (feature 17), so no other module inserts into `customers`. It also answers what other
// modules may know about the customer behind a storefront order link (whether the link speaks for that customer, whether the customer was
// anonymized, whom the order's receipt names); its module fills the slots of orders and money with those answers at boot (decision 032).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { DbExecutor } from '../../../infra/db';
import type { ReceiptBuyer, ReceiptBuyerPort } from '../../money';
import type { TrackingCustomerPort } from '../../orders';
import { findSessionOfOrder, insertGuestCustomer } from '../infra/checkout.repository';
import { findCustomerByEmail, findCustomerById } from '../infra/customer.repository';

/** A customer as other modules may know them: who they are and whether they can still be written to. */
export interface CustomerRef {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly status: string;
}

/**
 * What a storefront order's tracking link says about who holds it.
 *
 * - `speaks-for-customer`: the account itself opened the checkout signed in, or the customer has no account: the holder is that customer.
 * - `unconfirmed`: a guest checkout opened with the address of an account: anyone could have typed it, so the link proves nothing about
 *   the account holder.
 * - `erased`: the customer was anonymized (or is gone): the link opens nothing.
 */
export type OrderLinkStanding = 'speaks-for-customer' | 'unconfirmed' | 'erased';

/**
 * Finds or makes the customer behind an email address.
 *
 * Why: a visitor who writes from the contact page has no account and may never have bought: the ticket needs somebody to belong to and
 * the reply email needs an address, so the visitor becomes a guest customer exactly as a guest checkout does (14a). The customers module
 * owns `customers`; the support module asks this class (decision 016). It holds no connection: the caller passes its transaction.
 *
 * The storefront order links: a guest checkout can be opened with any address, an account's included, and its order is filed under the
 * customer of that address, so holding the order's tracking link proves who is writing only when the account itself opened the checkout
 * signed in (`checkout_sessions.opened_signed_in`) or the customer has no account. The support module asks before it counts a ticket as
 * the customer's (decision 053); the receipt names the account's stored name on the same condition; the links of an anonymized customer
 * open nothing. Orders and money cannot import this module, so `CustomerDirectoryModule` registers the directory in their slots
 * (`TrackingCustomerPorts`, `ReceiptBuyerPorts`) when it starts.
 *
 * Side effects: may insert a guest `customers` row. Time comes from the injected clock (decision 031).
 */
@Injectable()
export class CustomerDirectory implements TrackingCustomerPort, ReceiptBuyerPort {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * Tells what a storefront order's tracking link says about who holds it.
   *
   * Why: decision 053 counts the order link as proof of the requester of a ticket. A guest checkout typed with an account's address puts
   * the order under that account, so the link is proof only when the account opened the checkout signed in, or the customer has no
   * account; an anonymized customer's link opens nothing.
   *
   * @param db the database or the caller's transaction
   * @param order the order the link names and its customer
   * @returns the standing of the link ({@link OrderLinkStanding})
   */
  async orderLinkStanding(
    db: DbExecutor,
    order: { readonly id: number; readonly customerId: number },
  ): Promise<OrderLinkStanding> {
    const customer = await findCustomerById(db, order.customerId);
    if (!customer || customer.status === 'anonymized') return 'erased';
    const checkout = await findSessionOfOrder(db, order.id);
    if (checkout?.openedSignedIn === true && checkout.customerId === customer.id) return 'speaks-for-customer';
    return customer.hasAccount ? 'unconfirmed' : 'speaks-for-customer';
  }

  /**
   * Tells whether a customer is anonymized or gone.
   *
   * Why: after the erasure, the tracking link of the customer's orders answers as an unknown link (`TrackingCustomerPorts`).
   *
   * @param db the database or the caller's transaction
   * @param customerId the customer
   * @returns true when the customer was anonymized or no longer exists
   */
  async isErased(db: DbExecutor, customerId: number): Promise<boolean> {
    const customer = await findCustomerById(db, customerId);
    return !customer || customer.status === 'anonymized';
  }

  /**
   * Says whom the receipt of a storefront order names.
   *
   * Why: the receipt is handed to whoever holds the order's tracking link (`ReceiptBuyerPorts`). It prints the account's stored name
   * and address only when the account itself opened the checkout signed in; any other checkout prints the address it was opened with and
   * no stored name.
   *
   * @param db the database or the caller's transaction
   * @param orderId the order of the receipt
   * @returns the name (empty for no stored name) and address, or `undefined` for an order without a checkout
   */
  async buyerOf(db: DbExecutor, orderId: number): Promise<ReceiptBuyer | undefined> {
    const checkout = await findSessionOfOrder(db, orderId);
    if (!checkout) return undefined;
    if (checkout.openedSignedIn && checkout.customerId !== null) {
      const account = await findCustomerById(db, checkout.customerId);
      if (account) return { name: account.name, email: account.email };
    }
    return { name: '', email: checkout.email };
  }

  /**
   * Returns the customer of an email, making a guest customer when nobody used the address yet.
   *
   * Two requests for one new address race to the unique index on `lower(email)`: the loser inserts nothing (`ON CONFLICT DO NOTHING`) and
   * reads the winner's row, so both end with the same customer.
   *
   * @param tx the caller's transaction
   * @param guest the normalised (trimmed, lower-case) email and the name the visitor typed (may be empty; an existing customer keeps theirs)
   * @returns the existing customer, or the new guest
   */
  async findOrCreateGuest(
    tx: DbExecutor,
    guest: { readonly email: string; readonly name: string },
  ): Promise<CustomerRef> {
    const existing = await findCustomerByEmail(tx, guest.email);
    if (existing) return toRef(existing);
    const now = this.clock.now();
    const created = await insertGuestCustomer(tx, {
      email: guest.email,
      name: guest.name,
      hasAccount: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    if (created) return toRef(created);
    const raced = await findCustomerByEmail(tx, guest.email);
    if (!raced) throw new Error('A guest customer was neither created nor found.');
    return toRef(raced);
  }
}

const toRef = (row: { id: number; name: string; email: string; status: string }): CustomerRef => ({
  id: row.id,
  name: row.name,
  email: row.email,
  status: row.status,
});
