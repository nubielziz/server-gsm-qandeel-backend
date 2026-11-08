// RefundService: the use cases of the storefront refund routes (map stage 16): list, read, approve, decline and retry.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { b2cPaymentMethod, fromUsd, toUsd } from '../domain/b2c-money';
import {
  MAX_DECLINE_REASON_LENGTH,
  MIN_DECLINE_REASON_LENGTH,
  checkApproval,
  refundRoute,
  wholeCents,
} from '../domain/refund-rules';
import { lockOrderForRefund } from '../infra/b2c-reads.repository';
import { findGateway } from '../infra/gateway.repository';
import { lockOrderPayment } from '../infra/order-payment.repository';
import {
  type RefundSortField,
  findStorefrontRefund,
  listRefundRows,
  lockRefund,
  updateRefundIn,
} from '../infra/refund.repository';
import { B2cRefunds } from './b2c-refunds';
import { RefundOutbox } from './refund-outbox';
import { type WireRefund, RefundViews } from './refund-views';
import { StorefrontMails } from './storefront-mails';
import { StorefrontMoney } from './storefront-money';
import { StorefrontOrderPorts } from './storefront-ports';

const refundLabel = (id: number): string => `RF-${id}`;
const orderLabel = (id: number): string => `SF-${id}`;

const notFound = () => new AppError('NOT_FOUND', { detail: 'No refund with this id.' });

/** `Enter an amount ...` for text that is not an amount at all. */
const AMOUNT_TEXT = /^\d+(\.\d{1,4})?$/;

/**
 * Decides storefront refunds.
 *
 * Why: scenario b2c-refund, RESOLUTIONS money-11 and user rule 7, ANSWERS refunds Q3 and Q4. Approval is one transaction under the locks
 * of the order, the payment and the refund (lock order: order, then payment, then refund, then the ledger accounts): the amount is checked against what can
 * still go back, the journal is posted once (from revenue for a delivered order; from customer funds for an order the system rejected while
 * `autoRefundFailed` was off), an order that is still open is cancelled through the state machine, the refund
 * moves to `processing` (gateway job) or `completed` (hand payout), the timeline and the audit log say so. Decline writes the reason
 * the customer reads. Retry re-queues the gateway call and posts nothing (B83). A refund that failed at the gateway still counts against what can go back (its reversal stays
 * posted), so the way out of a failure is the retry, never a second approval.
 *
 * Side effects: updates `refunds` and `payments`; writes ledger rows, order timeline lines (and an order transition for an order
 * that was not delivered), `audit_logs` and a `refund.process` outbox row. A decline writes the customer's `refund.declined` email (feature 12a's
 * delivery, `StorefrontMails`) in its transaction; so does the approval of a refund request for an order the system had rejected (`order.failed`).
 *
 * @see docs/contract/endpoints/money.md (GET /admin/refunds ... POST /admin/refunds/:id/retry)
 */
@Injectable()
export class RefundService {
  constructor(
    private readonly db: DbService,
    private readonly views: RefundViews,
    private readonly refunds: B2cRefunds,
    private readonly outbox: RefundOutbox,
    private readonly ports: StorefrontOrderPorts,
    private readonly audit: AuditService,
    private readonly money: StorefrontMoney,
    private readonly mails: StorefrontMails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists storefront refunds.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(query: ParsedListQuery<RefundSortField>): Promise<{ rows: WireRefund[]; total: number }> {
    const { rows, total } = await listRefundRows(this.db.db, query);
    return { rows: await this.views.build(this.db.db, rows), total };
  }

  /**
   * Reads one refund.
   *
   * @param id the refund id
   * @returns the refund
   * @throws {AppError} `NOT_FOUND` for an unknown id or a merchant refund
   */
  async get(id: number): Promise<WireRefund> {
    const refund = await findStorefrontRefund(this.db.db, id);
    if (!refund) throw notFound();
    return (await this.views.build(this.db.db, [refund]))[0]!;
  }

  /**
   * Approves a waiting refund.
   *
   * @param staffId the staff member
   * @param id the refund
   * @param amountText the USD amount staff typed, or `undefined` for the amount on the request
   * @returns the refund after the decision (`processing`, or `completed` for a hand payout)
   * @throws {AppError} `NOT_FOUND`; `REFUND_NOT_PENDING` (409); `VALIDATION_FAILED` (422, field `amount`); `INVALID_TRANSITION`
   *   (409) for a payment in dispute; `ORDER_NOT_OPEN` (409) when the order closed meanwhile
   */
  async approve(staffId: number, id: number, amountText: string | undefined): Promise<WireRefund> {
    const approved = await this.db.runInTransaction(async ({ tx }) => {
      const first = await findStorefrontRefund(tx, id);
      if (!first) throw notFound();
      // Lock order: the order, then the payment, then the refund, then the ledger accounts. A rejection locks the order first (its guarded
      // update), so an approval does too: taking the payment first could deadlock with it. Capture and the dispute webhook take the payment
      // first and never wait for a locked order, so they cannot close a cycle.
      const order = first.orderId === null ? undefined : await lockOrderForRefund(tx, first.orderId);
      const payment = first.paymentId === null ? undefined : await lockOrderPayment(tx, first.paymentId);
      const refund = await lockRefund(tx, id);
      if (!refund || !payment || !order || refund.orderId !== order.id) throw notFound();
      if (refund.status !== 'requested') {
        throw new AppError('REFUND_NOT_PENDING', { detail: `${refundLabel(id)} is no longer waiting for approval.` });
      }
      if (payment.status !== 'captured' && payment.status !== 'partial_refund' && payment.status !== 'refunded') {
        throw new AppError('INVALID_TRANSITION', {
          detail: `This payment is ${payment.status.replace('_', ' ')}: it cannot be refunded here.`,
        });
      }
      const left = await this.refunds.leftOn(tx, order, payment, refund.id);
      const currency = await this.money.byCode(tx, payment.currency);
      const decimals = currency?.decimals ?? 2;
      const onRequest = Money.of(refund.amount);
      const requested =
        amountText === undefined ? undefined : AMOUNT_TEXT.test(amountText) ? Money.of(amountText) : Money.zero();
      const check = checkApproval({
        requested,
        // A request for the whole payment is a request for everything that is left, down to the cent of USD.
        onRequestUsd: onRequest.cmp(left.original) >= 0 ? left.usd : toUsd(onRequest, left.fxRate),
        leftUsd: left.usd,
        delivered: order.status === 'completed',
      });
      if (!check.ok) {
        throw new AppError('VALIDATION_FAILED', {
          detail: check.message,
          errors: [{ field: check.field, code: 'invalid', message: check.message }],
        });
      }
      // What the gateway is asked for: the USD amount in the payment currency, rounded once; everything left when it is all of it.
      const everything = check.amountUsd.cmp(left.usd) >= 0;
      const rounded = fromUsd(check.amountUsd, left.fxRate, decimals);
      const original = everything || rounded.cmp(left.original) >= 0 ? left.original : rounded;
      const gateway = await findGateway(tx, payment.gatewayId);
      const route = refundRoute(b2cPaymentMethod(payment.methodType), this.refunds.capability(gateway));
      const now = this.clock.now();
      const updated = await updateRefundIn(tx, refund.id, ['requested'], {
        amount: original.toWire(),
        method: route.method,
        status: 'processing',
        approvedBy: staffId,
        note: route.note,
        updatedAt: now,
      });
      if (!updated)
        throw new AppError('REFUND_NOT_PENDING', { detail: `${refundLabel(id)} is no longer waiting for approval.` });

      const actor = { type: 'staff' as const, id: staffId };
      const partial = original.cmp(Money.of(payment.amount)) < 0;
      if (order.status === 'completed') {
        const posted = await this.refunds.postDelivered(tx, { order, payment, refund: updated, actor });
        await this.ports.get().addTimeline(tx, order.id, actor, {
          type: 'refund',
          message: `${partial ? 'Partial refund of ' : 'Refund of '}$${wholeCents(Money.of(posted.gross))}${
            route.method === 'manual' ? ' to be paid out manually' : ' sent to the original payment method'
          }`,
          data: { refundId: refund.id, amount: posted.gross },
        });
      } else if (order.status === 'rejected') {
        // The system rejected this order while `autoRefundFailed` was off: nothing went back then, so the money is still in customer funds.
        const posted = await this.refunds.postRejected(tx, { order, payment, refund: updated, actor });
        await this.ports.get().addTimeline(tx, order.id, actor, {
          type: 'refund',
          message: `Refund of $${wholeCents(Money.of(posted.gross))}${
            route.method === 'manual' ? ' to be paid out manually' : ' sent to the original payment method'
          }`,
          data: { refundId: refund.id, amount: posted.gross },
        });
        // The order was rejected without a refund (it was a request): now that the money goes back, the customer is told it failed.
        await this.mails.orderFailed(tx, order.id);
      } else {
        await this.ports.get().cancelForRefund(tx, {
          orderId: order.id,
          actor,
          refundId: refund.id,
          reason: `Refund approved: ${refund.reason || 'refund requested'}`,
        });
      }
      if (route.method === 'manual') await this.refunds.complete(tx, refund.id, null);
      else await this.outbox.refund(tx, refund.id);
      const done = (await findStorefrontRefund(tx, refund.id))!;
      const view = (await this.views.build(tx, [done]))[0]!;
      await this.audit.record(tx, {
        action: 'approved refund',
        entityType: 'refund',
        entityId: refund.id,
        entityLabel: `${refundLabel(refund.id)} for ${orderLabel(order.id)}, $${wholeCents(Money.of(view.amount))}`,
        before: { status: 'requested' },
        after: { status: done.status, amount: view.amount, method: done.method },
      });
      return view;
    });
    return approved;
  }

  /**
   * Declines a waiting refund.
   *
   * @param staffId the staff member
   * @param id the refund
   * @param reason the message the customer reads
   * @returns the refund after the decision
   * @throws {AppError} `NOT_FOUND`; `REFUND_NOT_PENDING` (409); `VALIDATION_FAILED` (422, field `reason`)
   */
  async decline(staffId: number, id: number, reason: string): Promise<WireRefund> {
    const text = reason.trim();
    if (text.length < MIN_DECLINE_REASON_LENGTH || text.length > MAX_DECLINE_REASON_LENGTH) {
      const message = 'Give the customer a reason, at least a sentence.';
      throw new AppError('VALIDATION_FAILED', {
        detail: message,
        errors: [{ field: 'reason', code: 'invalid', message }],
      });
    }
    return this.db.runInTransaction(async ({ tx }) => {
      const first = await findStorefrontRefund(tx, id);
      if (!first) throw notFound();
      const refund = await lockRefund(tx, id);
      if (!refund) throw notFound();
      if (refund.status !== 'requested') {
        throw new AppError('REFUND_NOT_PENDING', { detail: `${refundLabel(id)} is no longer waiting for approval.` });
      }
      const done = (await updateRefundIn(tx, id, ['requested'], {
        status: 'rejected',
        note: text,
        approvedBy: staffId,
        updatedAt: this.clock.now(),
      }))!;
      const actor = { type: 'staff' as const, id: staffId };
      if (done.orderId !== null) {
        await this.ports.get().addTimeline(tx, done.orderId, actor, {
          type: 'refund',
          message: `Refund request declined: ${text}`,
          data: { refundId: id },
        });
      }
      // The customer reads the reason in an email written with the decline: it is rolled back with it.
      await this.mails.refundDeclined(tx, done, text);
      await this.audit.record(tx, {
        action: 'declined refund',
        entityType: 'refund',
        entityId: id,
        entityLabel: `${refundLabel(id)} for ${orderLabel(done.orderId ?? 0)}`,
        before: { status: 'requested' },
        after: { status: 'rejected', reason: text },
      });
      return (await this.views.build(tx, [done]))[0]!;
    });
  }

  /**
   * Sends a failed refund to the gateway again.
   *
   * @param id the refund
   * @returns the refund, `processing` again
   * @throws {AppError} `NOT_FOUND`; `REFUND_NOT_FAILED` (409)
   */
  async retry(id: number): Promise<WireRefund> {
    return this.db.runInTransaction(async ({ tx }) => {
      const first = await findStorefrontRefund(tx, id);
      if (!first) throw notFound();
      const refund = await lockRefund(tx, id);
      if (!refund) throw notFound();
      const done = await updateRefundIn(tx, id, ['failed'], {
        status: 'processing',
        note: '',
        updatedAt: this.clock.now(),
      });
      if (!done) throw new AppError('REFUND_NOT_FAILED', { detail: `${refundLabel(id)} did not fail at the gateway.` });
      await this.outbox.refund(tx, id);
      await this.audit.record(tx, {
        action: 'retried refund',
        entityType: 'refund',
        entityId: id,
        entityLabel: `${refundLabel(id)} for ${orderLabel(done.orderId ?? 0)}`,
        before: { status: 'failed' },
        after: { status: 'processing' },
      });
      return (await this.views.build(tx, [done]))[0]!;
    });
  }
}
