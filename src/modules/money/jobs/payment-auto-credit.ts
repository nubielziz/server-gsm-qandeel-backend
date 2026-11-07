// The automatic credit of confirmed top-ups of automatic gateways (user rule 6, RESOLUTIONS money-3): the use case the worker's
// payment_auto_credit job runs. One payment at a time: ask the gateway, then decide and write under the payment's lock.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { OutboundHttp } from '../../../infra/http';
import { AuditService } from '../../platform';
import type { Payment, PaymentGateway } from '../db/schema';
import { paymentRef } from '../domain/invoice-rules';
import { type GatewayStatus, decideAutoCredit } from '../domain/payment-rules';
import { GatewayCredentialsVault } from '../application/gateway-credentials';
import { PaymentCrediting } from '../application/payment-crediting';
import { GATEWAY_HTTP_POLICY, type GatewayHttpPolicy } from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway } from '../infra/gateway.repository';
import { dueAutoCreditIds, findTopupPayment, lockTopupPayment, updatePayment } from '../infra/payment.repository';

/** How many due payments one tick takes (the next tick takes the rest). */
export const AUTO_CREDIT_BATCH = 50;

/** What one tick did. */
export interface AutoCreditSummary {
  readonly checked: number;
  readonly credited: number;
  /** Sent to staff review (the gateway no longer confirms, risk flagged, the invoice is no longer payable). */
  readonly review: number;
  /** Asked again later (the gateway has not confirmed yet). */
  readonly deferred: number;
  /** Left alone (a staff decision or another worker got there first). */
  readonly skipped: number;
  readonly failed: number;
}

type Outcome = 'credited' | 'review' | 'deferred' | 'skipped';

/**
 * Credits the top-ups of automatic gateways by themselves.
 *
 * Why: user rule 6: after the gateway confirmed the payment and `payments.auto_credit_delay_minutes` (or the gateway's hold hours)
 * passed, the job asks the gateway's API again and credits the wallet only if the payment is still confirmed and risk has not
 * flagged it; otherwise the payment goes to staff review. The gateway call happens before the transaction (never hold a row lock
 * across a network call); the decision is taken under `SELECT ... FOR UPDATE` on the payment after re-checking that it is still
 * pending, so a staff decision racing the job changes nothing (the loser gets `PAYMENT_ALREADY_REVIEWED`) and the ledger key
 * `deposit:payment:<id>` makes a double credit impossible. A gateway that cannot be reached counts as "not confirmed yet".
 *
 * Side effects: calls the gateway's API; credits wallets (see {@link PaymentCrediting}); writes `payments` and `audit_logs` rows.
 */
@Injectable()
export class PaymentAutoCredit {
  private readonly logger = new Logger(PaymentAutoCredit.name);

  constructor(
    private readonly db: DbService,
    private readonly crediting: PaymentCrediting,
    private readonly vault: GatewayCredentialsVault,
    private readonly audit: AuditService,
    private readonly http: OutboundHttp,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(GATEWAY_HTTP_POLICY) private readonly policy?: GatewayHttpPolicy,
  ) {}

  /**
   * Lists the payments that are due now.
   *
   * @returns their ids, oldest due first (at most {@link AUTO_CREDIT_BATCH})
   */
  due(): Promise<number[]> {
    return dueAutoCreditIds(this.db.db, this.clock.now(), AUTO_CREDIT_BATCH);
  }

  /**
   * Handles some due payments.
   *
   * @param ids the payments to handle (from {@link PaymentAutoCredit.due})
   * @returns what happened to them
   */
  async run(ids: readonly number[]): Promise<AutoCreditSummary> {
    const counts = { credited: 0, review: 0, deferred: 0, skipped: 0, failed: 0 };
    for (const id of ids) {
      try {
        counts[await this.process(id)]++;
      } catch (error) {
        // One payment's failure never stops the others; it stays due and the next tick tries it again.
        counts.failed++;
        this.logger.error(
          `Automatic credit of ${paymentRef(id)} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { checked: ids.length, ...counts };
  }

  private async process(id: number): Promise<Outcome> {
    const payment = await this.readDue(id);
    if (!payment) return 'skipped';
    const gateway = await findGateway(this.db.db, payment.gatewayId);
    if (!gateway) throw new Error(`${paymentRef(id)} points at a gateway that does not exist.`);

    const status = await this.askGateway(payment, gateway);
    if (status === undefined) return this.sendToReview(id, 'This gateway cannot be checked automatically.');
    const decision = decideAutoCredit({
      gateway: status,
      capturedAt: payment.capturedAt ?? payment.createdAt,
      now: this.clock.now(),
    });
    if (decision.action === 'review') return this.sendToReview(id, decision.reason);
    if (decision.action === 'recheck') {
      return this.db.runInTransaction(async ({ tx }) => {
        const locked = await lockTopupPayment(tx, id);
        if (!locked || locked.status !== 'pending' || locked.reviewRequired) return 'skipped';
        await updatePayment(tx, id, { autoCreditAt: decision.at });
        return 'deferred';
      });
    }
    return this.credit(id, gateway);
  }

  /** Reads a payment and tells whether it is still due (pending, not flagged, its time has come). */
  private async readDue(id: number): Promise<Payment | undefined> {
    const now = this.clock.now();
    const payment = (await findTopupPayment(this.db.db, id))?.payment;
    if (!payment || payment.status !== 'pending' || payment.reviewRequired) return undefined;
    if (payment.autoCreditAt === null || payment.autoCreditAt.getTime() > now.getTime()) return undefined;
    return payment;
  }

  /** What the gateway says now; `undefined` when the gateway has no code that can be asked. */
  private async askGateway(payment: Payment, gateway: PaymentGateway): Promise<GatewayStatus | undefined> {
    const driver = gateway.isManual ? undefined : driverFor(gateway.driver);
    if (!driver || !payment.gatewayTxnId) return undefined;
    try {
      return await driver.checkStatus(
        { http: this.http, policy: this.policy },
        this.vault.read(gateway),
        payment.gatewayTxnId,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'GATEWAY_ERROR') {
        this.logger.warn(`Gateway ${gateway.code} could not confirm ${paymentRef(payment.id)} yet: ${error.message}`);
        return 'pending';
      }
      throw error;
    }
  }

  /** Credits a payment under its lock, after re-checking it; a payment that cannot be credited goes to staff with the reason. */
  private async credit(id: number, gateway: PaymentGateway): Promise<Outcome> {
    try {
      return await this.db.runInTransaction(async (work) => {
        const locked = await lockTopupPayment(work.tx, id);
        if (!locked || locked.status !== 'pending' || locked.reviewRequired) return 'skipped';
        await this.crediting.credit(work, locked, gateway, { kind: 'system' });
        return 'credited';
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT')
        return this.sendToReview(id, error.detail ?? error.message);
      throw error;
    }
  }

  /** Marks a payment `review_required` with the reason; staff then approve or reject it. */
  private async sendToReview(id: number, reason: string): Promise<Outcome> {
    return this.db.runInTransaction(async ({ tx }) => {
      const locked = await lockTopupPayment(tx, id);
      if (!locked || locked.status !== 'pending' || locked.reviewRequired) return 'skipped';
      await updatePayment(tx, id, { reviewRequired: true, reviewNote: reason, autoCreditAt: null });
      await this.audit.record(tx, {
        action: 'sent deposit to review',
        entityType: 'payment',
        entityId: id,
        entityLabel: paymentRef(id),
        after: { reviewRequired: true, reason },
      });
      return 'review';
    });
  }
}
