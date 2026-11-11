// CustomerWalletMails: the customer emails of the store balance (feature 21, plan § 5.8): top-up credited or rejected, balance adjusted, put on
// hold, order refunded to the balance. Each one is written through the notification delivery in the transaction of the change it reports.
import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { NotificationService } from '../../platform';
import { BASE_CURRENCY } from '../domain/accounts';
import { amountText } from '../domain/b2c-money';
import { paymentRef } from '../domain/invoice-rules';
import { findWalletCustomer } from '../infra/foreign-directory.repository';
import {
  WALLET_ADJUSTED_EVENT,
  WALLET_FROZEN_EVENT,
  WALLET_ORDER_REFUNDED_EVENT,
  WALLET_TOPUP_CREDITED_EVENT,
  WALLET_TOPUP_REJECTED_EVENT,
} from './customer-wallet-notifications';

/** What a mail calls a customer who gave no name: "Hi there,". */
const NAMELESS = 'there';

/** A USD amount as the wallet emails show it (`50.00 USD`). */
function usd(amount: string | Money): string {
  return amountText(Money.of(amount).toWire(), BASE_CURRENCY, 2);
}

/**
 * Writes the emails a storefront customer gets about their store balance.
 *
 * Why: plan 21 § 5.8: the customer is told whenever money reaches, leaves or is held on the balance. Every method calls
 * `NotificationService.enqueue` on the caller's transaction, so the message exists if and only if the change was committed; the dedupe key
 * makes a repeated call (a webhook or job retry) write one message. An anonymized customer or one without an email gets nothing.
 *
 * Side effects: each method inserts one `notifications` row and one `notification.send` outbox row (or none, see above).
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class CustomerWalletMails {
  constructor(private readonly notifications: NotificationService) {}

  /**
   * `wallet.topup_credited`: a top-up reached the balance.
   *
   * @param tx the credit's transaction
   * @param input the customer, the payment, the net credited and the balance after it
   */
  async topUpCredited(
    tx: DbExecutor,
    input: { customerId: number; paymentId: number; amount: string; balance: string },
  ): Promise<void> {
    await this.send(
      tx,
      input.customerId,
      WALLET_TOPUP_CREDITED_EVENT,
      `${WALLET_TOPUP_CREDITED_EVENT}:${input.paymentId}`,
      {
        amount: usd(input.amount),
        balance: usd(input.balance),
        reference: paymentRef(input.paymentId),
      },
    );
  }

  /**
   * `wallet.topup_rejected`: staff rejected a top-up.
   *
   * @param tx the rejection's transaction
   * @param input the customer, the payment, what was paid and the reason staff wrote
   */
  async topUpRejected(
    tx: DbExecutor,
    input: { customerId: number; paymentId: number; amount: string; reason: string },
  ): Promise<void> {
    await this.send(
      tx,
      input.customerId,
      WALLET_TOPUP_REJECTED_EVENT,
      `${WALLET_TOPUP_REJECTED_EVENT}:${input.paymentId}`,
      {
        amount: usd(input.amount),
        reason: input.reason,
        reference: paymentRef(input.paymentId),
      },
    );
  }

  /**
   * `wallet.adjusted`: staff changed the balance by hand.
   *
   * @param tx the adjustment's transaction
   * @param input the customer, the journal, the signed change and the balance after it
   */
  async adjusted(
    tx: DbExecutor,
    input: {
      customerId: number;
      transactionId: number;
      amount: string;
      direction: 'credit' | 'debit';
      balance: string;
    },
  ): Promise<void> {
    const sign = input.direction === 'credit' ? '+' : '-';
    await this.send(tx, input.customerId, WALLET_ADJUSTED_EVENT, `${WALLET_ADJUSTED_EVENT}:${input.transactionId}`, {
      change: `${sign}${usd(input.amount)}`,
      balance: usd(input.balance),
    });
  }

  /**
   * `wallet.frozen`: paying from the balance was put on hold.
   *
   * @param tx the freeze's transaction
   * @param input the customer and the freeze time (the dedupe key: one message per freeze)
   */
  async frozen(tx: DbExecutor, input: { customerId: number; frozenAt: Date }): Promise<void> {
    await this.send(
      tx,
      input.customerId,
      WALLET_FROZEN_EVENT,
      `${WALLET_FROZEN_EVENT}:${input.customerId}:${input.frozenAt.getTime()}`,
      {},
    );
  }

  /**
   * `wallet.order_refunded`: an order paid from the balance was refunded to it.
   *
   * @param tx the refund's transaction
   * @param input the customer, the order, the USD returned, the service name and what makes the refund unique (`order:<id>` or `refund:<id>`)
   */
  async orderRefunded(
    tx: DbExecutor,
    input: { customerId: number; orderId: number; amount: string; service: string; occurrence: string },
  ): Promise<void> {
    await this.send(
      tx,
      input.customerId,
      WALLET_ORDER_REFUNDED_EVENT,
      `${WALLET_ORDER_REFUNDED_EVENT}:${input.occurrence}`,
      {
        orderId: `SF-${input.orderId}`,
        amount: usd(input.amount),
        service: input.service,
      },
    );
  }

  /** Writes one email to a customer (the name is filled in here). */
  private async send(
    tx: DbExecutor,
    customerId: number,
    event: string,
    dedupeKey: string,
    variables: Record<string, string>,
  ): Promise<void> {
    const customer = await findWalletCustomer(tx, customerId);
    if (!customer || customer.status === 'anonymized') return;
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
}
