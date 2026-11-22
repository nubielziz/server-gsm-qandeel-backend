// DisputeWebhookService: handles a verified dispute event from a gateway (map route POST /webhooks/disputes/:gateway, scenario
// b2c-chargeback steps 1, 2 and 6). The signature, the 5-minute window and the replay filter ran in the guard.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor, pgErrorInfo } from '../../../infra/db';
import { ErrorReporter } from '../../../infra/observability';
import { DEFAULT_EVIDENCE_DAYS, DISPUTE_RETRY_HOURS, disputeNote, heldDisputeNote } from '../domain/dispute-rules';
import { paymentRef } from '../domain/invoice-rules';
import { loadSessionMoney } from '../infra/b2c-reads.repository';
import { wireUsd } from '../domain/b2c-money';
import { wholeCents } from '../domain/refund-rules';
import { findDisputeByGatewayId, insertDisputeOnce, lockDispute } from '../infra/dispute.repository';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGatewayByCode } from '../infra/gateway.repository';
import { lockOrderPayment, updateOrderPaymentIn } from '../infra/order-payment.repository';
import { findPaymentByReference, lockTopupPayment, updatePayment } from '../infra/payment.repository';
import type { DisputeEvent } from '../infra/gateway-drivers/driver';
import type { PaymentGateway } from '../db/schema';
import { CustomerWallets } from './customer-wallets';
import { DisputeLedger, topUpDisputeHold, topUpOwnerOf } from './dispute-ledger';
import { StorefrontOrderPorts } from './storefront-ports';

/** SQLSTATE `40P01` (deadlock detected) and `40001` (serialization failure): the database ended the transaction, nothing was written. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '40001']);

/** What the route answers. */
export interface DisputeWebhookOutcome {
  readonly received: true;
  readonly duplicate?: boolean;
}

/**
 * Records the disputes gateways report.
 *
 * Why: RESOLUTIONS money-5 and scenario b2c-chargeback: `created` opens the dispute once (the unique `(payment_id, gateway_dispute_id)`
 * makes a repeated or racing delivery create one) with the gateway's evidence deadline, marks the payment `disputed` and the order's
 * timeline; `won` and `lost` close it, a loss posting the one chargeback journal (shared with the staff's accept, so whichever comes second
 * posts nothing). An event of a type the driver ignores is acknowledged with `200`. Decision 048: an event that names a payment not
 * recorded yet, a payment held for staff (it has no order), or a closed dispute whose opening was not recorded yet answers
 * `503 UNAVAILABLE` (nothing is written), so the gateway delivers it again and it is applied once the payment or the opening is recorded;
 * once the event is {@link DISPUTE_RETRY_HOURS} hours old (by its own time; an event without one at once) it is acknowledged with `200`,
 * logged at error level and reported, and a held payment's review note says it was disputed. A `won` event for a dispute staff accepted
 * as lost changes nothing and is logged at error level (the books keep the loss). A delivery whose transaction the database ended because
 * it met another change at the same moment (a deadlock or a serialization failure: the loss takes the payment, then its refunds; the refund
 * settlement takes a refund, then its payment) wrote nothing and answers `503 UNAVAILABLE`, so the gateway delivers it again (a 5xx also
 * frees the event's replay mark). The alert to staff about the deadline (scenario step 3)
 * is the notifications feature's (12a): it belongs right after a `created` dispute is stored. A dispute of a top-up payment (feature 21,
 * customers and merchants: defect D4) takes its own branch: `created` records it and freezes a customer's wallet; `lost` claws the credit back (`DisputeLedger.loseTopUp`); `won` closes it
 * and leaves the hold for staff (plan P2). The payment keeps `approved`, and the dispute never shows in `/admin/disputes` (it has no order).
 *
 * Side effects (one transaction): inserts or updates `disputes`, updates `payments`, writes a ledger transaction on a loss, adds an
 * order timeline line; for a customer's top-up, the wallet's hold, its audit row and the `wallet.frozen` mail.
 *
 * @see docs/contract/endpoints/money.md (POST /webhooks/disputes/:gateway)
 */
@Injectable()
export class DisputeWebhookService {
  private readonly logger = new Logger(DisputeWebhookService.name);

  constructor(
    private readonly db: DbService,
    private readonly ledger: DisputeLedger,
    private readonly wallets: CustomerWallets,
    private readonly ports: StorefrontOrderPorts,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly reporter?: ErrorReporter,
  ) {}

  /**
   * Handles one verified delivery.
   *
   * @param gatewayCode the `:gateway` of the URL (already verified by the guard)
   * @param body the parsed JSON body
   * @returns `{ received: true }`, with `duplicate: true` when the event changed nothing because it was handled before
   * @throws {AppError} `UNAVAILABLE` (503) for an event younger than {@link DISPUTE_RETRY_HOURS} hours that names a payment not recorded
   *   yet, a payment held for staff, or a dispute whose opening was not recorded yet (decision 048), and for a delivery the database ended
   *   because it met another change at the same moment (nothing written)
   */
  async handle(gatewayCode: string, body: unknown): Promise<DisputeWebhookOutcome> {
    const gateway = await findGatewayByCode(this.db.db, gatewayCode);
    const event = gateway ? driverFor(gateway.driver)?.parseDispute?.(body) : undefined;
    if (!gateway || !event) return { received: true };

    try {
      return await this.apply(gateway, event);
    } catch (error) {
      const code = pgErrorInfo(error)?.code;
      if (code === undefined || !RETRYABLE_SQLSTATES.has(code)) throw error;
      // The transaction was rolled back: a 5xx asks the gateway for the event again (a 409 would keep the replay mark).
      this.logger.warn(
        `Gateway ${gateway.code}: dispute ${event.reference} met another change at the same moment; asking for it again.`,
      );
      throw new AppError('UNAVAILABLE', {
        detail: 'This dispute event met another change at the same moment. Deliver the event again.',
        cause: error,
      });
    }
  }

  /** Applies one parsed dispute event in one transaction (see {@link handle}). */
  private apply(gateway: PaymentGateway, event: DisputeEvent): Promise<DisputeWebhookOutcome> {
    return this.db.runInTransaction(async ({ tx }) => {
      // Any purpose: a top-up can be disputed as well as an order payment (feature 21).
      const found = await findPaymentByReference(tx, gateway.id, event.paymentReference);
      const notRecorded = {
        subject: `Gateway ${gateway.code}: dispute ${event.reference} names a payment that is not recorded yet`,
        detail: 'This dispute names a payment that is not recorded yet. Deliver the event again later.',
      };
      if (!found || (found.purpose !== 'order' && found.purpose !== 'topup')) return this.notYet(event, notRecorded);
      if (found.purpose === 'topup') return this.handleTopUp(tx, gateway, event, found.id);
      const payment = await lockOrderPayment(tx, found.id);
      if (!payment) return this.notYet(event, notRecorded);
      const now = this.clock.now();
      if (payment.orderId === null) {
        // A held payment has no order for the dispute (decision 048): asked for again, then noted on the payment for staff.
        const held = payment.status === 'pending' && payment.reviewRequired;
        const outcome = this.notYet(event, {
          subject: `Gateway ${gateway.code}: dispute ${event.reference} names ${paymentRef(payment.id)}, which ${held ? 'is held for staff' : 'has no order'}`,
          detail: 'This dispute names a payment that has no order. Deliver the event again later.',
          level: 'error',
        });
        const note = heldDisputeNote(event.reference, event.kind);
        if (held && !(payment.reviewNote ?? '').includes(note)) {
          await updateOrderPaymentIn(tx, payment.id, ['pending'], {
            reviewNote: payment.reviewNote ? `${payment.reviewNote} ${note}` : note,
            updatedAt: now,
          });
        }
        return outcome;
      }
      const system = { type: 'system' as const, id: null };

      if (event.kind === 'created') {
        const session =
          payment.orderId === null ? undefined : (await loadSessionMoney(tx, [payment.orderId])).get(payment.orderId);
        const created = await insertDisputeOnce(tx, {
          paymentId: payment.id,
          orderId: payment.orderId,
          customerId: payment.customerId,
          gatewayDisputeId: event.reference,
          reasonCode: event.reasonCode,
          amount: event.amount ?? payment.amount,
          currency: event.currency ?? payment.currency,
          fee: event.fee ?? '0',
          status: 'needs_response',
          evidenceDueAt: event.evidenceDueAt ?? new Date(now.getTime() + DEFAULT_EVIDENCE_DAYS * 86_400_000),
          createdAt: now,
          updatedAt: now,
        });
        if (!created) return { received: true, duplicate: true } as const;
        await updateOrderPaymentIn(tx, payment.id, ['captured', 'partial_refund', 'refunded'], {
          status: 'disputed',
          updatedAt: now,
        });
        if (payment.orderId !== null) {
          // The same USD figure the dispute list shows: the whole payment is exactly what the checkout locked.
          const usd = wireUsd(
            Money.of(created.amount),
            session ? { amount: payment.amount, grossUsd: session.grossAmount } : undefined,
            session?.fxRate ?? '1',
          );
          await this.ports.get().addTimeline(tx, payment.orderId, system, {
            type: 'dispute',
            message: `Dispute opened for $${wholeCents(usd)}: ${disputeNote(event.reasonCode)} Evidence due ${created.evidenceDueAt.toISOString().slice(0, 10)}.`,
            data: { disputeId: created.id },
          });
        }
        return { received: true } as const;
      }

      const known = await findDisputeByGatewayId(tx, payment.id, event.reference);
      const dispute = known ? await lockDispute(tx, known.id) : undefined;
      if (!dispute) {
        return this.notYet(event, {
          subject: `Gateway ${gateway.code}: dispute ${event.reference} was closed before it was opened here`,
          detail: 'This dispute was not opened here yet. Deliver the event again later.',
        });
      }
      if (event.kind === 'won' && dispute.status === 'lost') {
        // Staff accepted the loss (or the gateway reported it first): the books keep the chargeback; staff decide what to do.
        this.logger.error(
          `Dispute DP-${dispute.id} was reported won after it was closed as lost: the chargeback stays booked; staff review.`,
        );
        return { received: true, duplicate: true } as const;
      }
      if (event.kind === 'lost') {
        // A loss accepted by staff already posted: only the first report moves the dispute.
        if (dispute.status === 'lost') return { received: true, duplicate: true } as const;
        if (dispute.status === 'won') return { received: true, duplicate: true } as const;
        const lost = await this.ledger.lose(tx, dispute, payment, system);
        if (lost.orderId !== null) {
          await this.ports.get().addTimeline(tx, lost.orderId, system, {
            type: 'dispute',
            message: 'Dispute lost: the amount and the dispute fee were taken by the card network',
            data: { disputeId: lost.id },
          });
        }
        return { received: true } as const;
      }
      const won = await this.ledger.win(tx, dispute, payment);
      if (!won) return { received: true, duplicate: true } as const;
      if (won.orderId !== null) {
        await this.ports.get().addTimeline(tx, won.orderId, system, {
          type: 'dispute',
          message: 'Dispute won',
          data: { disputeId: won.id },
        });
      }
      return { received: true } as const;
    });
  }

  /**
   * Answers a dispute event that names what is not recorded here yet (decision 048).
   *
   * Why: while the event is younger than {@link DISPUTE_RETRY_HOURS} hours (by its own time) the gateway is asked to deliver it again
   * (`503`, nothing written), so it is applied once the payment or the opening is recorded; an older event, or one that does not say when
   * it was made, is acknowledged, logged at error level and reported, so it does not fail for days.
   *
   * @param event the dispute event
   * @param what the log subject, the problem detail of the `503` and the log level while it is asked for again (default `warn`)
   * @returns `{ received: true }` for an event that is acknowledged
   * @throws {AppError} `UNAVAILABLE` (503) while the event is young
   */
  private notYet(
    event: DisputeEvent,
    what: { subject: string; detail: string; level?: 'warn' | 'error' },
  ): DisputeWebhookOutcome {
    const at = event.occurredAt ?? null;
    const young = at !== null && this.clock.nowMs() - at.getTime() < DISPUTE_RETRY_HOURS * 3_600_000;
    if (young) {
      const text = `${what.subject}; asking for it again.`;
      if (what.level === 'error') this.logger.error(text);
      else this.logger.warn(text);
      throw new AppError('UNAVAILABLE', { detail: what.detail });
    }
    this.logger.error(`${what.subject}, and it is no longer asked for again: acknowledged for staff review.`);
    this.reporter?.capture(new Error(`A dispute event could not be applied: ${what.subject}.`), {
      process: 'api',
      route: 'POST /webhooks/disputes/:gateway',
      code: 'DISPUTE_NOT_APPLIED',
    });
    return { received: true };
  }

  /**
   * The top-up branch (plan 21 § 5.6.9). Lock order: the payment, then the dispute, then the ledger (a loss) or the wallet row (a hold
   * without a posting after it).
   */
  private async handleTopUp(
    tx: DbExecutor,
    gateway: PaymentGateway,
    event: DisputeEvent,
    paymentId: number,
  ): Promise<DisputeWebhookOutcome> {
    const payment = await lockTopupPayment(tx, paymentId);
    if (!payment) return { received: true };
    const now = this.clock.now();
    const owner = await topUpOwnerOf(tx, payment);
    if (event.kind === 'created') {
      const created = await insertDisputeOnce(tx, {
        paymentId: payment.id,
        orderId: null,
        customerId: owner?.type === 'customer' ? owner.id : null,
        gatewayDisputeId: event.reference,
        reasonCode: event.reasonCode,
        amount: event.amount ?? payment.amount,
        currency: event.currency ?? payment.currency,
        fee: event.fee ?? '0',
        status: 'needs_response',
        evidenceDueAt: event.evidenceDueAt ?? new Date(now.getTime() + DEFAULT_EVIDENCE_DAYS * 86_400_000),
        createdAt: now,
        updatedAt: now,
      });
      if (!created) return { received: true, duplicate: true };
      if (payment.status === 'pending') {
        // Not credited yet: the automatic credit must not run while the money is disputed; staff decide after the dispute.
        await updatePayment(tx, payment.id, {
          reviewRequired: true,
          autoCreditAt: null,
          reviewNote: `Disputed (DP-${created.id}) before it was credited: decide after the dispute.`,
          updatedAt: now,
        });
      }
      // O11: the customer's balance is held at once (paying from it and card top-ups stop); a merchant's wallet has no hold.
      if (owner?.type === 'customer') {
        await this.wallets.freezeInTx(tx, owner.id, topUpDisputeHold(created.id, payment.id));
      }
      return { received: true };
    }
    const known = await findDisputeByGatewayId(tx, payment.id, event.reference);
    const dispute = known ? await lockDispute(tx, known.id) : undefined;
    if (!dispute) {
      return this.notYet(event, {
        subject: `Gateway ${gateway.code}: top-up dispute ${event.reference} was closed before it was opened here`,
        detail: 'This dispute was not opened here yet. Deliver the event again later.',
      });
    }
    if (dispute.status === 'lost' || dispute.status === 'won') return { received: true, duplicate: true };
    if (event.kind === 'lost') {
      await this.ledger.loseTopUp(tx, dispute, payment, owner);
      return { received: true };
    }
    const won = await this.ledger.winTopUp(tx, dispute);
    return won ? { received: true } : { received: true, duplicate: true };
  }
}
