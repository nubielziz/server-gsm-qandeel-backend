// RefundSender: sends an approved storefront refund to its payment gateway and records the answer (job `refund.process`, scenario b2c-refund
// steps 6 and 7). The gateway call happens outside any database transaction.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { OutboundHttp } from '../../../infra/http';
import { UnrecoverableError } from '../../../infra/queues';
import { GatewayCredentialsVault } from '../application/gateway-credentials';
import { RefundSettlement } from '../application/refund-settlement';
import { refundSendKey } from '../domain/refund-rules';
import {
  GATEWAY_HTTP_POLICY,
  GatewayRefusalError,
  type GatewayHttpPolicy,
  type RefundAnswer,
} from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway } from '../infra/gateway.repository';
import { findOrderPayment } from '../infra/order-payment.repository';
import { findRefund, lockRefund, updateRefund } from '../infra/refund.repository';

/** What one run of the job did. */
export type RefundSendResult = 'completed' | 'pending' | 'failed' | 'skipped';

/**
 * Sends refunds to gateways.
 *
 * Why: RESOLUTIONS money-11 and user rule 7: a refund is `processing` from approval until the gateway answers. The call carries an
 * idempotency key (`refund-<id>`, see {@link refundSendKey}) and the refund id and the send attempt as metadata, so a retry of the job never refunds
 * twice, the gateway's own event finds the refund, and a late event of an earlier send is told from the current one. A gateway that answers `succeeded` completes the refund; `pending` waits for its
 * `refund.succeeded` or `refund.failed` event (`POST /webhooks/payments/:gateway`); a refund object that comes back `failed` fails it with the
 * gateway's text. Two kinds of failure differ in what a staff retry may do. A refusal the gateway gave for good (a 4xx answer, a failed refund
 * object) is definite: the sender fails the refund and, for a 4xx, throws an `UnrecoverableError` (the queue does not retry it); the refund's
 * `send_attempt` moves on, so the staff retry sends under a new key (`refund-<id>-<n>`) instead of being answered with the same refusal. An
 * error whose outcome is unknown (a timeout, a 5xx, a network error) is thrown so the queue retries it with the same key, and on the last
 * attempt the refund fails with that error but keeps its key: the gateway may have made the refund, and the same key stops a second one.
 *
 * Side effects: calls the gateway; updates `refunds` and `payments`; adds an order timeline line.
 */
@Injectable()
export class RefundSender {
  private readonly logger = new Logger(RefundSender.name);

  constructor(
    private readonly db: DbService,
    private readonly settlement: RefundSettlement,
    private readonly vault: GatewayCredentialsVault,
    private readonly http: OutboundHttp,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(GATEWAY_HTTP_POLICY) private readonly policy?: GatewayHttpPolicy,
  ) {}

  /**
   * Sends one refund.
   *
   * @param refundId the refund
   * @param finalAttempt true on the queue's last attempt: a failed call then fails the refund instead of being retried
   * @returns what happened; `skipped` when the refund is no longer `processing` or is paid out by hand
   * @throws {AppError} `GATEWAY_ERROR` when the call failed with an unknown outcome and the queue should retry
   * @throws {UnrecoverableError} when the gateway refused the call for good (a 4xx): the refund is `failed` and the queue must not retry it
   */
  async send(refundId: number, finalAttempt: boolean): Promise<RefundSendResult> {
    const refund = await findRefund(this.db.db, refundId);
    if (!refund || refund.status !== 'processing' || refund.method !== 'original' || refund.paymentId === null) {
      return 'skipped';
    }
    const payment = await findOrderPayment(this.db.db, refund.paymentId);
    const gateway = payment ? await findGateway(this.db.db, payment.gatewayId) : undefined;
    const driver = gateway ? driverFor(gateway.driver) : undefined;
    if (!payment || !gateway || !driver?.refund || !payment.gatewayTxnId) {
      await this.settlement.settle(refundId, {
        kind: 'failed',
        note: 'The payment gateway cannot refund this payment: pay it out by hand.',
      });
      return 'failed';
    }
    let answer: RefundAnswer;
    try {
      answer = await driver.refund({ http: this.http, policy: this.policy }, this.vault.read(gateway), {
        paymentReference: payment.gatewayTxnId,
        amount: Money.of(refund.amount),
        currency: refund.currency,
        refundId: refund.id,
        idempotencyKey: refundSendKey(refund.id, refund.sendAttempt),
        sendAttempt: refund.sendAttempt,
      });
    } catch (error) {
      if (error instanceof GatewayRefusalError) {
        // A refusal for good: the same call would be refused again, so fail the refund now (the key moves on) and stop the queue.
        const note = error.detail ?? error.message;
        this.logger.warn(`Refund ${refund.id} was refused by the gateway: ${note}`);
        await this.settlement.settle(refundId, { kind: 'failed', note, definite: true, attempt: refund.sendAttempt });
        throw new UnrecoverableError(note);
      }
      if (!finalAttempt) throw error;
      const note = error instanceof AppError ? (error.detail ?? error.message) : 'The refund could not be sent.';
      this.logger.warn(`Refund ${refund.id} failed on its last attempt: ${note}`);
      await this.settlement.settle(refundId, { kind: 'failed', note, attempt: refund.sendAttempt });
      return 'failed';
    }
    if (answer.status === 'succeeded') {
      await this.settlement.settle(refundId, { kind: 'completed', gatewayRefundId: answer.gatewayRefundId });
      return 'completed';
    }
    if (answer.status === 'failed') {
      await this.settlement.settle(refundId, {
        kind: 'failed',
        note: answer.failure ?? 'The payment gateway refused the refund.',
        gatewayRefundId: answer.gatewayRefundId,
        definite: true,
        attempt: refund.sendAttempt,
      });
      return 'failed';
    }
    await this.db.runInTransaction(async ({ tx }) => {
      const locked = await lockRefund(tx, refundId);
      if (locked?.status === 'processing') {
        await updateRefund(tx, refundId, { gatewayRefundId: answer.gatewayRefundId, updatedAt: this.clock.now() });
      }
    });
    return 'pending';
  }
}
