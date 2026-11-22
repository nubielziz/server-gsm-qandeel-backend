// CustomerWalletPayments: the money side of paying a storefront checkout from the customer's store balance (feature 21, plan § 5.6.6). The
// customers module orchestrates the checkout and calls it inside its transaction; this service records the payment, posts `b2c_wallet_pay`
// and issues the receipt.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { fromUsd } from '../domain/b2c-money';
import { b2cWalletPay } from '../domain/customer-wallet-events';
import { paymentRef } from '../domain/invoice-rules';
import {
  findPaymentByKey,
  insertOrderPayment,
  reservePaymentId,
  updateOrderPayment,
} from '../infra/order-payment.repository';
import { LedgerPoster } from './post-transaction';
import { type CapturedOrder, type CapturedSession, StorefrontPayments } from './storefront-payments';

/** The brand line of a payment from the store balance (the console and the receipt show it). */
export const BALANCE_BRAND = 'Store balance';

/** What `request_fingerprint` holds for a balance payment: a `/pay` call under the same key never matches it. */
const BALANCE_FINGERPRINT = 'balance';

/** A payment from the store balance, as `POST /store/v1/checkout-sessions/:token/balance-payment` answers it. */
export interface BalancePaymentView {
  readonly id: number;
  /** `PAY-<id>`. */
  readonly reference: string;
  /** `captured`, or what refunds and disputes made of it since (a replay answers the payment as it is now). */
  readonly status: string;
  readonly method: 'balance';
  /** The checkout's currency. */
  readonly currency: string;
  /** The gross in the checkout's currency, as the checkout showed it. */
  readonly amount: string;
  /** The gross in USD: what left the balance. */
  readonly amountUsd: string;
}

/** What an earlier call with the same `Idempotency-Key` left on a checkout. */
export type BalancePaymentReplay =
  | {
      readonly kind: 'balance';
      readonly payment: BalancePaymentView;
      readonly orderId: number;
      readonly customerId: number;
    }
  | { readonly kind: 'other' };

/** What recording a balance payment needs from the checkout. */
export interface BalancePaymentInput {
  readonly sessionId: number;
  /** The `Idempotency-Key` of the call. */
  readonly key: string;
  /** The signed-in customer (from the session cookie, never from the checkout row alone). */
  readonly customerId: number;
  /** The order the placement just inserted. */
  readonly order: CapturedOrder;
  /** What the checkout locked. */
  readonly session: CapturedSession;
}

/**
 * Records payments from the customer's store balance.
 *
 * Why: plan 21 § 5.6.6 (R4, R10, K1, K4): the balance pays a checkout the way a card capture does, in one transaction with the order. The
 * payment row (`method_type 'balance'`, no gateway, `captured`, the checkout's currency and gross so every refund path works unchanged) is
 * unique per checkout and per `Idempotency-Key`; the journal `b2c_wallet_pay` (Dr customer_wallet / Cr customer_funds / Cr vat_payable, key
 * `payment:<id>:capture`) is guarded under the wallet's row lock: a balance can never go below zero, so parallel payments never overspend.
 * A frozen wallet is refused from the state read under that same lock. The money then sits in `customer_funds` like after a card capture,
 * so delivery, reopen and refunds do not change.
 *
 * Side effects (on the caller's transaction): one `payments` row, one ledger transaction, one receipt `invoices` row and its
 * `receipt.render` outbox row.
 */
@Injectable()
export class CustomerWalletPayments {
  constructor(
    private readonly poster: LedgerPoster,
    private readonly payments: StorefrontPayments,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * What an earlier call with this `Idempotency-Key` did on the checkout.
   *
   * @param tx the payment's transaction (the checkout row is locked)
   * @param sessionId the checkout
   * @param key the `Idempotency-Key`
   * @param grossUsd the checkout's locked gross in USD (what a balance payment took)
   * @returns the balance payment made under the key, `other` for a `/pay` payment under it, or `undefined`
   */
  async replayOf(
    tx: DbExecutor,
    sessionId: number,
    key: string,
    grossUsd: string,
  ): Promise<BalancePaymentReplay | undefined> {
    const prior = await findPaymentByKey(tx, sessionId, key);
    if (!prior) return undefined;
    if (prior.methodType !== 'balance' || prior.orderId === null || prior.customerId === null) {
      return { kind: 'other' };
    }
    return {
      kind: 'balance',
      orderId: prior.orderId,
      customerId: prior.customerId,
      payment: {
        id: prior.id,
        reference: paymentRef(prior.id),
        status: prior.status,
        method: 'balance',
        currency: prior.currency,
        amount: Money.of(prior.amount).toWire(),
        amountUsd: Money.of(grossUsd).toWire(),
      },
    };
  }

  /**
   * Pays an order that was just placed from the customer's store balance.
   *
   * Why: called from the placement's `onInserted`, so any refusal rolls the order, its stock claim and its assessment back with it. The
   * payment keeps the session's currency and gross (every refund path computes "what is left" in the payment currency); the balance moves
   * the USD the session locked.
   *
   * Side effects: inserts the payment, posts `b2c_wallet_pay` (locks the wallet, `customer_funds` and `vat_payable` in id order), issues the
   * receipt and queues its PDF, all on `tx`.
   *
   * @param tx the checkout's transaction
   * @param input the checkout, the key, the customer, the order and what the session locked
   * @returns the payment as the route answers it
   * @throws {AppError} `INSUFFICIENT_FUNDS` (402) when the balance does not cover the gross; `WALLET_FROZEN` (409) when the wallet is on hold
   */
  async record(tx: DbExecutor, input: BalancePaymentInput): Promise<BalancePaymentView> {
    const { order, session } = input;
    if (order.customerId !== input.customerId) {
      throw new Error(`Order ${order.id} belongs to customer ${order.customerId}, not ${input.customerId}.`);
    }
    const now = this.clock.now();
    const net = Money.of(order.totalPrice);
    const vat = Money.of(order.taxAmount);
    const grossUsd = net.add(vat);
    const shown = fromUsd(grossUsd, session.fxRate, session.decimals);
    const id = await reservePaymentId(tx);
    await insertOrderPayment(tx, {
      id,
      purpose: 'order',
      customerId: input.customerId,
      orderId: order.id,
      checkoutSessionId: input.sessionId,
      idempotencyKey: input.key,
      requestFingerprint: BALANCE_FINGERPRINT,
      gatewayId: null,
      amount: shown.toWire(),
      feeAmount: '0',
      currency: session.currency,
      status: 'captured',
      methodType: 'balance',
      brand: BALANCE_BRAND,
      capturedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const pay = b2cWalletPay({ customerId: input.customerId, net, vat });
    const posted = await this.poster.post(tx, {
      kind: pay.kind,
      refType: pay.refType,
      refId: order.id,
      idempotencyKey: `payment:${id}:capture`,
      currency: 'USD',
      lines: pay.lines,
      memo: `Payment PAY-${id} for SF-${order.id}`,
      createdBy: { type: 'customer', id: input.customerId },
    });
    // The hold is read under the wallet's row lock the posting took (plan § 5.5): a freeze that committed before this payment is seen.
    if (posted.touched.some((account) => account.kind === 'customer_wallet' && account.frozen)) {
      throw new AppError('WALLET_FROZEN', { detail: 'Paying from your store balance is on hold. Contact support.' });
    }

    const invoice = await this.payments.issueReceipt(
      tx,
      { gatewayId: null, order, session, charged: { amount: shown, currency: session.currency } },
      vat,
      now,
    );
    await updateOrderPayment(tx, id, { invoiceId: invoice.id, updatedAt: now });
    return {
      id,
      reference: paymentRef(id),
      status: 'captured',
      method: 'balance',
      currency: session.currency,
      amount: shown.toWire(),
      amountUsd: grossUsd.toWire(),
    };
  }
}
