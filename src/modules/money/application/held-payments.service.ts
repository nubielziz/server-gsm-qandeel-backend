// HeldPaymentsService: staff close a storefront payment that is held for staff (decision 048, POST /admin/held-payments/:id/close): its
// money was paid back by hand, or no money was received.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { HeldPaymentOutcome } from '../contracts/held-payments.contracts';
import type { Payment } from '../db/schema';
import { holdMarkOf } from '../domain/b2c-money';
import { paymentRef } from '../domain/invoice-rules';
import { MANUAL_RETURN_REASON } from '../domain/refund-rules';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway } from '../infra/gateway.repository';
import { lockOrderPayment, updateOrderPaymentIn } from '../infra/order-payment.repository';
import { insertRefund, refundsOfPayment } from '../infra/refund.repository';
import { findCurrencyByCode } from '../infra/storefront-money.repository';

/** What staff send to close a held payment. */
export interface CloseHeldPaymentInput {
  readonly outcome: HeldPaymentOutcome;
  /** What staff did, 10 to 500 characters. */
  readonly note: string;
}

/** Appends a sentence to a note, with one space; an empty note starts with the sentence. */
const appended = (note: string | null, sentence: string): string => (note ? `${note} ${sentence}` : sentence);

/**
 * Closes storefront payments held for staff.
 *
 * Why: decision 048: a confirmation that could not pay its checkout is held (no order, no journal) and stays a finding of the money
 * integrity check until its money is back. When the gateway could not send it back by itself (crypto, a gateway without refunds, a return
 * that failed) staff pay it back by hand and record that here (`returned`: a completed refund without an order, method `manual`), or find
 * that the gateway holds no money for it (`not_received`: the payment becomes `failed`, so a later real confirmation can still pay its
 * checkout). Either way the finding goes away. No journal is posted: the money never entered the books. A payment whose hold recorded that
 * the gateway's record showed its money received can only be closed as `returned` (closing it as not received would take money that is
 * still there off the integrity check); a payment held before that mark existed accepts both.
 *
 * Side effects (one transaction): inserts a `refunds` row (`returned`) or updates the payment (`not_received`), updates the payment's
 * review note, and writes one `audit_logs` row.
 *
 * @see docs/decisions/048-payments-integrity.md
 */
@Injectable()
export class HeldPaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Closes a held payment.
   *
   * @param staffId the signed-in staff member
   * @param id the payment id
   * @param input the outcome and staff's note
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id or a top-up; `CONFLICT` (409) for a payment that is not held, whose money is
   *   being sent back or was sent back, or (`not_received`) whose hold recorded the money as received
   */
  async close(staffId: number, id: number, input: CloseHeldPaymentInput): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const payment = await lockOrderPayment(tx, id);
      if (!payment) throw new AppError('NOT_FOUND', { detail: 'No storefront payment has this id.' });
      const notHeld = () => new AppError('CONFLICT', { detail: `${paymentRef(id)} is not held for staff.` });
      if (payment.status !== 'pending' || !payment.reviewRequired || payment.orderId !== null) throw notHeld();
      const back = (await refundsOfPayment(tx, id)).find(
        (refund) => refund.status === 'processing' || refund.status === 'completed',
      );
      if (back) {
        throw new AppError('CONFLICT', {
          detail: `${paymentRef(id)} is already being sent back or was sent back (RF-${back.id}).`,
        });
      }
      // The hold recorded whether the gateway's record showed this payment's money received (decision 048); no mark accepts both outcomes.
      if (input.outcome === 'not_received' && holdMarkOf(payment.raw) === true) {
        throw new AppError('CONFLICT', {
          detail: "The gateway's record shows this payment was received: send it back, then close it as returned.",
        });
      }
      const now = this.clock.now();
      const { amount, currency } = await this.figuresOf(tx, payment);
      let refundId: number | null = null;
      if (input.outcome === 'returned') {
        const refund = await insertRefund(tx, {
          paymentId: id,
          orderId: null,
          customerId: null,
          amount,
          currency,
          reason: MANUAL_RETURN_REASON,
          method: 'manual',
          status: 'completed',
          requestedByType: 'staff',
          requestedById: staffId,
          approvedBy: staffId,
          completedAt: now,
          note: input.note,
          createdAt: now,
          updatedAt: now,
        });
        refundId = refund.id;
        // The payment keeps its status: a later confirmation of it finds the refund and changes nothing.
        const noted = await updateOrderPaymentIn(tx, id, ['pending'], {
          reviewNote: appended(payment.reviewNote, `Paid back by hand by staff (RF-${refund.id}).`),
          reviewedBy: staffId,
          reviewedAt: now,
          updatedAt: now,
        });
        if (!noted) throw notHeld();
      } else {
        const failed = await updateOrderPaymentIn(tx, id, ['pending'], {
          status: 'failed',
          reviewRequired: false,
          reviewNote: appended(payment.reviewNote, 'Closed by staff: no money was received.'),
          reviewedBy: staffId,
          reviewedAt: now,
          updatedAt: now,
        });
        if (!failed) throw notHeld();
      }
      await this.audit.record(tx, {
        action: 'closed held payment',
        entityType: 'payment',
        entityId: id,
        entityLabel: `${paymentRef(id)}, ${amount} ${currency}`,
        before: { status: 'pending', reviewRequired: true },
        after: { outcome: input.outcome, refundId, note: input.note },
      });
    });
  }

  /**
   * What the payment's money is: the amount and currency the stored confirmation states (when its driver still reads them and the currency
   * is one of the shop's), else what the payment was opened for.
   */
  private async figuresOf(tx: DbExecutor, payment: Payment): Promise<{ amount: string; currency: string }> {
    const gateway = await findGateway(tx, payment.gatewayId);
    const event = gateway === undefined ? undefined : driverFor(gateway.driver)?.parse(payment.raw);
    if (event?.amount != null && event.currency != null && (await findCurrencyByCode(tx, event.currency))) {
      return { amount: Money.of(event.amount).toWire(), currency: event.currency };
    }
    return { amount: Money.of(payment.amount).toWire(), currency: payment.currency };
  }
}
