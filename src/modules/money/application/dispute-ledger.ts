// DisputeLedger: the outcomes of a dispute, shared by the staff's accept and the gateway's webhook (feature 16): a loss posts the one
// chargeback journal and marks the payment `chargeback`; a win returns the payment to the status its refunds leave it in.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { Dispute, Payment } from '../db/schema';
import { statusAfterRefunds, toUsd, wireUsd } from '../domain/b2c-money';
import { b2cChargeback } from '../domain/money-events';
import { loadSessionMoney } from '../infra/b2c-reads.repository';
import { updateDispute, updateDisputeIn } from '../infra/dispute.repository';
import { updateOrderPayment } from '../infra/order-payment.repository';
import { takenRefundsOfPayment } from '../infra/refund.repository';
import { LedgerPoster } from './post-transaction';
import type { RefundActor } from './b2c-refunds';

/**
 * Settles disputes.
 *
 * Why: RESOLUTIONS money-5 and rule 8 of RULES refunds: a dispute lost, from the staff's accept or from the gateway's webhook, posts
 * exactly one `b2c_chargeback` journal (Dr chargeback_loss amount + fee, Cr gateway_clearing; key `dispute:<id>:chargeback`) and
 * keeps its id in `disputes.ledger_tx_id`, so whichever comes second posts nothing; a dispute won sets the payment back to `captured`,
 * or to `partial_refund` or `refunded` when completed refunds exist.
 *
 * Side effects (on the caller's transaction): updates `disputes` and `payments`; writes one ledger transaction for a loss.
 */
@Injectable()
export class DisputeLedger {
  constructor(
    private readonly poster: LedgerPoster,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Marks a dispute lost and posts the chargeback once.
   *
   * @param tx the caller's transaction (the payment and the dispute are locked)
   * @param dispute the dispute (`needs_response`, `under_review` or already `lost`)
   * @param payment the disputed payment
   * @param actor who closed it (the staff member who accepted, or the system for the gateway's decision)
   * @returns the dispute after the change
   */
  async lose(tx: DbExecutor, dispute: Dispute, payment: Payment, actor: RefundActor): Promise<Dispute> {
    const now = this.clock.now();
    let ledgerTxId = dispute.ledgerTxId;
    if (ledgerTxId === null) {
      const session =
        dispute.orderId === null ? undefined : (await loadSessionMoney(tx, [dispute.orderId])).get(dispute.orderId);
      const fx = session?.fxRate ?? '1';
      const posting = b2cChargeback({
        amount: wireUsd(
          Money.of(dispute.amount),
          session ? { amount: payment.amount, grossUsd: session.grossAmount } : undefined,
          fx,
        ),
        fee: toUsd(Money.of(dispute.fee), fx),
      });
      const posted = await this.poster.post(tx, {
        kind: posting.kind,
        refType: posting.refType,
        refId: dispute.orderId ?? payment.orderId ?? payment.id,
        idempotencyKey: `dispute:${dispute.id}:chargeback`,
        currency: 'USD',
        lines: posting.lines,
        memo: `Chargeback DP-${dispute.id} on SF-${dispute.orderId ?? 0} (incl. dispute fee)`,
        createdBy: { type: actor.type, id: actor.id },
      });
      ledgerTxId = posted.id;
    }
    const lost =
      dispute.status === 'lost'
        ? await updateDispute(tx, dispute.id, { ledgerTxId, updatedAt: now })
        : (await updateDisputeIn(tx, dispute.id, ['needs_response', 'under_review'], {
            status: 'lost',
            resolvedAt: now,
            ledgerTxId,
            updatedAt: now,
          }))!;
    await updateOrderPayment(tx, payment.id, { status: 'chargeback', updatedAt: now });
    return lost;
  }

  /**
   * Marks a dispute won and restores the payment's status.
   *
   * @param tx the caller's transaction (the payment and the dispute are locked)
   * @param dispute the dispute (`needs_response` or `under_review`)
   * @param payment the disputed payment
   * @returns the dispute after the change, or `undefined` when it was not open any more
   */
  async win(tx: DbExecutor, dispute: Dispute, payment: Payment): Promise<Dispute | undefined> {
    const now = this.clock.now();
    const won = await updateDisputeIn(tx, dispute.id, ['needs_response', 'under_review'], {
      status: 'won',
      resolvedAt: now,
      updatedAt: now,
    });
    if (!won) return undefined;
    const completed = (await takenRefundsOfPayment(tx, payment.id)).filter((refund) => refund.status === 'completed');
    const status = statusAfterRefunds(
      Money.of(payment.amount),
      Money.sum(completed.map((refund) => Money.of(refund.amount))),
    );
    await updateOrderPayment(tx, payment.id, { status, updatedAt: now });
    return won;
  }
}
