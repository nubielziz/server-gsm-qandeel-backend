// PaymentWebhookService: handles a verified payment confirmation from a gateway (map route POST /webhooks/payments/:gateway):
// records the payment once and schedules its automatic credit, or (a storefront payment) checks it with the gateway's own record and
// hands it to the capture (decision 048). The signature, the 5-minute window and the replay filter ran in the guard.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Counter } from 'prom-client';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { OutboundHttp } from '../../../infra/http';
import { MetricsService } from '../../../infra/metrics';
import { ErrorReporter } from '../../../infra/observability';
import { SettingsReader } from '../../platform';
import { DisputeWebhookService } from './dispute-webhook.service';
import { GatewayCredentialsVault } from './gateway-credentials';
import { RefundSettlement } from './refund-settlement';
import { StorefrontMails } from './storefront-mails';
import { StorefrontCaptures } from './storefront-ports';
import type { NewPayment, PaymentGateway } from '../db/schema';
import { topupMethodOf } from '../domain/gateway-rules';
import { GATEWAY_CHECK_GIVE_UP_HOURS } from '../domain/b2c-money';
import { paymentRef } from '../domain/invoice-rules';
import {
  AUTO_CREDIT_DELAY_BOUNDS,
  AUTO_CREDIT_DELAY_KEY,
  DEFAULT_AUTO_CREDIT_DELAY_MINUTES,
  autoCreditAtOf,
  closedInvoiceNote,
  confirmationMismatch,
} from '../domain/payment-rules';
import {
  GATEWAY_HTTP_POLICY,
  type GatewayHttpPolicy,
  type PaymentCheck,
  type PaymentDetails,
  type PaymentEvent,
  type PaymentGatewayDriver,
} from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findOrderPayment, lockOrderPayment, updateOrderPaymentIn } from '../infra/order-payment.repository';
import { findGatewayByCode } from '../infra/gateway.repository';
import { findInvoiceByNumber } from '../infra/invoice.repository';
import { findPaymentByReference, insertPaymentOnce } from '../infra/payment.repository';

/** The review note of a card top-up whose card details the gateway did not give (plan 24C § 2.4). */
export const CARD_DETAILS_UNAVAILABLE_NOTE = 'Card details could not be read from the gateway.';

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
 * unknown invoice, an invoice that belongs to another gateway) is acknowledged with `200` so the gateway stops retrying, and logged.
 * A confirmation whose amount or currency differs from the invoice, or does not say them (decision 048), is recorded for staff review
 * instead of automatic credit, and it can never be approved: the payment keeps the invoice's amount and fee (the quote), so crediting
 * re-reads the stored event and refuses it (409), and staff reject it and adjust the wallet by hand. A confirmation for an invoice that
 * is `paid` or `void` is recorded for staff review the same way and is never credited (decision 048).
 *
 * Storefront payments (decision 048): before the capture's transaction the gateway's own record of the payment is read
 * (`verifyPayment`, a short timeout); its card details are the payment's. A record that cannot be read answers `502 GATEWAY_ERROR`, so
 * the gateway delivers the event again, until the confirmation is {@link GATEWAY_CHECK_GIVE_UP_HOURS} hours old: then the payment is held
 * for staff. The capture holds a payment whose record does not say paid, says another amount, currency or checkout, shows the money
 * refunded or disputed since, or whose confirmation cannot pay its checkout, and sends the money back when it can; a payment made after the checkout's price lock and its grace is not
 * used at the old price. A held payment is logged at error level and reported to the error reporter.
 *
 * Feature 24C: a top-up confirmation of a driver that reads card details (Stripe: the PaymentIntent's latest Charge) reads them first,
 * outside any transaction, with a short timeout; when the read fails the payment is still recorded, marked "details unavailable" (staff
 * review for a card top-up). A dispute event delivered here (one Stripe endpoint for every event) goes to the dispute handler, which is
 * idempotent per gateway dispute id, so the same dispute on both URLs is recorded once.
 *
 * Side effects: inserts a `payments` row; a storefront payment that fails sends the customer a `payment.failed` email (written in the same
 * transaction); a captured storefront payment also runs the capture (order, journals, receipt invoice and the
 * `receipt.render` event that makes the worker draw and store its PDF), all in the webhook's one transaction; a held one may open a
 * refund without an order and its `refund.process` event. A confirmation calls the gateway once (the storefront record, or the card
 * details of a top-up) and a top-up counts `gateway_card_details_unavailable_total{gateway}` when that fails.
 *
 * @see docs/contract/endpoints/money.md (POST /webhooks/payments/:gateway)
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);
  private readonly detailsUnavailable: Counter<'gateway'>;

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsReader,
    private readonly captures: StorefrontCaptures,
    private readonly refunds: RefundSettlement,
    private readonly mails: StorefrontMails,
    private readonly disputes: DisputeWebhookService,
    private readonly vault: GatewayCredentialsVault,
    private readonly http: OutboundHttp,
    @Inject(CLOCK) private readonly clock: Clock,
    metrics: MetricsService,
    @Optional() @Inject(GATEWAY_HTTP_POLICY) private readonly policy?: GatewayHttpPolicy,
    @Optional() private readonly reporter?: ErrorReporter,
  ) {
    this.detailsUnavailable = new Counter({
      name: 'gateway_card_details_unavailable_total',
      help: 'Confirmed card payments whose card details the gateway did not give (error or timeout), by gateway code.',
      labelNames: ['gateway'],
      registers: [metrics.registry],
    });
  }

  /**
   * Handles one verified delivery.
   *
   * @param gatewayCode the `:gateway` of the URL (already verified by the guard)
   * @param body the parsed JSON body
   * @returns `{ received: true }`, with `duplicate: true` when the confirmation was recorded before
   * @throws {AppError} `GATEWAY_ERROR` (502) when the record of a storefront payment cannot be read yet (the gateway delivers again);
   *   `UNAVAILABLE` (503) from the dispute handler for a dispute event that names what is not recorded yet
   */
  async handle(gatewayCode: string, body: unknown): Promise<WebhookOutcome> {
    const gateway = await findGatewayByCode(this.db.db, gatewayCode);
    const driver = gateway ? driverFor(gateway.driver) : undefined;
    if (!gateway || !driver) return { received: true };
    // A refund result (feature 16): `refund.updated` with a final status or `refund.failed` settles the storefront refund it names, once.
    const refundEvent = driver.parseRefund?.(body);
    if (refundEvent) {
      await this.refunds.handleEvent(gateway.id, refundEvent);
      return { received: true };
    }
    // A dispute event (24C): the owner may register one endpoint for every event, so a chargeback sent here is never dropped.
    if (driver.parseDispute?.(body)) return this.disputes.handle(gatewayCode, body);
    const parsed = driver.parse(body);
    if (!parsed) return { received: true };
    // A storefront checkout names its payment (`PAY-<id>`, the reference the pay call gave the gateway), not an invoice.
    const storefrontPaymentId = storefrontPaymentOf(parsed.invoiceNumber);
    if (storefrontPaymentId !== undefined) return this.handleStorefront(gateway, driver, parsed, storefrontPaymentId);
    // Read before any transaction: the call waits on the gateway and must never hold a row lock.
    const event = await this.withDetails(gateway, driver, parsed);
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
      // A top-up of a merchant wallet or (feature 21) of a store balance, of an account of either rank; a receipt or a statement names no
      // wallet and never takes a confirmation.
      const fillsWallet = invoice !== undefined && invoice.walletKind !== null;
      if (!invoice || !fillsWallet || invoice.kind === 'receipt' || invoice.gatewayId !== gateway.id) {
        this.logger.warn(`Gateway ${gateway.code}: confirmation ${event.reference} names no invoice of this gateway.`);
        return { received: true } as const;
      }
      // An invoice that is no longer open is never credited, but the money the gateway confirmed is recorded for staff (decision 048).
      const closed = invoice.status !== 'open';
      const now = this.clock.now();
      const methodType = topupMethodOf(driver.id === 'crypto' ? 'crypto' : gateway.driver, false);
      // A card top-up whose card the gateway did not show cannot be screened (blocklist, fingerprint): staff review it instead (24C).
      const notes = [
        closed ? closedInvoiceNote(invoice.number, invoice.status) : undefined,
        confirmationMismatch(event, invoice),
        methodType === 'card' && event.details?.unavailable === true ? CARD_DETAILS_UNAVAILABLE_NOTE : undefined,
      ].filter((note): note is string => note !== undefined);
      const mismatch = notes.length === 0 ? undefined : notes.join(' ');
      const row: NewPayment = {
        purpose: 'topup',
        invoiceId: invoice.id,
        accountId: invoice.accountId,
        gatewayId: gateway.id,
        gatewayTxnId: event.reference,
        cardFingerprint: event.details?.fingerprint ?? null,
        amount: invoice.amount,
        feeAmount: invoice.fee,
        currency: invoice.currency,
        status: 'pending',
        methodType,
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
      if (closed) {
        this.logger.warn(
          `Payment ${paymentRef(created.id)} recorded for ${invoice.number}, which is ${invoice.status}: staff review.`,
        );
        return { received: true } as const;
      }
      this.logger.log(
        `Payment ${paymentRef(created.id)} recorded for ${invoice.number} (${mismatch ? 'review' : 'auto credit'}).`,
      );
      return { received: true } as const;
    });
  }

  /**
   * Adds the card details of a top-up confirmation from the gateway, when its driver reads them.
   *
   * Why: plan 24C § 2.4: never throws (the money arrived, the payment must be recorded); an error or a timeout marks the details
   * unavailable, logs a warning (no card data) and counts it. A storefront payment's details come from its gateway check instead
   * (decision 048).
   */
  private async withDetails(
    gateway: PaymentGateway,
    driver: PaymentGatewayDriver,
    event: PaymentEvent,
  ): Promise<PaymentEvent> {
    if (event.kind !== 'confirmed' || !driver.paymentDetails) return event;
    let details: PaymentDetails | undefined;
    try {
      details = await driver.paymentDetails(
        { http: this.http, policy: this.policy },
        this.vault.read(gateway),
        event.reference,
      );
    } catch (error) {
      const why = error instanceof AppError ? (error.detail ?? error.message) : 'unexpected error';
      this.logger.warn(`Gateway ${gateway.code}: the card details of ${event.reference} could not be read (${why}).`);
      this.detailsUnavailable.inc({ gateway: gateway.code });
      details = { unavailable: true };
    }
    return details === undefined ? event : { ...event, details };
  }

  /**
   * Reads the gateway's own record of a storefront confirmation, before any transaction.
   *
   * Why: decision 048: the capture is decided on the record, not on the event alone. The read is made only when it can matter (a
   * confirmation of a payment of this gateway that is still `pending` or `failed`). A record that cannot be read asks the gateway to
   * deliver the event again (`502`, the replay mark is released), until the confirmation is {@link GATEWAY_CHECK_GIVE_UP_HOURS} hours old
   * (its own time, else when the payment opened): then the check is `unverified` and the capture holds the payment for staff.
   *
   * @returns the record, an `unverified` check, or `undefined` when no read is needed or the driver cannot check
   * @throws {AppError} `GATEWAY_ERROR` (502) when the record cannot be read yet
   */
  private async checkStorefront(
    gateway: PaymentGateway,
    driver: PaymentGatewayDriver,
    event: PaymentEvent,
    paymentId: number,
  ): Promise<PaymentCheck | undefined> {
    if (event.kind !== 'confirmed' || !driver.verifyPayment) return undefined;
    const payment = await findOrderPayment(this.db.db, paymentId);
    if (!payment || payment.gatewayId !== gateway.id) return undefined;
    if (payment.status !== 'pending' && payment.status !== 'failed') return undefined;
    try {
      return await driver.verifyPayment(
        { http: this.http, policy: this.policy },
        this.vault.read(gateway),
        event.reference,
      );
    } catch (error) {
      const since = (event.occurredAt ?? payment.createdAt).getTime();
      if (this.clock.nowMs() - since >= GATEWAY_CHECK_GIVE_UP_HOURS * 3_600_000) {
        return { status: 'unverified', amount: null, currency: null, paidAt: null, belongsTo: null };
      }
      const why = error instanceof AppError ? (error.detail ?? error.message) : 'unexpected error';
      this.logger.warn(
        `Gateway ${gateway.code}: ${paymentRef(paymentId)} could not be checked with the gateway (${why}); it will deliver the event again.`,
      );
      throw new AppError('GATEWAY_ERROR', {
        detail: 'The payment gateway could not confirm this payment yet. Deliver the event again later.',
        cause: error,
      });
    }
  }

  /**
   * Handles the confirmation, failure or progress of a storefront payment.
   *
   * Why: scenario b2c-paid step 6: only a confirmation captures (the order is created then, in this transaction, by the customers module);
   * a failed or expired checkout marks the pending payment `failed`; progress is acknowledged. The payment row is locked first and only a
   * `pending` or `failed` payment captures (a confirmation is money received, even after the payment was written off), so a repeated
   * confirmation (or two racing) captures once. Decision 048: the gateway's record is read first ({@link checkStorefront}) and handed to
   * the capture; a payment held for staff is money that arrived, so a later failure event never marks it failed or mails the buyer.
   */
  private async handleStorefront(
    gateway: PaymentGateway,
    driver: PaymentGatewayDriver,
    parsed: PaymentEvent,
    paymentId: number,
  ): Promise<WebhookOutcome> {
    const check = await this.checkStorefront(gateway, driver, parsed, paymentId);
    // The record's card details are the payment's (decision 048): the capture screens and stores them.
    const event = check?.details === undefined ? parsed : { ...parsed, details: check.details };
    const { answer, held } = await this.db.runInTransaction(
      async ({ tx }): Promise<{ answer: WebhookOutcome; held?: string | undefined }> => {
        const payment = await lockOrderPayment(tx, paymentId);
        if (!payment || payment.gatewayId !== gateway.id) {
          this.logger.warn(
            `Gateway ${gateway.code}: ${event.invoiceNumber} names no storefront payment of this gateway.`,
          );
          return { answer: { received: true } };
        }
        if (event.kind === 'pending') return { answer: { received: true } };
        if (event.kind === 'failed') {
          // Only a pending payment that is not held fails; a captured or held one keeps its status (money that arrived is never undone).
          if (payment.status !== 'pending' || payment.reviewRequired) {
            return { answer: { received: true, duplicate: true } };
          }
          const failed = await updateOrderPaymentIn(tx, payment.id, ['pending'], {
            status: 'failed',
            raw: event.raw,
            updatedAt: this.clock.now(),
          });
          // The customer is told in the same transaction, so a payment that is not marked failed sends nothing.
          if (failed) await this.mails.paymentFailed(tx, failed);
          return { answer: { received: true } };
        }
        // A confirmation means the money arrived. A `failed` payment is captured too (a crypto checkout that expired and was paid late, or
        // a page that was handed out for a payment that had been written off): answering it as a duplicate would keep the money with no
        // order, no refund and no hold.
        if (payment.status !== 'pending' && payment.status !== 'failed') {
          return { answer: { received: true, duplicate: true } };
        }
        if (payment.status === 'failed') {
          this.logger.warn(`Storefront payment ${paymentRef(payment.id)} was confirmed after it failed: capturing it.`);
        }
        const outcome = await this.captures.get().capture(tx, { payment, gateway, event, check });
        this.logger.log(`Storefront payment ${paymentRef(payment.id)} ${outcome.result}.`);
        if (outcome.result !== 'held') return { answer: { received: true } };
        // A hold without a note changed nothing (the payment's money is already being sent back).
        return outcome.reason === undefined
          ? { answer: { received: true, duplicate: true } }
          : { answer: { received: true }, held: outcome.reason };
      },
    );
    if (held !== undefined) {
      this.logger.error(`Storefront payment ${paymentRef(paymentId)} is held for staff: ${held}`);
      this.reporter?.capture(new Error(`A storefront payment is held for staff: ${held}`), {
        process: 'api',
        route: 'POST /webhooks/payments/:gateway',
        code: 'PAYMENT_HELD',
      });
    }
    return answer;
  }
}

/** The payment id of a storefront reference (`PAY-12`), or `undefined` for anything else (an invoice number). */
function storefrontPaymentOf(reference: string): number | undefined {
  const match = /^PAY-([1-9]\d{0,15})$/.exec(reference);
  return match ? Number(match[1]) : undefined;
}
