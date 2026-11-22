// The status of the payment that paid a storefront order, for the order engine: the orders module may not read `payments`, so it asks the
// money module (decision 016).
import type { DbExecutor } from '../../../infra/db';
import type { Payment } from '../db/schema';
import { findPaymentOfOrder } from '../infra/order-payment.repository';

/**
 * Reads the status of the payment that paid a storefront order.
 *
 * Why: a storefront order is released from a risk hold or sent to a supplier only while its payment stands: a payment that is disputed,
 * charged back or refunded in full stops it (the order engine decides what that means). The payment is the one of the order's first
 * receipt, as for a refund. A plain read without a lock: a dispute recorded after it counts like one that arrives after the send.
 *
 * Side effects: none (reads only; never cached, a payment status used for a decision is read from Postgres).
 *
 * @param db the database or the caller's transaction
 * @param orderId the order
 * @returns the status of the captured payment that paid the order (`captured`, `partial_refund`, `refunded`, `disputed` or
 *   `chargeback`), or `undefined` when the order has none (a merchant's order)
 */
export async function orderPaymentStatus(db: DbExecutor, orderId: number): Promise<Payment['status'] | undefined> {
  return (await findPaymentOfOrder(db, orderId))?.status;
}
