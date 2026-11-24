// StorefrontMails: the customer emails of the storefront money flows (feature 16): order received, order completed, order failed, payment failed
// and refund declined. Each one is written through the notification delivery (decision 033) in the transaction of the change it reports.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { AccountDirectory } from '../../identity';
import { NotificationService } from '../../platform';
import type { Payment, Refund } from '../db/schema';
import { amountText, isShopOrder } from '../domain/b2c-money';
import { walletKindOfRank } from '../domain/wallet-kinds';
import { loadOrderFacts, loadSessionMoney } from '../infra/b2c-reads.repository';
import { loadBillingMerchants } from '../infra/foreign-directory.repository';
import { findPaymentOfOrder } from '../infra/order-payment.repository';
import { findCurrencyByCode } from '../infra/storefront-money.repository';
import { CustomerWalletMails } from './customer-wallet-mails';

/** What a mail calls a customer who gave no name (a guest checkout): "Hi there,". */
const NAMELESS = 'there';

/**
 * Writes the emails a storefront customer gets about an order, a payment or a refund.
 *
 * Why: brief 16 and brief 12a ("storefront customer mails (14a, 16)"): the registry has the events `order.received`, `order.completed`,
 * `order.failed` and `payment.failed` (the console's Customer emails tab) and 16 adds `refund.declined`. Every method calls
 * `NotificationService.enqueue` on the caller's transaction, so the message exists if and only if the change it reports was committed (a
 * rolled-back capture, payment update, transition or decline leaves no message). The recipient is the buyer account of the order (a guest
 * row for a guest checkout; its address is the account's email) and the text is the event's one template (decision 039); an account that is
 * gone, or an event with no template (or a switched-off one), makes no message and no error. The text follows the order's door, never the
 * buyer's rank now (decision 064): only a shop order gets these mails; a merchant order has its own merchant notices. A wallet mail
 * follows the wallet kind: the store-balance refund mail is written only when the refund went to the store balance, because the merchant
 * wallet has no such text (no new events in this release). `device` is empty: the TAC catalogue is the catalog module's and has no
 * reader here yet.
 *
 * Side effects: each method inserts one `notifications` row and one `notification.send` outbox row (or none, see above) on the caller's transaction.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class StorefrontMails {
  constructor(
    private readonly notifications: NotificationService,
    private readonly wallet: CustomerWalletMails,
    private readonly accounts: AccountDirectory,
  ) {}

  /**
   * `order.received`: a payment was captured and the order placed.
   *
   * @param tx the capture's transaction
   * @param input the order and what the customer paid (the payment's amount and currency)
   */
  async orderReceived(tx: DbExecutor, input: { orderId: number; amount: string; currency: string }): Promise<void> {
    const order = (await loadOrderFacts(tx, [input.orderId])).get(input.orderId);
    if (!order || !isShopOrder(order)) return;
    await this.send(tx, order.accountId, 'order.received', `order.received:${input.orderId}`, {
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
    if (!order || !isShopOrder(order)) return;
    await this.send(tx, order.accountId, 'order.completed', `order.completed:${input.orderId}:${input.completions}`, {
      orderId: orderLabel(input.orderId),
      service: order.serviceName,
      device: '',
    });
  }

  /**
   * `order.failed`: a storefront order was rejected and its money went back.
   *
   * Why: the amount is what the payment of the order was for, in the customer's currency. An order without a payment on record (feature 5's
   * journal-only refund) has nothing to tell the customer, so no mail. An order paid from the store balance got its money back on the
   * balance, not "to your card": the customer gets `wallet.order_refunded` with the USD the session locked instead (plan 21 § 5.6.7); when
   * the account holds a merchant rank by now the money went to its merchant wallet, which has no such text, so no mail is written.
   *
   * @param tx the transition's (or the refund approval's) transaction
   * @param orderId the order
   */
  async orderFailed(tx: DbExecutor, orderId: number): Promise<void> {
    const order = (await loadOrderFacts(tx, [orderId])).get(orderId);
    const payment = order && isShopOrder(order) ? await findPaymentOfOrder(tx, orderId) : undefined;
    if (!order || !payment) return;
    if (payment.methodType === 'balance') {
      if (!(await this.storeBalanceIsLive(tx, order.accountId))) return;
      // A rejected order goes back in full: everything the session locked (an undelivered order is never partly refunded).
      const session = (await loadSessionMoney(tx, [orderId])).get(orderId);
      await this.wallet.orderRefunded(tx, {
        customerId: order.accountId,
        orderId,
        amount: session?.grossAmount ?? payment.amount,
        service: order.serviceName,
        occurrence: `order:${orderId}`,
      });
      return;
    }
    await this.send(tx, order.accountId, 'order.failed', `order.failed:${orderId}`, {
      orderId: orderLabel(orderId),
      amount: await this.shown(tx, payment.amount, payment.currency),
      service: order.serviceName,
      device: '',
    });
  }

  /**
   * `wallet.order_refunded`: staff refunded a delivered order that was paid from the store balance, back to the balance.
   *
   * Why: plan 21 § 5.6.7: the money is on the balance the moment the refund is approved; the customer is told how much and for which order.
   * Only when the refund went to the store balance (the account holds a retail rank): after a change to a merchant rank it went to the
   * merchant wallet and this text would be wrong.
   *
   * @param tx the approval's transaction
   * @param input the order, the refund and the USD that went back
   */
  async refundedToBalance(tx: DbExecutor, input: { orderId: number; refundId: number; amount: string }): Promise<void> {
    const order = (await loadOrderFacts(tx, [input.orderId])).get(input.orderId);
    if (!order || !isShopOrder(order) || !(await this.storeBalanceIsLive(tx, order.accountId))) return;
    await this.wallet.orderRefunded(tx, {
      customerId: order.accountId,
      orderId: input.orderId,
      amount: input.amount,
      service: order.serviceName,
      occurrence: `refund:${input.refundId}`,
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
    payment: Pick<Payment, 'id' | 'accountId' | 'amount' | 'currency'>,
  ): Promise<void> {
    await this.send(tx, payment.accountId, 'payment.failed', `payment.failed:${payment.id}`, {
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
    refund: Pick<Refund, 'id' | 'accountId' | 'orderId' | 'amount' | 'currency'>,
    reason: string,
  ): Promise<void> {
    // A refund without a payment (the retired merchant rows) names no account and has nobody to tell.
    if (refund.accountId === null) return;
    await this.send(tx, refund.accountId, 'refund.declined', `refund.declined:${refund.id}`, {
      orderId: orderLabel(refund.orderId ?? 0),
      amount: await this.shown(tx, refund.amount, refund.currency),
      reason,
    });
  }

  /**
   * Tells whether the account's live wallet is the store balance (it holds a retail rank now).
   *
   * Why: a refund goes back to the live wallet (decision 064) and the refund posting already took the account row `FOR KEY SHARE` in this
   * transaction, so the rank read here is the one the refund used.
   */
  private async storeBalanceIsLive(tx: DbExecutor, accountId: number): Promise<boolean> {
    const account = await this.accounts.findById(tx, accountId);
    return account !== undefined && walletKindOfRank(account.rankKind) === 'customer_wallet';
  }

  /** Writes one email to the buyer account (the name is filled in here, the rest is the caller's). */
  private async send(
    tx: DbExecutor,
    accountId: number,
    event: string,
    dedupeKey: string,
    variables: Record<string, string>,
  ): Promise<void> {
    const account = (await loadBillingMerchants(tx, [accountId])).get(accountId);
    if (!account) return;
    await this.notifications.enqueue(
      { tx },
      {
        event,
        recipient: { type: 'account', id: accountId },
        channel: 'email',
        // Every mail here is about a shop order, its payment or its refund: the customer text, whatever the account's rank is now.
        audience: 'customer',
        variables: { customerName: account.name.trim() || NAMELESS, ...variables },
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
