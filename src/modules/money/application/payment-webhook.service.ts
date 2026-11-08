// PaymentWebhookService: handles a verified payment confirmation from a gateway (map route POST /webhooks/payments/:gateway):
// records the payment once and schedules its automatic credit. The signature, the 5-minute window and the replay filter ran in the guard.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { SettingsReader } from '../../platform';
import { RefundSettlement } from './refund-settlement';
import { StorefrontMails } from './storefront-mails';
import { StorefrontCaptures } from './storefront-ports';
import type { NewPayment, PaymentGateway } from '../db/schema';
import { topupMethodOf } from '../domain/gateway-rules';
import { paymentRef } from '../domain/invoice-rules';
import {
  AUTO_CREDIT_DELAY_BOUNDS,
  AUTO_CREDIT_DELAY_KEY,
  DEFAULT_AUTO_CREDIT_DELAY_MINUTES,
  autoCreditAtOf,
  confirmationMismatch,
} from '../domain/payment-rules';
import type { PaymentEvent } from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { lockOrderPayment, updateOrderPaymentIn } from '../infra/order-payment.repository';
import { findGatewayByCode } from '../infra/gateway.repository';
import { findInvoiceByNumber } from '../infra/invoice.repository';
import { findPaymentByReference, insertPaymentOnce } from '../infra/payment.repository';

/** What the route answers. */
export interface WebhookOutcome {
  readonly received: true;
  readonly duplicate?: boolean;
}

/**
 * Records the payments gateways confirm.
 *
 * Why: user rule 6 and RESOLUTIONS money-3: a signed confirmation of a top-up creates the payment as `pending` with
 * `captured_at` = now and `auto_credit_at` = captured + max(setting, the gateway's hold hours); the automatic credit job credits it
 * later. The processing is idempotent in Postgres, not in the cache: the unique `(gateway_id, gateway_txn_id)` makes a repeated or
 * racing delivery create one payment (ALIGNMENT § 7). Every event that is not a usable confirmation (a type billing ignores, an
 * unknown invoice, an invoice that is not open or belongs to another gateway) is acknowledged with `200` so the gateway stops
 * retrying, and logged. A confirmation whose amount or currency differs from the invoice is recorded for staff review instead of
 * automatic credit, and it can never be approved: the payment keeps the invoice's amount and fee (the quote), so crediting
 * re-reads the stored event and refuses it (409), and staff reject it and adjust the wallet by hand.
 *
 * Side effects: inserts a `payments` row; a storefront payment that fails sends the customer a `payment.failed` email (written in the same
 * transaction); a captured storefront payment also runs the capture (order, journals, receipt invoice and the
 * `receipt.render` event that makes the worker draw and store its PDF), all in the webhook's one transaction.
 *
 * @see docs/contract/endpoints/money.md (POST /webhooks/payments/:gateway)
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsReader,
    private readonly captures: StorefrontCaptures,
    private readonly refunds: RefundSettlement,
    private readonly mails: StorefrontMails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one verified delivery.
   *
   * @param gatewayCode the `:gateway` of the URL (already verified by the guard)
   * @param body the parsed JSON body
   * @returns `{ received: true }`, with `duplicate: true` when the confirmation was recorded before
   */
  async handle(gatewayCode: string, body: unknown): Promise<WebhookOutcome> {
    const gateway = await findGatewayByCode(this.db.db, gatewayCode);
    const driver = gateway ? driverFor(gateway.driver) : undefined;
    if (!gateway || !driver) return { received: true };
    // A refund result (feature 16): `refund.succeeded` or `refund.failed` settles the storefront refund it names, once.
    const refundEvent = driver.parseRefund?.(body);
    if (refundEvent) {
      await this.refunds.handleEvent(gateway.id, refundEvent);
      return { received: true };
    }
    const event = driver.parse(body);
    if (!event) return { received: true };
    // A storefront checkout names its payment (`PAY-<id>`, the reference the pay call gave the gateway), not an invoice.
    const storefrontPaymentId = storefrontPaymentOf(event.invoiceNumber);
    if (storefrontPaymentId !== undefined) return this.handleStorefront(gateway, event, storefrontPaymentId);
    if (event.kind !== 'confirmed') {
      this.logger.log(
        `Gateway ${gateway.code}: ${event.kind} event for ${event.invoiceNumber} acknowledged, nothing to record.`,
      );
      return { received: true };
    }

    const delay = await this.settings.integer(
      AUTO_CREDIT_DELAY_KEY,
      DEFAULT_AUTO_CREDIT_DELAY_MINUTES,
      AUTO_CREDIT_DELAY_BOUNDS,
    );
    return this.db.runInTransaction(async ({ tx }) => {
      const existing = await findPaymentByReference(tx, gateway.id, event.reference);
      if (existing) return { received: true, duplicate: true } as const;
      const invoice = await findInvoiceByNumber(tx, event.invoiceNumber, true);
      if (!invoice || invoice.clientId === null || invoice.kind === 'receipt' || invoice.gatewayId !== gateway.id) {
        this.logger.warn(`Gateway ${gateway.code}: confirmation ${event.reference} names no invoice of this gateway.`);
        return { received: true } as const;
      }
      if (invoice.status !== 'open') {
        this.logger.warn(
          `Gateway ${gateway.code}: confirmation ${event.reference} for ${invoice.number}, which is ${invoice.status}.`,
        );
        return { received: true } as const;
      }
      const now = this.clock.now();
      const mismatch = confirmationMismatch(event, invoice);
      const row: NewPayment = {
        purpose: 'topup',
        invoiceId: invoice.id,
        gatewayId: gateway.id,
        gatewayTxnId: event.reference,
        amount: invoice.amount,
        feeAmount: invoice.fee,
        currency: invoice.currency,
        status: 'pending',
        methodType: topupMethodOf(driver.id === 'crypto' ? 'crypto' : gateway.driver, false),
        capturedAt: now,
        reviewRequired: mismatch !== undefined,
        autoCreditAt: mismatch === undefined ? autoCreditAtOf(now, delay, gateway.holdHours) : null,
        reviewNote: mismatch ?? null,
        raw: event.raw,
        createdAt: now,
        updatedAt: now,
      };
      const created = await insertPaymentOnce(tx, row);
      if (!created) return { received: true, duplicate: true } as const;
      this.logger.log(
        `Payment ${paymentRef(created.id)} recorded for ${invoice.number} (${mismatch ? 'review' : 'auto credit'}).`,
      );
      return { received: true } as const;
    });
  }

  /**
   * Handles the confirmation, failure or progress of a storefront payment.
   *
   * Why: scenario b2c-paid step 6: only a confirmation captures (the order is created then, in this transaction, by the customers module);
   * a failed or expired checkout marks the pending payment `failed`; progress is acknowledged. The payment row is locked first and only a
   * `pending` or `failed` payment captures (a confirmation is money received, even after the payment was written off), so a repeated
   * confirmation (or two racing) captures once.
   */
  private async handleStorefront(
    gateway: PaymentGateway,
    event: PaymentEvent,
    paymentId: number,
  ): Promise<WebhookOutcome> {
    return this.db.runInTransaction(async ({ tx }) => {
      const payment = await lockOrderPayment(tx, paymentId);
      if (!payment || payment.gatewayId !== gateway.id) {
        this.logger.warn(
          `Gateway ${gateway.code}: ${event.invoiceNumber} names no storefront payment of this gateway.`,
        );
        return { received: true } as const;
      }
      if (event.kind === 'pending') return { received: true } as const;
      if (event.kind === 'failed') {
        // Only a pending payment fails; a captured one keeps its status (a late failure never undoes money that was received).
        if (payment.status !== 'pending') return { received: true, duplicate: true } as const;
        const failed = await updateOrderPaymentIn(tx, payment.id, ['pending'], {
          status: 'failed',
          raw: event.raw,
          updatedAt: this.clock.now(),
        });
        // The customer is told in the same transaction, so a payment that is not marked failed sends nothing.
        if (failed) await this.mails.paymentFailed(tx, failed);
        return { received: true } as const;
      }
      // A confirmation means the money arrived. A `failed` payment is captured too (a crypto checkout that expired and was paid late, or
      // a page that was handed out for a payment that had been written off): answering it as a duplicate would keep the money with no
      // order, no refund and no hold.
      if (payment.status !== 'pending' && payment.status !== 'failed') {
        return { received: true, duplicate: true } as const;
      }
      if (payment.status === 'failed') {
        this.logger.warn(`Storefront payment ${paymentRef(payment.id)} was confirmed after it failed: capturing it.`);
      }
      const outcome = await this.captures.get().capture(tx, { payment, gateway, event });
      this.logger.log(`Storefront payment ${paymentRef(payment.id)} ${outcome.result}.`);
      return { received: true } as const;
    });
  }
}

/** The payment id of a storefront reference (`PAY-12`), or `undefined` for anything else (an invoice number). */
function storefrontPaymentOf(reference: string): number | undefined {
  const match = /^PAY-([1-9]\d{0,15})$/.exec(reference);
  return match ? Number(match[1]) : undefined;
}
