// RefundSettlement: records the gateway's final answer to a storefront refund, whether it came back from the job's call or as a
// `refund.updated` (final status) / `refund.failed` event (scenario b2c-refund step 7). One place, guarded by the refund's `processing` status
// (and, for the success of a send whose failure was not definite, its `failed` status).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import { type DbExecutor, DbService } from '../../../infra/db';
import { toUsd } from '../domain/b2c-money';
import type { Refund } from '../db/schema';
import { CHARGEBACK_NOT_SENT_NOTE, closesAtChargeback, wholeCents } from '../domain/refund-rules';
import { ledgerPartsOf, loadSessionMoney } from '../infra/b2c-reads.repository';
import type { RefundEvent } from '../infra/gateway-drivers/driver';
import { lockOrderPayment } from '../infra/order-payment.repository';
import {
  appendLateRefundFailure,
  failLateReturn,
  findRefund,
  findRefundForGateway,
  lockRefund,
  recordRefusalOfFailedRefund,
} from '../infra/refund.repository';
import { B2cRefunds } from './b2c-refunds';
import { StorefrontOrderPorts } from './storefront-ports';

/** The gateway's final word on a refund. */
export type RefundOutcome =
  | {
      readonly kind: 'completed';
      readonly gatewayRefundId: string | null;
      /**
       * The send attempt (`refunds.send_attempt`) this success belongs to, when known. It completes a refund that is already `failed` only
       * when it is the refund's current attempt: that failure was then not definite (a definite one moves the attempt on). Without it, the
       * success must name another gateway refund than the one a definite failure stored.
       */
      readonly attempt?: number | null;
    }
  | {
      readonly kind: 'failed';
      readonly note: string;
      readonly gatewayRefundId?: string | null;
      /** True when the gateway refused the refund for good: the next send then uses a new idempotency key. */
      readonly definite?: boolean;
      /**
       * The send attempt (`refunds.send_attempt`) this failure belongs to, when known. A failure of an earlier attempt than the refund's
       * current one is stale (a staff retry has sent again since), so it is ignored.
       */
      readonly attempt?: number | null;
      /**
       * True when the send got no answer (a timeout, a 5xx, a lost job): the gateway may have made the refund, so the start of the send is
       * recorded (`refunds.unanswered_send_at`) and the key is not sent again once the gateway may have forgotten it.
       */
      readonly unanswered?: boolean;
      /**
       * True for the give-up of the lost-work reconcile: the job it found lost may still have reached the gateway. A refund whose gateway
       * refund id is stored under its lock is then left as it is: the gateway's own answer settles it.
       */
      readonly lost?: boolean;
    };

/**
 * Settles refunds with what the gateway said.
 *
 * Why: RESOLUTIONS money-5, money-11 and user rule 7: `processing` ends as `completed` (the payment becomes `partial_refund` or
 * `refunded`) or `failed` (with the gateway's text, retryable from the console). The job's own call and the gateway's event can both
 * report the same result, and a delivery can repeat, so only a refund still `processing` moves: the second report changes nothing. A failure
 * the gateway gave for good (`definite`) also moves the refund's idempotency key on, so the staff retry is not answered with the same refusal.
 * That key move is why a failure carries the send attempt it belongs to: a late or repeated `refund.failed` of the first gateway refund must not
 * fail the retry that replaced it (it would move the key again, and the next retry would refund the customer a third time). A failure the
 * gateway reports after the refund completed (plan 24C § 2.3: Stripe can fail a refund it first reported `succeeded`) is not undone: it is
 * written on the refund's note for staff, once, and logged as an error. Decision 048: a return without an order (a held storefront payment
 * sent back) that fails late is marked `failed` again, so the money integrity check lists its payment again. A success is money that moved:
 * the success of a send whose failure was not definite (no answer, a lost job, a payment disputed when it was due) completes the `failed`
 * refund; any other success that meets a refund that is not `processing` changes nothing and is logged as an error. A failure that arrives
 * after the payment was charged back closes the refund unsent and reverses its journal, as the chargeback does for the refunds the gateway
 * has not paid (decision 048), so the books show the money leaving once; for a refund the gateway accepted (its id is stored) only the
 * gateway's own refusal of it does that, since the gateway may still pay it. The gateway's refusal for good of the current send of a refund
 * that failed without a definite answer moves its key on (the refund stays `failed`, the gateway's text is added to its note), so a later
 * success of that send is stale and the retry sends under a new key. The lost-work reconcile's give-up fails only a refund with no gateway
 * refund id stored: a refund the gateway answered meanwhile is the gateway's to settle.
 *
 * Lock order: the payment, then the refund (as an approval and a chargeback take them), then the ledger accounts.
 *
 * Side effects (in its own transaction): updates `refunds` and `payments`, adds a timeline line to the order, and for a failure after a
 * chargeback posts the reversal of the refund's journal (key `reverse:<journal id>`); a late failure appends to `refunds.note` (and moves a
 * return without an order back to `failed`).
 */
@Injectable()
export class RefundSettlement {
  private readonly logger = new Logger(RefundSettlement.name);

  constructor(
    private readonly db: DbService,
    private readonly refunds: B2cRefunds,
    private readonly ports: StorefrontOrderPorts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Records an outcome.
   *
   * @param refundId the refund
   * @param outcome completed (with the gateway's id) or failed (with its text)
   * @returns true when this call moved the refund (or recorded the gateway's refusal for good of the current send of a refund that had
   *   failed without a definite answer); false when it was no longer `processing` (and not completed by a success of a send that failed
   *   without a definite answer), the failure was of an earlier send attempt, the failure was not definite for a refund the gateway
   *   accepted before its payment was charged back, or it was the give-up of a lost send for a refund whose gateway refund id is stored
   */
  async settle(refundId: number, outcome: RefundOutcome): Promise<boolean> {
    return this.db.runInTransaction(async ({ tx }) => {
      // Lock order: the payment, then the refund. The payment's lock also keeps a dispute from changing it between the read of its status
      // below (or in the completion) and the update of it.
      const seen = await findRefund(tx, refundId);
      if (!seen) return false;
      const payment = seen.paymentId === null ? undefined : await lockOrderPayment(tx, seen.paymentId);
      const locked = await lockRefund(tx, refundId);
      if (!locked) return false;
      // The gateway refused for good the send a failure without a definite answer kept the key of: that gateway refund is dead, so the key
      // moves on (guarded by the attempt, so a repeat changes nothing); a later success of that send is then stale.
      if (
        locked.status === 'failed' &&
        outcome.kind === 'failed' &&
        outcome.definite === true &&
        outcome.attempt != null &&
        outcome.attempt === locked.sendAttempt
      ) {
        return this.refusalAfterFailure(tx, locked, outcome);
      }
      if (locked.status !== 'processing') {
        return outcome.kind === 'completed' ? this.lateSuccess(tx, locked, outcome) : false;
      }
      // The give-up of a send found lost: the job may still have reached the gateway, whose answer stored its refund id after the plan.
      // That refund is the gateway's to settle (its refund.updated or refund.failed), so it is left as it is.
      if (outcome.kind === 'failed' && outcome.lost === true && locked.gatewayRefundId !== null) {
        this.logger.warn(
          `Refund ${refundId}: not failed as a lost send; the gateway holds refund ${locked.gatewayRefundId}.`,
        );
        return false;
      }
      // Checked under the lock, so a staff retry cannot slip in between the check and the update. Only a failure is held back: a success
      // is money that really moved, so it completes the refund whichever send it came from.
      if (outcome.kind === 'failed' && outcome.attempt != null && outcome.attempt < locked.sendAttempt) {
        this.logger.warn(
          `Refund ${refundId}: ignored a failure of send attempt ${outcome.attempt}; the refund is on attempt ${locked.sendAttempt}.`,
        );
        return false;
      }
      // The card network already returned the payment: a refund that did not go out is closed and its journal reversed (decision 048), as
      // the chargeback closes it. A refund the gateway accepted (its id is stored) closes only on the gateway's refusal of it: a failure
      // without a definite answer changes nothing, and the gateway's own refund.updated or refund.failed settles it.
      if (outcome.kind === 'failed' && payment?.status === 'chargeback') {
        if (outcome.definite === true || closesAtChargeback(locked)) return this.closeAfterChargeback(tx, locked);
        this.logger.warn(
          `Refund ${refundId}: a failure without a definite answer after the chargeback was not applied (${outcome.note}); the gateway holds refund ${locked.gatewayRefundId}.`,
        );
        return false;
      }
      const done =
        outcome.kind === 'completed'
          ? await this.refunds.complete(tx, refundId, outcome.gatewayRefundId)
          : await this.refunds.fail(
              tx,
              refundId,
              outcome.note,
              outcome.gatewayRefundId ?? null,
              outcome.definite === true,
              outcome.unanswered === true,
            );
      await this.addTimeline(tx, done, outcome);
      return done !== undefined;
    });
  }

  /**
   * Applies a success that meets a refund that is no longer `processing`.
   *
   * Why: a success is money that moved. A `failed` refund whose failure was not definite (the success names its current send attempt, or
   * names no attempt and another gateway refund than the one that failed) is completed; a repeat for a completed refund changes nothing;
   * anything else (a refund closed or declined meanwhile, the success of a send the gateway refused for good) is kept as it is and logged as
   * an error for staff.
   */
  private async lateSuccess(
    tx: DbExecutor,
    locked: Refund,
    outcome: Extract<RefundOutcome, { kind: 'completed' }>,
  ): Promise<boolean> {
    if (locked.status === 'completed') return false;
    const sameSend =
      outcome.attempt == null
        ? outcome.gatewayRefundId !== null && outcome.gatewayRefundId !== locked.gatewayRefundId
        : outcome.attempt === locked.sendAttempt;
    if (locked.status === 'failed' && sameSend) {
      const done = await this.refunds.complete(tx, locked.id, outcome.gatewayRefundId, '', ['failed']);
      if (done) {
        this.logger.error(
          `Refund ${locked.id}: the gateway reported refund ${outcome.gatewayRefundId ?? '(no id)'} succeeded after the refund had failed without a definite answer; the refund is completed.`,
        );
        await this.addTimeline(tx, done, outcome);
      }
      return done !== undefined;
    }
    this.logger.error(
      `Refund ${locked.id}: the gateway reported refund ${outcome.gatewayRefundId ?? '(no id)'} succeeded while the refund is ${locked.status} (send attempt ${locked.sendAttempt}, the success names ${outcome.attempt ?? 'no attempt'}); nothing was changed. Check the payment at the gateway.`,
    );
    return false;
  }

  /**
   * Records the gateway's refusal for good of the current send of a refund that had failed without a definite answer.
   *
   * Why: the refund stays `failed`, but the gateway refund of that send is dead: its key moves on, so a later success of that send cannot
   * complete the refund and the retry sends under a new key (`recordRefusalOfFailedRefund`). The gateway's text is added to the note.
   */
  private async refusalAfterFailure(
    tx: DbExecutor,
    locked: Refund,
    outcome: Extract<RefundOutcome, { kind: 'failed' }>,
  ): Promise<boolean> {
    const now = this.clock.now();
    const gatewayRefundId = outcome.gatewayRefundId ?? null;
    const text = `The gateway reported on ${now.toISOString()} that refund ${gatewayRefundId ?? '(no id)'} failed: ${outcome.note}`;
    const done = await recordRefusalOfFailedRefund(tx, locked.id, locked.sendAttempt, gatewayRefundId, text, now);
    if (done) {
      this.logger.warn(
        `Refund ${locked.id}: the gateway refused send attempt ${locked.sendAttempt} for good after the refund had failed without a definite answer (${outcome.note}); the next send uses a new key.`,
      );
    }
    return done !== undefined;
  }

  /** Closes a refund whose failure arrived after its payment was charged back, with the order's timeline line (decision 048). */
  private async closeAfterChargeback(tx: DbExecutor, locked: Refund): Promise<boolean> {
    const closed = await this.refunds.closeUnsent(tx, locked, { type: 'system', id: null });
    if (closed?.orderId != null) {
      await this.ports
        .get()
        .addTimeline(
          tx,
          closed.orderId,
          { type: 'system', id: null },
          { type: 'refund', message: CHARGEBACK_NOT_SENT_NOTE, data: { refundId: closed.id } },
        );
    }
    return closed !== undefined;
  }

  /** Writes the order's timeline line of a refund the gateway completed or failed. */
  private async addTimeline(tx: DbExecutor, done: Refund | undefined, outcome: RefundOutcome): Promise<void> {
    if (done?.orderId == null) return;
    // The USD the journal moved (the figure the refund list shows); converting the payment currency back is the fallback.
    const posted =
      done.ledgerTxId === null ? undefined : (await ledgerPartsOf(tx, [done.ledgerTxId])).get(done.ledgerTxId);
    const session = (await loadSessionMoney(tx, [done.orderId])).get(done.orderId);
    const usd = `$${wholeCents(posted ? Money.of(posted.gross) : toUsd(Money.of(done.amount), session?.fxRate ?? '1'))}`;
    await this.ports.get().addTimeline(
      tx,
      done.orderId,
      { type: 'system', id: null },
      {
        type: 'refund',
        message:
          outcome.kind === 'completed'
            ? `Refund of ${usd} confirmed by the gateway`
            : `Refund of ${usd} failed at the gateway: ${outcome.note}`,
        data: { refundId: done.id },
      },
    );
  }

  /**
   * Handles a refund result event.
   *
   * Why: the event names the send attempt it belongs to (echoed metadata), so a late `refund.failed` of an earlier gateway refund is told from
   * the current one even before the retry has stored its own gateway id; {@link settle} ignores it.
   *
   * @param gatewayId the gateway that signed the event
   * @param event what the driver read
   * @returns true when a refund was moved (a late failure noted on a completed refund moves nothing, except a return without an order,
   *   which is failed again)
   */
  async handleEvent(gatewayId: number, event: RefundEvent): Promise<boolean> {
    const refund = await findRefundForGateway(this.db.db, gatewayId, event);
    if (!refund) return false;
    if (event.kind === 'failed' && refund.status === 'completed') {
      return this.noteLateFailure(refund.id, refund.orderId === null, event);
    }
    return this.settle(
      refund.id,
      event.kind === 'succeeded'
        ? { kind: 'completed', gatewayRefundId: event.gatewayRefundId, attempt: event.sendAttempt }
        : {
            kind: 'failed',
            note: event.failure ?? 'The payment gateway refused the refund.',
            gatewayRefundId: event.gatewayRefundId,
            // The gateway's own `refund.failed`: that refund object is dead, so a retry needs a new key.
            definite: true,
            attempt: event.sendAttempt,
          },
    );
  }

  /**
   * Writes a failure of a completed refund on its note (once per gateway refund) and logs it as an error.
   *
   * Why: the customer did not get the money although the refund shows completed; reversing the journal automatically could pay twice when
   * staff have already acted, so staff decide (plan 24C § 8). Only the gateway refund the refund completed with counts: a late failure of an
   * earlier send attempt's gateway refund changes nothing. A return without an order has no journal: it is marked `failed` again
   * (decision 048), so its held payment is a finding of the money integrity check again until staff pay it back and close it.
   *
   * @returns true when a return without an order was marked failed again
   */
  private async noteLateFailure(refundId: number, isReturn: boolean, event: RefundEvent): Promise<boolean> {
    const now = this.clock.now();
    const marker = `that refund ${event.gatewayRefundId} failed after it was completed`;
    const reason = event.failure ?? 'no reason given';
    const text = `The gateway reported on ${now.toISOString()} ${marker}: ${reason}. Refund the customer another way.`;
    if (isReturn) {
      const failed = await failLateReturn(this.db.db, refundId, event.gatewayRefundId, marker, text, now);
      if (failed) {
        this.logger.error(
          `Refund ${refundId}: the gateway failed refund ${event.gatewayRefundId} of a payment held for staff after it completed (${reason}); the return is failed again and the payment is listed by the integrity check.`,
        );
      }
      return failed !== undefined;
    }
    const noted = await appendLateRefundFailure(this.db.db, refundId, event.gatewayRefundId, marker, text, now);
    if (noted) {
      this.logger.error(
        `Refund ${refundId}: the gateway failed refund ${event.gatewayRefundId} after it completed (${reason}); staff must refund the customer another way.`,
      );
    }
    return false;
  }
}
