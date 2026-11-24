// OrderTransitions: the one place that applies a state machine decision to an order (decision 025). Every route and job that moves an
// order (staff actions, the merchant's cancel and verify, bulk reply, and later the supplier jobs and risk) calls `apply`.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import { StorefrontMails, orderPaymentStatus } from '../../money';
import { AuditService } from '../../platform';
import type { Order } from '../db/schema';
import {
  type OrderAction,
  type OrderRefusal,
  type OrderRefused,
  type OrderTransition,
  PAYMENT_STOP_REASONS,
  type PaymentStop,
  decideOrderAction,
  orderStateOf,
  paymentCanStop,
  paymentStopOf,
} from '../domain/order-machine';
import { type TimelineActor, VERIFICATION_REFUND_REASON, transitionLines } from '../domain/order-timeline';
import { merchantOf } from '../infra/foreign-reads.repository';
import {
  type OrderChanges,
  costAlreadyBooked,
  countEventsOfType,
  findOrder,
  insertEvents,
  updateOrderGuarded,
} from '../infra/order.repository';
import { type LedgerActor, OrderLedger } from './order-ledger';
import { OrderOutbox } from './order-outbox';

/** What a use case asks of {@link OrderTransitions.apply}. */
export interface TransitionRequest {
  readonly orderId: number;
  readonly action: OrderAction;
  /** Who acts: the staff member, the merchant, or the system. */
  readonly actor: TimelineActor;
  /** The merchant a portal call acts for: another merchant's order is `404`, so ids cannot be probed. */
  readonly onlyClientId?: number;
  /** The buyer-visible reason of a reject, refund, reopen or cancel. */
  readonly reason?: string | undefined;
  /** The result text of a reply. */
  readonly code?: string | undefined;
  /** The optional comment of a reply. */
  readonly comment?: string | undefined;
  /** The note of a verification decision. */
  readonly note?: string | undefined;
  /** The storefront refund this transition pays out (feature 16): the ledger posting is linked to it instead of opening a new refund. */
  readonly refundId?: number | undefined;
  /**
   * The audit row of a staff action: the demo's verb phrase (`completed order`, `rejected order`, ...). Leave it out for an action
   * that is not a staff write (the merchant's own cancel and verify, jobs).
   */
  readonly audit?: string;
  /**
   * The use case's own check of the decided transition, run after the machine's refusals and before anything is written (decision 046:
   * a staff reject that gives a storefront payment back needs the refund permission as well). It throws to stop the transition.
   */
  readonly authorize?: (tx: DbExecutor, decision: OrderTransition, order: Order) => Promise<void>;
  /**
   * The supplier and reference a supplier's answer was asked about: the transition applies only while the order still names them
   * (decision 044).
   */
  readonly asked?: { readonly supplierId: number; readonly supplierRef: string };
}

/** The sentence of `INVALID_TRANSITION` when a guarded update found the order already changed. */
export const CHANGED_FIRST_DETAIL = 'Another request changed this order first. Reload it and try again.';

/** The sentence staff read when an action waits for a send in flight (`ALREADY_SENT`, decision 044). */
export const SEND_IN_PROGRESS_DETAIL =
  "This order is being sent to its supplier right now: wait for the supplier's answer, then reload the order.";

/** What {@link OrderTransitions.apply} did. */
export interface TransitionOutcome {
  /** The order after the transition (unchanged for a no-op). */
  readonly order: Order;
  /** False when the machine answered a no-op (nothing was written). */
  readonly applied: boolean;
  /** The machine's decision. */
  readonly decision: OrderTransition;
}

/** The refusal sentences staff and merchants read next to the catalog title (`detail`). */
const REFUSAL_DETAILS: Readonly<Record<OrderRefusal, string>> = {
  ORDER_NOT_OPEN: 'Only an open order can be changed.',
  ORDER_HELD: 'This order is held for risk review: release or refund it from the risk queue first.',
  ALREADY_SENT: 'The supplier already has this order: fetch it, or change supplier with a reset reference first.',
  INVALID_TRANSITION: 'This change is not allowed while the order is in its current state.',
  USE_REFUNDS: 'This storefront order was delivered: refund it from the Refunds page.',
  NOT_MANUAL: 'Only an order in the manual queue can be accepted.',
  ORDER_NOT_COMPLETED: 'Only a completed order can be reopened or refunded.',
  NOT_IN_VERIFICATION: 'This order has no verification request to decide.',
};

/**
 * Turns a refusal of the machine into the error the route answers.
 *
 * Why: decision 044: an action refused only because the supplier is being called gets a sentence that says to wait; the code stays
 * `ALREADY_SENT`, so no client needs a new case. An action refused because of the payment of a storefront order says so; the code stays
 * `INVALID_TRANSITION`.
 *
 * @param refused the machine's refusal, or the whole refused decision (its `sending` flag picks the wait sentence, its `payment` flag
 *   the payment's sentence)
 * @returns the `409` error with its readable detail
 */
export function refusalError(refused: OrderRefusal | OrderRefused): AppError {
  if (typeof refused === 'string') return new AppError(refused, { detail: REFUSAL_DETAILS[refused] });
  if (refused.payment !== undefined) {
    return new AppError(refused.refusal, { detail: PAYMENT_STOP_REASONS[refused.payment] });
  }
  return new AppError(refused.refusal, {
    detail: refused.sending === true ? SEND_IN_PROGRESS_DETAIL : REFUSAL_DETAILS[refused.refusal],
  });
}

/**
 * Reads what the payment of a storefront order says about releasing it from a risk hold, sending it to a supplier, or accepting and
 * completing it by staff.
 *
 * Why: a storefront order whose payment is disputed, charged back or refunded in full is not released, sent, accepted or completed by
 * staff (the machine's `paymentStop`); the payment belongs to the money module, which answers its status. A merchant's order is never
 * read.
 *
 * @param db the database or the caller's transaction
 * @param order the order
 * @returns the stop, or `undefined` when the payment stands or the order is a merchant's
 */
export async function paymentStopOfOrder(
  db: DbExecutor,
  order: Pick<Order, 'id' | 'clientId'>,
): Promise<PaymentStop | undefined> {
  if (order.clientId !== null) return undefined;
  return paymentStopOf(await orderPaymentStatus(db, order.id));
}

/** The ledger records a supplier's action as the system's: only staff, merchants, customers and the system post. */
function ledgerActorOf(actor: TimelineActor): LedgerActor {
  return actor.type === 'supplier' ? { type: 'system', id: null } : { type: actor.type, id: actor.id };
}

/**
 * Applies decisions of the order state machine.
 *
 * Why: decision 025: every transition is one transaction: the machine decides (`decideOrderAction`, the only rules), the order
 * changes with a guarded `UPDATE ... WHERE status = $from AND dispatch_state = $from AND sent_at IS NOT DISTINCT FROM $from` (zero
 * rows: another request won, `409 INVALID_TRANSITION`, and nothing else is written), the money posts through `OrderLedger`, the timeline lines and the audit row are
 * written and `order.status_changed` goes to the outbox when the status changed. A transition either does all of it or none of it.
 *
 * Side effects (all on the caller's transaction): updates `orders`; inserts `ledger_transactions` and entries; inserts
 * `order_events`; inserts one `outbox_events` row when the status changed and one more when the dispatch job must run; inserts an
 * `audit_logs` row when `audit` is given; and a `notifications` row (and its send event) for a storefront customer whose order was completed or rejected
 * and refunded.
 *
 * @see docs/decisions/025-order-state-machine.md
 */
@Injectable()
export class OrderTransitions {
  constructor(
    private readonly ledger: OrderLedger,
    private readonly outbox: OrderOutbox,
    private readonly audit: AuditService,
    private readonly mails: StorefrontMails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Applies one action to one order inside the caller's transaction.
   *
   * @param tx the caller's transaction
   * @param request the order, the action, who acts and the texts that go with it
   * @returns the order after the change, whether anything was written, and the machine's decision
   * @throws {AppError} `NOT_FOUND` (an unknown order, or another merchant's); the machine's `409` refusals (`ALREADY_SENT` also while
   *   the order is being sent to its supplier, and for a merchant's cancel of an order that has a `dispatch` event;
   *   `INVALID_TRANSITION` for the release, a staff send, a change of supplier that sends, an accept or a staff reply (of an order never
   *   delivered before) of a storefront order whose payment is disputed, charged back or refunded in full); whatever the request's `authorize` throws (`FORBIDDEN`, decision
   *   046); `INVALID_TRANSITION` when the guarded update found the order already changed, or when `asked` names a supplier or reference
   *   the order no longer has; `INSUFFICIENT_FUNDS` from the ledger
   */
  async apply(tx: DbExecutor, request: TransitionRequest): Promise<TransitionOutcome> {
    const order = await findOrder(tx, request.orderId);
    if (!order || (request.onlyClientId !== undefined && order.clientId !== request.onlyClientId)) {
      throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    }
    if (
      request.asked !== undefined &&
      (order.supplierId !== request.asked.supplierId || order.supplierRef !== request.asked.supplierRef)
    ) {
      throw new AppError('INVALID_TRANSITION', { detail: CHANGED_FIRST_DETAIL });
    }
    // Only a storefront order needs to know whether it was delivered before: a reopened one is refunded from /admin/refunds.
    const completedBefore = order.clientId === null && (await countEventsOfType(tx, order.id, 'completed')) > 0;
    // Only the merchant's cancel asks whether the order was ever claimed for a supplier call (decision 044): no extra read otherwise.
    const everDispatched = request.action.kind === 'cancel' && (await countEventsOfType(tx, order.id, 'dispatch')) > 0;
    // Only a release, a send, an accept or a staff reply asks for the payment of a storefront order.
    const paymentStop = paymentCanStop(request.action) ? await paymentStopOfOrder(tx, order) : undefined;
    const decision = decideOrderAction(
      orderStateOf(order, completedBefore, everDispatched, paymentStop),
      request.action,
    );
    if (!decision.ok) throw refusalError(decision);
    if (decision.noop) return { order, applied: false, decision };
    if (request.authorize) await request.authorize(tx, decision, order);

    const now = this.clock.now();
    const updated = await updateOrderGuarded(
      tx,
      order.id,
      {
        status: order.status,
        dispatchState: order.dispatchState,
        verificationStatus: order.verificationStatus,
        sentAt: order.sentAt,
        ...(request.asked === undefined ? {} : { supplier: request.asked }),
      },
      {
        status: decision.next.status,
        dispatchState: decision.next.dispatchState,
        verificationStatus: decision.next.verificationStatus,
        ...this.columnsFor(decision, request, now),
      },
    );
    if (!updated) throw new AppError('INVALID_TRANSITION', { detail: CHANGED_FIRST_DETAIL });

    // A settlement is numbered by how many completions came before it, and books the supplier cost once per supplier acceptance (B17).
    const settling = decision.money === 'complete' || decision.money === 'b2c_deliver';
    const completions = settling ? await countEventsOfType(tx, order.id, 'completed') : 0;
    const moved = await this.ledger.move(tx, updated, decision.money, {
      actor: ledgerActorOf(request.actor),
      completedBefore: completions,
      costBooked: settling ? await costAlreadyBooked(tx, order.id) : false,
      refundId: request.refundId,
      // A risk refund is always paid out: the rules decided to give the money back, which is not a failed delivery (`autoRefundFailed`).
      systemDecided:
        (request.actor.type === 'supplier' || request.actor.type === 'system') && request.action.kind !== 'riskRefund',
    });

    const lines = transitionLines(decision.event, decision.money, {
      actor: request.actor,
      from: order.status,
      to: updated.status,
      reason: request.reason,
      decision: request.action.kind === 'verification' ? request.action.decision : undefined,
      note: request.note,
      money: moved,
      dispatchState: updated.dispatchState,
    });
    await insertEvents(
      tx,
      lines.map((entry) => ({
        orderId: order.id,
        type: entry.type,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actorType: entry.actor.type,
        actorId: entry.actor.id,
        data: entry.data,
      })),
    );

    if (decision.statusChanged) {
      await this.outbox.statusChanged(tx, {
        orderId: order.id,
        clientId: order.clientId,
        fromStatus: order.status,
        toStatus: updated.status,
      });
    }
    if (decision.enqueueDispatch) await this.outbox.dispatchRequested(tx, order.id);

    // A storefront customer hears about the end of their order: delivered, or rejected with the money sent back (a refund request that waits
    // for staff is told when it is approved; a charged-back payment sends nothing back). The mail is written in this transaction, so it exists
    // only if the transition does.
    if (updated.clientId === null && updated.customerId !== null && order.status !== updated.status) {
      if (updated.status === 'completed') {
        await this.mails.orderCompleted(tx, { orderId: order.id, completions: completions + 1 });
      } else if (updated.status === 'rejected' && moved.posted && moved.chargedBack !== true) {
        await this.mails.orderFailed(tx, order.id);
      }
    }

    if (request.audit !== undefined) await this.record(tx, request.audit, order, updated);
    return { order: updated, applied: true, decision };
  }

  /** The columns beyond the state that a decision writes: the result texts and the completion time. */
  private columnsFor(decision: OrderTransition, request: TransitionRequest, now: Date): OrderChanges {
    const to = decision.next.status;
    switch (request.action.kind) {
      case 'reply':
        return {
          resultCode: request.code ?? null,
          resultComment: request.comment?.trim() ? request.comment.trim() : null,
          completedAt: now,
        };
      case 'reject':
      case 'cancel':
        return { resultCode: request.reason ?? null, resultComment: null, completedAt: now };
      // A refused held order (`riskRefund`) ends like a rejection: the reason is the result and the order is closed now.
      case 'refund':
      case 'riskRefund':
      case 'refundApproved':
        return { resultCode: request.reason ?? null, resultComment: null, completedAt: now };
      case 'verification':
        return to === 'rejected'
          ? { resultCode: request.note?.trim() || VERIFICATION_REFUND_REASON, resultComment: null, completedAt: now }
          : {};
      case 'reopen':
        // The order is open again: the old result must not show (the merchant's Dhru status would carry a stale CODE).
        return { resultCode: null, resultComment: null, completedAt: null };
      // The other actions change the state only (the supplier jobs, which feature 6 adds, write their own columns).
      case 'accept':
      case 'requestVerification':
      case 'staffDispatch':
      case 'dispatchResult':
      case 'dispatchBlocked':
      case 'requeueDispatch':
      case 'supplierResult':
      case 'changeSupplier':
      case 'riskApprove':
        return {};
    }
  }

  private async record(tx: DbExecutor, action: string, before: Order, after: Order): Promise<void> {
    const merchant = before.clientId === null ? undefined : await merchantOf(tx, before.clientId);
    await this.audit.record(tx, {
      action,
      entityType: 'order',
      entityId: before.id,
      entityLabel: merchant ? `ORD-${before.id} for ${merchant.name}` : `ORD-${before.id}`,
      before: { status: before.status, verificationStatus: before.verificationStatus },
      after: { status: after.status, verificationStatus: after.verificationStatus },
    });
  }
}
