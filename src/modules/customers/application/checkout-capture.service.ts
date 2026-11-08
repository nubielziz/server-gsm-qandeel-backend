// CheckoutCaptureService: turns a confirmed payment into the order (feature 16, scenario b2c-paid steps 6 to 8). The money module calls it
// from the payment webhook's transaction; it places the order, books the payment and marks the checkout paid, all in that one transaction.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { EncryptionService, TokenService } from '../../../infra/crypto';
import {
  type CaptureOutcome,
  type CaptureRequest,
  type StorefrontCapture,
  StorefrontCaptures,
  StorefrontMails,
  StorefrontMoney,
  StorefrontPayments,
  paymentFacts,
  storefrontMismatch,
} from '../../money';
import { CustomerOrderPlacement } from '../../orders';
import { CHECKOUT_IMEI_AAD } from '../domain/checkout';
import { lockCheckoutSession, markSessionPaid } from '../infra/checkout.repository';

/** Reads the string values of a session's stored order inputs. */
function inputsOf(raw: Record<string, unknown> | null): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw ?? {}).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])),
  );
}

/**
 * Creates the order of a paid checkout.
 *
 * Why: scenario b2c-paid step 7: "in one transaction: the payment is captured and the session paid, a new order with `customer_id` and a
 * `public_token`, the capture journal, and the outbox job for dispatch". It runs under the payment row's lock (taken by the webhook), then
 * takes the session's lock: a second confirmation for the same session finds it paid and is recorded and refunded as a duplicate instead
 * of creating a second order. A confirmation that says another amount or currency than the quote creates nothing and waits for staff. An
 * expired but unpaid session is still honoured: the buyer paid the locked price (crypto may confirm after the 30 minutes). The risk
 * hold of feature 18 plugs in at the placement call (`held`). The buyer's `order.received` email (and `order.completed` when stock delivered the
 * order at once) is written in this transaction through the notification delivery (12a); the receipt PDF is a job queued here.
 *
 * Side effects (on the webhook's transaction): everything `CustomerOrderPlacement.place` and `StorefrontPayments.recordCapture` write, the
 * session's `status` and `order_id`, and the customer's email notifications.
 */
@Injectable()
export class CheckoutCaptureService implements StorefrontCapture, OnModuleInit {
  private readonly logger = new Logger(CheckoutCaptureService.name);

  constructor(
    private readonly captures: StorefrontCaptures,
    private readonly placement: CustomerOrderPlacement,
    private readonly payments: StorefrontPayments,
    private readonly money: StorefrontMoney,
    private readonly mails: StorefrontMails,
    private readonly encryption: EncryptionService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Fills the money module's capture slot. */
  onModuleInit(): void {
    this.captures.set(this);
  }

  /**
   * Captures a confirmed payment.
   *
   * @param tx the webhook's transaction
   * @param request the pending payment (locked), its gateway and the event
   * @returns `captured` with the new order, `duplicate` with the existing one, or `held`
   */
  async capture(tx: DbExecutor, request: CaptureRequest): Promise<CaptureOutcome> {
    const { payment, gateway, event } = request;
    const session =
      payment.checkoutSessionId === null ? undefined : await lockCheckoutSession(tx, payment.checkoutSessionId);
    if (!session || session.customerId === null) {
      this.logger.warn(`Payment ${payment.id} was confirmed for a checkout that cannot be found: held.`);
      await this.payments.hold(tx, payment.id, 'The checkout of this payment cannot be found.', event);
      return { result: 'held', orderId: null };
    }
    const mismatch = storefrontMismatch(event, payment);
    if (mismatch !== undefined) {
      this.logger.warn(`Payment ${payment.id}: ${mismatch}`);
      await this.payments.hold(tx, payment.id, mismatch, event);
      return { result: 'held', orderId: null };
    }
    const decimals = (await this.money.byCode(tx, session.currency))?.decimals ?? 2;
    const captured = {
      currency: session.currency,
      fxRate: session.fxRate,
      taxRate: session.taxRate,
      taxCountry: session.taxCountry,
      decimals,
    };
    if (session.orderId !== null) {
      await this.payments.recordDuplicate(tx, { payment, gateway, event, orderId: session.orderId, session: captured });
      return { result: 'duplicate', orderId: session.orderId };
    }
    const facts = paymentFacts(payment.methodType, event.details);
    const imei = session.imeiEnc === null ? undefined : this.encryption.decrypt(session.imeiEnc, CHECKOUT_IMEI_AAD);
    const order = await this.placement.place(
      tx,
      {
        customerId: session.customerId,
        checkoutSessionId: session.id,
        serviceId: session.serviceId,
        quantity: session.quantity,
        imei,
        inputs: inputsOf(session.inputs),
        net: session.netAmount,
        tax: session.taxAmount,
        taxCountry: session.taxCountry,
        publicToken: this.tokens.random(16),
        snapshot: { currency: session.currency, fxRate: session.fxRate, taxRate: session.taxRate },
        paidMessage: `Payment of ${Money.of(payment.amount).toWire()} ${payment.currency} received${facts.brand === '' ? '' : ` (${facts.brand})`}`,
      },
      async (created) => {
        await this.payments.recordCapture(tx, { payment, gateway, event, order: created, session: captured });
      },
    );
    await markSessionPaid(tx, session.id, order.id, this.clock.now());
    // The confirmation email is written with the order, so a capture that rolls back sends nothing. An order delivered from stock is
    // already completed: the buyer is told both.
    await this.mails.orderReceived(tx, { orderId: order.id, amount: payment.amount, currency: payment.currency });
    if (order.status === 'completed') await this.mails.orderCompleted(tx, { orderId: order.id, completions: 1 });
    return { result: 'captured', orderId: order.id };
  }
}
