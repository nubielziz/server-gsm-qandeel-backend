// RefundSettlement: records the gateway's final answer to a storefront refund, whether it came back from the job's call or as a
// `refund.succeeded` / `refund.failed` event (scenario b2c-refund step 7). One place, guarded by the refund's `processing` status.
import { Injectable, Logger } from '@nestjs/common';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { toUsd } from '../domain/b2c-money';
import { wholeCents } from '../domain/refund-rules';
import { ledgerPartsOf, loadSessionMoney } from '../infra/b2c-reads.repository';
import type { RefundEvent } from '../infra/gateway-drivers/driver';
import { findRefundForGateway, lockRefund } from '../infra/refund.repository';
import { B2cRefunds } from './b2c-refunds';
import { StorefrontOrderPorts } from './storefront-ports';

/** The gateway's final word on a refund. */
export type RefundOutcome =
  | { readonly kind: 'completed'; readonly gatewayRefundId: string | null }
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
    };

/**
 * Settles refunds with what the gateway said.
 *
 * Why: RESOLUTIONS money-5, money-11 and user rule 7: `processing` ends as `completed` (the payment becomes `partial_refund` or
 * `refunded`) or `failed` (with the gateway's text, retryable from the console). The job's own call and the gateway's event can both
 * report the same result, and a delivery can repeat, so only a refund still `processing` moves: the second report changes nothing. A failure
 * the gateway gave for good (`definite`) also moves the refund's idempotency key on, so the staff retry is not answered with the same refusal.
 * That key move is why a failure carries the send attempt it belongs to: a late or repeated `refund.failed` of the first gateway refund must not
 * fail the retry that replaced it (it would move the key again, and the next retry would refund the customer a third time).
 *
 * Side effects (in its own transaction): updates `refunds` and `payments`, adds a timeline line to the order.
 */
@Injectable()
export class RefundSettlement {
  private readonly logger = new Logger(RefundSettlement.name);

  constructor(
    private readonly db: DbService,
    private readonly refunds: B2cRefunds,
    private readonly ports: StorefrontOrderPorts,
  ) {}

  /**
   * Records an outcome.
   *
   * @param refundId the refund
   * @param outcome completed (with the gateway's id) or failed (with its text)
   * @returns true when this call moved the refund; false when it was no longer `processing`, or the failure was of an earlier send attempt
   */
  async settle(refundId: number, outcome: RefundOutcome): Promise<boolean> {
    return this.db.runInTransaction(async ({ tx }) => {
      const locked = await lockRefund(tx, refundId);
      if (!locked || locked.status !== 'processing') return false;
      // Checked under the lock, so a staff retry cannot slip in between the check and the update. Only a failure is held back: a success
      // is money that really moved, so it completes the refund whichever send it came from.
      if (outcome.kind === 'failed' && outcome.attempt != null && outcome.attempt < locked.sendAttempt) {
        this.logger.warn(
          `Refund ${refundId}: ignored a failure of send attempt ${outcome.attempt}; the refund is on attempt ${locked.sendAttempt}.`,
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
            );
      if (done?.orderId != null) {
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
            data: { refundId },
          },
        );
      }
      return done !== undefined;
    });
  }

  /**
   * Handles a refund result event.
   *
   * Why: the event names the send attempt it belongs to (echoed metadata), so a late `refund.failed` of an earlier gateway refund is told from
   * the current one even before the retry has stored its own gateway id; {@link settle} ignores it.
   *
   * @param gatewayId the gateway that signed the event
   * @param event what the driver read
   * @returns true when a refund was moved
   */
  async handleEvent(gatewayId: number, event: RefundEvent): Promise<boolean> {
    const refund = await findRefundForGateway(this.db.db, gatewayId, event);
    if (!refund) return false;
    return this.settle(
      refund.id,
      event.kind === 'succeeded'
        ? { kind: 'completed', gatewayRefundId: event.gatewayRefundId }
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
}
