// The automatic credit of confirmed top-ups of automatic gateways (user rule 6, RESOLUTIONS money-3): the use case the worker's
// payment_auto_credit job runs. One payment at a time: ask the gateway, then decide and write under the payment's lock.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import { OutboundHttp } from '../../../infra/http';
import { AuditService } from '../../platform';
import type { Payment, PaymentGateway } from '../db/schema';
import { paymentRef } from '../domain/invoice-rules';
import { type GatewayStatus, decideAutoCredit, topUpRecordProblem } from '../domain/payment-rules';
import { GatewayCredentialsVault } from '../application/gateway-credentials';
import { PaymentCrediting } from '../application/payment-crediting';
import { TopUpScreeningHooks } from '../application/top-up-screening-hooks';
import {
  GATEWAY_CALL_TIMEOUT_MS,
  GATEWAY_HTTP_POLICY,
  type GatewayHttpPolicy,
  type PaymentCheck,
} from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findWalletCustomer, loadBillingMerchants } from '../infra/foreign-directory.repository';
import { findGateway } from '../infra/gateway.repository';
import { findInvoice } from '../infra/invoice.repository';
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

/** What the gateway says about a payment now, and what in its record differs from the invoice (decision 048). */
interface GatewayAnswer {
  readonly status: GatewayStatus;
  /** The note for staff when the record of a confirmed payment differs from its invoice. */
  readonly problem?: string | undefined;
}

/**
 * Credits the top-ups of automatic gateways by themselves.
 *
 * Why: user rule 6: after the gateway confirmed the payment and `payments.auto_credit_delay_minutes` (or the gateway's hold hours)
 * passed, the job asks the gateway's API again and credits the wallet only if the payment is still confirmed and risk has not
 * flagged it; otherwise the payment goes to staff review. Risk is asked under the lock, just before the credit, through
 * {@link TopUpScreeningHooks} (RESOLUTIONS money-3: the blocklist's card and the merchant's email); a flagged payment gets
 * `review_required` and the reason as its note, and nothing is posted. The gateway call happens before the transaction (never
 * hold a row lock across a network call); the decision is taken under `SELECT ... FOR UPDATE` on the payment after re-checking
 * that it is still pending, so a staff decision racing the job changes nothing (the loser gets `PAYMENT_ALREADY_REVIEWED`) and
 * the ledger key `deposit:payment:<id>` makes a double credit impossible. A gateway that cannot be reached counts as "not
 * confirmed yet". Decision 048: a card top-up is judged on the gateway's own record of the payment, read once (`verifyPayment`, the
 * read the storefront capture makes, with the 10-second limit of the status check it replaced, {@link GATEWAY_CALL_TIMEOUT_MS}: the
 * capture's 3 seconds are for a webhook that waits, and a job has the time): it is credited only when the record says paid, belongs
 * to this invoice (when it states the reference its checkout was opened with), shows nothing refunded or disputed since, and shows
 * the invoice's amount and currency as received; any difference sends it to staff review with a note that names it, and a record that
 * ended unpaid counts as "no longer confirmed". Other automatic gateways are asked for the payment's status (`checkStatus`).
 *
 * Side effects: calls the gateway's API; credits wallets (see {@link PaymentCrediting}); writes `payments` and `audit_logs` rows.
 */
@Injectable()
export class PaymentAutoCredit {
  private readonly logger = new Logger(PaymentAutoCredit.name);

  constructor(
    private readonly db: DbService,
    private readonly crediting: PaymentCrediting,
    private readonly screening: TopUpScreeningHooks,
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

    const answer = await this.askGateway(payment, gateway);
    if (answer === undefined) return this.sendToReview(id, 'This gateway cannot be checked automatically.');
    // A record that differs from the invoice is never credited automatically; staff look at it (decision 048).
    if (answer.problem !== undefined) return this.sendToReview(id, answer.problem);
    const decision = decideAutoCredit({
      gateway: answer.status,
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

  /**
   * What the gateway says now; `undefined` when the gateway has no code that can be asked. A card top-up reads the gateway's record of the
   * payment once and compares it with the invoice; any other automatic gateway is asked for the payment's status.
   */
  private async askGateway(payment: Payment, gateway: PaymentGateway): Promise<GatewayAnswer | undefined> {
    const driver = gateway.isManual ? undefined : driverFor(gateway.driver);
    if (!driver || !payment.gatewayTxnId) return undefined;
    try {
      const calls = { http: this.http, policy: this.policy };
      if (driver.methodType === 'card' && driver.verifyPayment) {
        // A job nobody waits on: the read gets the time of any gateway call, not the webhook's short limit (decision 048).
        return await this.judgeRecord(
          payment,
          await driver.verifyPayment(calls, this.vault.read(gateway), payment.gatewayTxnId, {
            timeoutMs: GATEWAY_CALL_TIMEOUT_MS,
          }),
        );
      }
      return { status: await driver.checkStatus(calls, this.vault.read(gateway), payment.gatewayTxnId) };
    } catch (error) {
      if (error instanceof AppError && error.code === 'GATEWAY_ERROR') {
        this.logger.warn(`Gateway ${gateway.code} could not confirm ${paymentRef(payment.id)} yet: ${error.message}`);
        return { status: 'pending' };
      }
      throw error;
    }
  }

  /**
   * Turns the gateway's record of a card top-up into the job's answer: paid (with what differs from the invoice, if anything), ended
   * unpaid (`failed`), or not paid yet (`pending`).
   */
  private async judgeRecord(payment: Payment, record: PaymentCheck): Promise<GatewayAnswer> {
    if (record.status !== 'confirmed') return { status: record.ended === true ? 'failed' : 'pending' };
    // Without an invoice the credit itself refuses the payment and sends it to staff.
    const invoice = payment.invoiceId === null ? undefined : await findInvoice(this.db.db, payment.invoiceId);
    const problem = invoice === undefined ? undefined : topUpRecordProblem(record, invoice);
    return problem === undefined ? { status: 'confirmed' } : { status: 'confirmed', problem };
  }

  /**
   * Credits a payment under its lock, after re-checking it and asking risk; a payment that cannot be credited goes to staff with
   * the reason.
   */
  private async credit(id: number, gateway: PaymentGateway): Promise<Outcome> {
    try {
      return await this.db.runInTransaction(async (work) => {
        const locked = await lockTopupPayment(work.tx, id);
        if (!locked || locked.status !== 'pending' || locked.reviewRequired) return 'skipped';
        // Risk looks at the same rows the credit would use. A screen that throws fails this payment (it stays due), never credits it.
        const verdict = await this.screening.screen(work.tx, {
          cardFingerprint: locked.cardFingerprint,
          email: await this.ownerEmail(work.tx, locked),
        });
        if (verdict.flagged) {
          await this.markForReview(work.tx, id, verdict.reason ?? 'Risk review: flagged.');
          return 'review';
        }
        await this.crediting.credit(work, locked, gateway, { kind: 'system' });
        return 'credited';
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT')
        return this.sendToReview(id, error.detail ?? error.message);
      throw error;
    }
  }

  /**
   * The email of the merchant or storefront customer (feature 21) that owns the payment's invoice, or `null` when it has neither.
   */
  private async ownerEmail(tx: DbExecutor, payment: Payment): Promise<string | null> {
    const invoice = payment.invoiceId === null ? undefined : await findInvoice(tx, payment.invoiceId);
    if (!invoice) return null;
    if (invoice.clientId !== null) {
      return (await loadBillingMerchants(tx, [invoice.clientId])).get(invoice.clientId)?.email ?? null;
    }
    if (invoice.customerId !== null) return (await findWalletCustomer(tx, invoice.customerId))?.email ?? null;
    return null;
  }

  /** Marks a payment `review_required` with the reason; staff then approve or reject it. */
  private async sendToReview(id: number, reason: string): Promise<Outcome> {
    return this.db.runInTransaction(async ({ tx }) => {
      const locked = await lockTopupPayment(tx, id);
      if (!locked || locked.status !== 'pending' || locked.reviewRequired) return 'skipped';
      await this.markForReview(tx, id, reason);
      return 'review';
    });
  }

  /** Writes the review flag, its reason and the audit row on a payment the caller has locked and checked to be pending. */
  private async markForReview(tx: DbExecutor, id: number, reason: string): Promise<void> {
    await updatePayment(tx, id, { reviewRequired: true, reviewNote: reason, autoCreditAt: null });
    await this.audit.record(tx, {
      action: 'sent deposit to review',
      entityType: 'payment',
      entityId: id,
      entityLabel: paymentRef(id),
      after: { reviewRequired: true, reason },
    });
  }
}
