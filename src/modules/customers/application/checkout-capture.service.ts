// CheckoutCaptureService: turns a confirmed payment into the order (feature 16, scenario b2c-paid steps 6 to 8). The money module calls it
// from the payment webhook's transaction; it places the order, books the payment and marks the checkout paid, all in that one transaction.
// Decision 048: it first checks the gateway's record, the amounts, the reference and the time of the payment, and holds what cannot pay.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { EncryptionService, TokenService } from '../../../infra/crypto';
import { StorefrontServices } from '../../catalog';
import { AccountDirectory } from '../../identity';
import {
  type CaptureOutcome,
  type CaptureRequest,
  LATE_REFUND_REASON,
  type StorefrontCapture,
  StorefrontCaptures,
  StorefrontMails,
  StorefrontMoney,
  StorefrontPayments,
  aftermathNote,
  lateConfirmationSignal,
  minutesLate,
  paymentFacts,
  paymentRef,
  storefrontMismatch,
} from '../../money';
import { CustomerOrderPlacement } from '../../orders';
import { RiskDecisionsService, RiskScreening, holdReason } from '../../risk';
import { CHECKOUT_IMEI_AAD } from '../domain/checkout';
import { mainInputImeisOf } from '../domain/checkout-imeis';
import { findCheckoutSession, lockCheckoutSession, markSessionPaid } from '../infra/checkout.repository';

/** Reads the string values of a session's stored order inputs. */
function inputsOf(raw: Record<string, unknown> | null): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw ?? {}).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])),
  );
}

/**
 * Creates the order of a paid checkout.
 *
 * Why: scenario b2c-paid step 7: "in one transaction: the payment is captured and the session paid, a new order with the buyer account and a
 * `public_token`, the capture journal, and the outbox job for dispatch". It runs under the payment row's lock (taken by the webhook), then
 * takes the session's account row `FOR KEY SHARE` and then the session's lock (decision 064: the account row comes before the rows of
 * the path; it never refuses, so a payment made before a rank change places its shop order whatever the rank is by then, and a rank change
 * waits for the capture or is seen by the `open_checkout` blocker): a second confirmation for the same session finds it paid and is recorded and
 * refunded as a duplicate instead of creating a second order. Decision 048, in this order: a payment whose money is being sent back (or was) changes nothing; a payment
 * whose gateway record belongs to another checkout is held before any other check, with nothing sent back and its reference left free
 * (the record, whatever it says, is that checkout's payment, and its own confirmation must still capture); then a payment whose record
 * shows its money refunded (in full or in part) or disputed since, held with nothing sent back (the money already went back or is
 * contested); then a payment without a checkout, one the gateway's record does not show as paid (or that could not be checked for 24 hours), one the record or the event shows
 * for another amount or currency (or does not say), and one whose gateway reference another payment has, are held for staff
 * (`StorefrontPayments.holdConfirmation`; money that arrived goes back when the gateway can refund). A payment made more than 30 minutes after the checkout's price lock ended (judged on the gateway's time of the payment, else
 * the event's, else when the payment opened) is not used at the old price: its order is placed held with that review reason and is
 * refunded at once when the gateway can refund, else it waits in the risk queue. Every captured
 * payment is screened by the risk rules before the order is placed (RESOLUTIONS orders-suppliers-11; decision 050: the screening gets the
 * card's country and funding from the gateway's record, the visitor's country kept on the checkout, and whether the account itself opened
 * the checkout; decision 076: every IMEI of a main input that is a list, its field of type `imei_bulk`, so an IMEI blocklisted after the
 * checkout opened is caught here as a single one is): `allow` places the order as always;
 * `review` places it `held` (no dispatch, the hold sentence on the timeline) for the Risk page; `block` places it `held` and refunds it at once
 * as the system, so the customer gets the money back and nothing is sent to a supplier. The buyer's `order.received` email (and
 * `order.completed` when stock delivered the order at once) is written in this transaction through the notification delivery (12a), except for
 * a blocked order, whose buyer only hears that the order failed and was refunded; the receipt PDF is a job queued here.
 *
 * Side effects (on the webhook's transaction): everything `CustomerOrderPlacement.place` and `StorefrontPayments.recordCapture` write, the
 * session's `status` and `order_id`, one `risk_assessments` row, the customer's email notifications, and for a blocked or late payment the
 * refund `RiskDecisionsService.refundBlocked` writes; a hold updates the payment and may open a refund without an order.
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
    private readonly risk: RiskScreening,
    private readonly decisions: RiskDecisionsService,
    private readonly accounts: AccountDirectory,
    private readonly encryption: EncryptionService,
    private readonly tokens: TokenService,
    private readonly services: StorefrontServices,
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
   * @param request the pending payment (locked), its gateway, the event and the gateway's record
   * @returns `captured` with the new order, `duplicate` with the existing one, or `held` (with the note, or without one when nothing
   *   changed)
   */
  async capture(tx: DbExecutor, request: CaptureRequest): Promise<CaptureOutcome> {
    const { payment, gateway, event, check } = request;
    // A payment whose money is being sent back, or was, never pays its checkout; nothing changes.
    if (await this.payments.hasReturn(tx, payment.id)) return { result: 'held', orderId: null };
    // Before every other hold: a record that names another checkout is that checkout's payment, so whatever else it says (not paid,
    // another amount) acts on nothing here. Nothing is sent back and its reference stays free, so that checkout's own confirmation still
    // captures. Pages opened before the record carried its reference say nothing (null) and pass.
    if (check?.belongsTo != null && check.belongsTo !== paymentRef(payment.id)) {
      return this.hold(tx, request, "The gateway's record of this payment belongs to another checkout.", false, false);
    }
    // Money that already went back, or is contested, is not a payment to use as quoted; it is never sent back from here, and the money
    // did arrive, so the hold is marked received (decision 048).
    if (check?.afterPayment !== undefined) {
      return this.hold(tx, request, aftermathNote(check.afterPayment), false, true, true);
    }
    // The payment is locked (by the webhook). Next the session's account `FOR KEY SHARE`, then the session row: the account id comes from an
    // unlocked read, and the locked row must still name the same account (it can only change through the guest claim, which never moves
    // a session that is open or has a pending payment).
    const known =
      payment.checkoutSessionId === null ? undefined : await findCheckoutSession(tx, payment.checkoutSessionId);
    const account =
      known === undefined || known.accountId === null
        ? undefined
        : await this.accounts.lockForKeyShare(tx, known.accountId);
    const session = known === undefined || account === undefined ? undefined : await lockCheckoutSession(tx, known.id);
    if (!session || account === undefined || session.accountId !== account.id) {
      return this.hold(tx, request, 'The checkout of this payment cannot be found.', true);
    }
    if (check !== undefined && check.status !== 'confirmed') {
      return this.hold(
        tx,
        request,
        check.status === 'unverified'
          ? 'The gateway could not be asked about this payment for 24 hours.'
          : 'The gateway does not report this payment as paid.',
        false,
      );
    }
    const mismatch =
      (check === undefined ? undefined : storefrontMismatch(check, payment)) ?? storefrontMismatch(event, payment);
    if (mismatch !== undefined) return this.hold(tx, request, mismatch, true);
    const owner = await this.payments.referenceOwner(tx, gateway.id, event.reference);
    if (owner !== undefined && owner !== payment.id) {
      return this.hold(
        tx,
        request,
        'This confirmation names a gateway reference that another payment already has.',
        false,
      );
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
    // Judged on when the buyer paid (the gateway's charge time, else the event's own time, else when the payment opened), never on when
    // the confirmation was processed: a delivery the gateway repeats never makes an on-time payment late (decision 048).
    const late = minutesLate(session.expiresAt, check?.paidAt ?? event.occurredAt ?? payment.createdAt);
    const facts = paymentFacts(payment.methodType, event.details);
    const imei = session.imeiEnc === null ? undefined : this.encryption.decrypt(session.imeiEnc, CHECKOUT_IMEI_AAD);
    // Decision 076: a main input that is a list (its field of type `imei_bulk`) is asked of the blocklist IMEI by IMEI, as the open did.
    const imeis = imei === undefined ? [] : mainInputImeisOf(imei, await this.services.fields(tx, session.serviceId));
    // The rules judge the payment before the order exists; the verdict decides how the order starts. The card fingerprint comes from the
    // event: the payment row only gets it in `recordCapture`.
    const screening = await this.risk.assess(tx, {
      accountId: account.id,
      email: session.email,
      checkoutSessionId: session.id,
      amountUsd: Money.of(session.netAmount).add(Money.of(session.taxAmount)).toWire(),
      paymentMethod: facts.method,
      imei: imei ?? null,
      imeis,
      cardFingerprint: event.details?.fingerprint ?? payment.cardFingerprint,
      cardDetailsMissing: event.details?.unavailable === true,
      country: session.taxCountry,
      ip: session.ip,
      // Decision 050: the card's country and funding, the visitor's country, and whether the account itself opened the checkout.
      ipCountry: session.ipCountry,
      cardCountry: event.details?.country ?? null,
      prepaidCard: event.details?.funding === 'prepaid',
      openedSignedIn: session.openedSignedIn,
      ...(late === undefined ? {} : { reviewReasons: [lateConfirmationSignal(late)] }),
    });
    // A blocked payment is placed held too: the machine refunds only a held order, and the timeline keeps why.
    const held = screening.hold || screening.block;
    const order = await this.placement.place(
      tx,
      {
        accountId: account.id,
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
        ...(held ? { holdReason: screening.holdReason ?? holdReason(screening) } : {}),
      },
      async (created) => {
        await this.payments.recordCapture(tx, { payment, gateway, event, order: created, session: captured });
      },
    );
    await this.risk.linkOrder(tx, screening.assessmentId, order.id);
    await markSessionPaid(tx, session.id, order.id, this.clock.now());
    if (screening.block) {
      await this.decisions.refundBlocked(tx, {
        orderId: order.id,
        assessmentId: screening.assessmentId,
        signals: screening.signals,
      });
      return { result: 'captured', orderId: order.id };
    }
    // Paid after the grace: not used at the old price (decision 048). Refunded at once like a blocked payment when the gateway can refund;
    // otherwise the held order waits in the risk queue for staff.
    if (late !== undefined && this.payments.sendsBack(payment, gateway, event.details)) {
      await this.decisions.refundBlocked(tx, {
        orderId: order.id,
        assessmentId: screening.assessmentId,
        signals: screening.signals,
        reason: LATE_REFUND_REASON,
      });
      return { result: 'captured', orderId: order.id };
    }
    // The confirmation email is written with the order, so a capture that rolls back sends nothing. An order delivered from stock is
    // already completed: the buyer is told both.
    await this.mails.orderReceived(tx, { orderId: order.id, amount: payment.amount, currency: payment.currency });
    if (order.status === 'completed') await this.mails.orderCompleted(tx, { orderId: order.id, completions: 1 });
    return { result: 'captured', orderId: order.id };
  }

  /**
   * Holds the confirmation for staff (decision 048) and says what was stored. `received` (default `sendBack`) marks that the gateway's
   * record showed money received for this payment, so staff can close it only as paid back.
   */
  private async hold(
    tx: DbExecutor,
    request: CaptureRequest,
    reason: string,
    sendBack: boolean,
    keepReference = true,
    received = sendBack,
  ): Promise<CaptureOutcome> {
    const held = await this.payments.holdConfirmation(tx, { ...request, reason, sendBack, received, keepReference });
    this.logger.warn(`Payment ${request.payment.id}: ${held.note}`);
    return { result: 'held', orderId: null, reason: held.note };
  }
}
