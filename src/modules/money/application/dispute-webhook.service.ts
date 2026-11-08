// DisputeWebhookService: handles a verified dispute event from a gateway (map route POST /webhooks/disputes/:gateway, scenario
// b2c-chargeback steps 1, 2 and 6). The signature, the 5-minute window and the replay filter ran in the guard.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { DEFAULT_EVIDENCE_DAYS, disputeNote } from '../domain/dispute-rules';
import { loadSessionMoney } from '../infra/b2c-reads.repository';
import { wireUsd } from '../domain/b2c-money';
import { wholeCents } from '../domain/refund-rules';
import { findDisputeByGatewayId, insertDisputeOnce, lockDispute } from '../infra/dispute.repository';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGatewayByCode } from '../infra/gateway.repository';
import { findOrderPaymentByReference, lockOrderPayment, updateOrderPaymentIn } from '../infra/order-payment.repository';
import { DisputeLedger } from './dispute-ledger';
import { StorefrontOrderPorts } from './storefront-ports';

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
 * posts nothing). Events that are not usable (an unknown payment, a type the driver ignores) are acknowledged with `200` so the gateway
 * stops retrying, and logged. The alert to staff about the deadline (scenario step 3) is the notifications feature's (12a): it belongs
 * right after a `created` dispute is stored.
 *
 * Side effects (one transaction): inserts or updates `disputes`, updates `payments`, writes a ledger transaction on a loss, adds an
 * order timeline line.
 *
 * @see docs/contract/endpoints/money.md (POST /webhooks/disputes/:gateway)
 */
@Injectable()
export class DisputeWebhookService {
  private readonly logger = new Logger(DisputeWebhookService.name);

  constructor(
    private readonly db: DbService,
    private readonly ledger: DisputeLedger,
    private readonly ports: StorefrontOrderPorts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one verified delivery.
   *
   * @param gatewayCode the `:gateway` of the URL (already verified by the guard)
   * @param body the parsed JSON body
   * @returns `{ received: true }`, with `duplicate: true` when the event changed nothing because it was handled before
   */
  async handle(gatewayCode: string, body: unknown): Promise<DisputeWebhookOutcome> {
    const gateway = await findGatewayByCode(this.db.db, gatewayCode);
    const event = gateway ? driverFor(gateway.driver)?.parseDispute?.(body) : undefined;
    if (!gateway || !event) return { received: true };

    return this.db.runInTransaction(async ({ tx }) => {
      const found = await findOrderPaymentByReference(tx, gateway.id, event.paymentReference);
      if (!found) {
        this.logger.warn(`Gateway ${gateway.code}: dispute ${event.reference} names no payment of this gateway.`);
        return { received: true } as const;
      }
      const payment = await lockOrderPayment(tx, found.id);
      if (!payment) return { received: true } as const;
      const now = this.clock.now();
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
        this.logger.warn(`Gateway ${gateway.code}: dispute ${event.reference} closed before it was recorded.`);
        return { received: true } as const;
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
}
