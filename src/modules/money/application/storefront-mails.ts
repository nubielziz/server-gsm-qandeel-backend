// StorefrontMails: the customer emails of the storefront money flows (feature 16): order received, order completed, order failed, payment failed
// and refund declined. Each one is written through the notification delivery (decision 033) in the transaction of the change it reports.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { NotificationService } from '../../platform';
import type { Payment, Refund } from '../db/schema';
import { amountText } from '../domain/b2c-money';
import { loadOrderFacts } from '../infra/b2c-reads.repository';
import { loadBillingCustomers } from '../infra/foreign-directory.repository';
import { findPaymentOfOrder } from '../infra/order-payment.repository';
import { findCurrencyByCode } from '../infra/storefront-money.repository';

/** What a mail calls a customer who gave no name (a guest checkout): "Hi there,". */
const NAMELESS = 'there';

/**
 * Writes the emails a storefront customer gets about an order, a payment or a refund.
 *
 * Why: brief 16 and brief 12a ("storefront customer mails (14a, 16)"): the registry has the events `order.received`, `order.completed`,
 * `order.failed` and `payment.failed` (the console's Customer emails tab) and 16 adds `refund.declined`. Every method calls
 * `NotificationService.enqueue` on the caller's transaction, so the message exists if and only if the change it reports was committed (a
 * rolled-back capture, payment update, transition or decline leaves no message). The recipient's address and language are the customer's
 * (`customers.email`, `customers.locale`; the template of that language, else the English one); a customer who is gone, or an event with no
 * template (or a switched-off one), makes no message and no error. `device` is empty: the TAC catalogue is the catalog module's and has no
 * reader here yet.
 *
 * Side effects: each method inserts one `notifications` row and one `notification.send` outbox row (or none, see above) on the caller's transaction.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class StorefrontMails {
  constructor(private readonly notifications: NotificationService) {}

  /**
   * `order.received`: a payment was captured and the order placed.
   *
   * @param tx the capture's transaction
   * @param input the order and what the customer paid (the payment's amount and currency)
   */
  async orderReceived(tx: DbExecutor, input: { orderId: number; amount: string; currency: string }): Promise<void> {
    const order = (await loadOrderFacts(tx, [input.orderId])).get(input.orderId);
    if (!order?.customerId) return;
    await this.send(tx, order.customerId, 'order.received', `order.received:${input.orderId}`, {
      orderId: orderLabel(input.orderId),
      amount: await this.shown(tx, input.amount, input.currency),
      service: order.serviceName,
      device: '',
    });
  }

  /**
   * `order.completed`: a storefront order was delivered.
   *
   * @param tx the transition's (or the capture's) transaction
   * @param input the order and how many times it was completed, this one included (a reopened order is completed again and tells the customer again)
   */
  async orderCompleted(tx: DbExecutor, input: { orderId: number; completions: number }): Promise<void> {
    const order = (await loadOrderFacts(tx, [input.orderId])).get(input.orderId);
    if (!order?.customerId) return;
    await this.send(tx, order.customerId, 'order.completed', `order.completed:${input.orderId}:${input.completions}`, {
      orderId: orderLabel(input.orderId),
      service: order.serviceName,
      device: '',
    });
  }

  /**
   * `order.failed`: a storefront order was rejected and its money went back.
   *
   * Why: the amount is what the payment of the order was for, in the customer's currency. An order without a payment on record (feature 5's
   * journal-only refund) has nothing to tell the customer, so no mail.
   *
   * @param tx the transition's (or the refund approval's) transaction
   * @param orderId the order
   */
  async orderFailed(tx: DbExecutor, orderId: number): Promise<void> {
    const order = (await loadOrderFacts(tx, [orderId])).get(orderId);
    const payment = order?.customerId ? await findPaymentOfOrder(tx, orderId) : undefined;
    if (!order?.customerId || !payment) return;
    await this.send(tx, order.customerId, 'order.failed', `order.failed:${orderId}`, {
      orderId: orderLabel(orderId),
      amount: await this.shown(tx, payment.amount, payment.currency),
      service: order.serviceName,
      device: '',
    });
  }

  /**
   * `payment.failed`: the gateway said a storefront payment failed.
   *
   * @param tx the webhook's transaction
   * @param payment the payment that was just marked failed
   */
  async paymentFailed(
    tx: DbExecutor,
    payment: Pick<Payment, 'id' | 'customerId' | 'amount' | 'currency'>,
  ): Promise<void> {
    if (payment.customerId === null) return;
    await this.send(tx, payment.customerId, 'payment.failed', `payment.failed:${payment.id}`, {
      amount: await this.shown(tx, payment.amount, payment.currency),
    });
  }

  /**
   * `refund.declined`: staff declined a refund request.
   *
   * @param tx the decline's transaction
   * @param refund the refund that was just declined
   * @param reason the sentence staff wrote for the customer
   */
  async refundDeclined(
    tx: DbExecutor,
    refund: Pick<Refund, 'id' | 'customerId' | 'orderId' | 'amount' | 'currency'>,
    reason: string,
  ): Promise<void> {
    if (refund.customerId === null) return;
    await this.send(tx, refund.customerId, 'refund.declined', `refund.declined:${refund.id}`, {
      orderId: orderLabel(refund.orderId ?? 0),
      amount: await this.shown(tx, refund.amount, refund.currency),
      reason,
    });
  }

  /** Writes one email to a customer (the name is filled in here, the rest is the caller's). */
  private async send(
    tx: DbExecutor,
    customerId: number,
    event: string,
    dedupeKey: string,
    variables: Record<string, string>,
  ): Promise<void> {
    const customer = (await loadBillingCustomers(tx, [customerId])).get(customerId);
    if (!customer) return;
    await this.notifications.enqueue(
      { tx },
      {
        event,
        recipient: { type: 'customer', id: customerId },
        channel: 'email',
        variables: { customerName: customer.name.trim() || NAMELESS, ...variables },
        dedupeKey,
      },
    );
  }

  /** An amount as the customer's currency shows it. */
  private async shown(tx: DbExecutor, amount: string, currency: string): Promise<string> {
    const decimals = (await findCurrencyByCode(tx, currency))?.decimals ?? 2;
    return amountText(amount, currency, decimals);
  }
}

/** The order number the customer sees (`SF-20431`). */
function orderLabel(id: number): string {
  return `SF-${id}`;
}
