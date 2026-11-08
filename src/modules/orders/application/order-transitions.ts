// OrderTransitions: the one place that applies a state machine decision to an order (decision 025). Every route and job that moves an
// order (staff actions, the merchant's cancel and verify, bulk reply, and later the supplier jobs and risk) calls `apply`.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import { StorefrontMails } from '../../money';
import { AuditService } from '../../platform';
import type { Order } from '../db/schema';
import {
  type OrderAction,
  type OrderRefusal,
  type OrderState,
  type OrderTransition,
  decideOrderAction,
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
import { OrderCompletionListeners } from './order-completion-listeners';
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
}

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
 * @param refusal the machine's refusal
 * @returns the `409` error with its readable detail
 */
export function refusalError(refusal: OrderRefusal): AppError {
  return new AppError(refusal, { detail: REFUSAL_DETAILS[refusal] });
}

/** The ledger records a supplier's action as the system's: only staff, merchants, customers and the system post. */
function ledgerActorOf(actor: TimelineActor): LedgerActor {
  return actor.type === 'supplier' ? { type: 'system', id: null } : { type: actor.type, id: actor.id };
}

/** What the machine needs to know about a stored order. */
function stateOf(order: Order, completedBefore: boolean): OrderState {
  return {
    status: order.status,
    dispatchState: order.dispatchState,
    verificationStatus: order.verificationStatus,
    channel: order.clientId === null ? 'b2c' : 'b2b',
    completedBefore,
  };
}

/**
 * Applies decisions of the order state machine.
 *
 * Why: decision 025: every transition is one transaction: the machine decides (`decideOrderAction`, the only rules), the order
 * changes with a guarded `UPDATE ... WHERE status = $from AND dispatch_state = $from` (zero rows: another request won, `409
 * INVALID_TRANSITION`, and nothing else is written), the money posts through `OrderLedger`, the timeline lines and the audit row are
 * written and `order.status_changed` goes to the outbox when the status changed. A transition either does all of it or none of it.
 *
 * Side effects (all on the caller's transaction): updates `orders`; inserts `ledger_transactions` and entries; inserts
 * `order_events`; inserts one `outbox_events` row when the status changed and one more when the dispatch job must run; inserts an
 * `audit_logs` row when `audit` is given; whatever the registered completion listeners write (commission accruals) on a completion, a
 * reopen or a refund; and a `notifications` row (and its send event) for a storefront customer whose order was completed or rejected
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
    private readonly completions: OrderCompletionListeners,
    private readonly mails: StorefrontMails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Applies one action to one order inside the caller's transaction.
   *
   * @param tx the caller's transaction
   * @param request the order, the action, who acts and the texts that go with it
   * @returns the order after the change, whether anything was written, and the machine's decision
   * @throws {AppError} `NOT_FOUND` (an unknown order, or another merchant's); the machine's `409` refusals; `INVALID_TRANSITION`
   *   when the guarded update found the order already changed; `INSUFFICIENT_FUNDS` from the ledger
   */
  async apply(tx: DbExecutor, request: TransitionRequest): Promise<TransitionOutcome> {
    const order = await findOrder(tx, request.orderId);
    if (!order || (request.onlyClientId !== undefined && order.clientId !== request.onlyClientId)) {
      throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    }
    // Only a storefront order needs to know whether it was delivered before: a reopened one is refunded from /admin/refunds.
    const completedBefore = order.clientId === null && (await countEventsOfType(tx, order.id, 'completed')) > 0;
    const decision = decideOrderAction(stateOf(order, completedBefore), request.action);
    if (!decision.ok) throw refusalError(decision.refusal);
    if (decision.noop) return { order, applied: false, decision };

    const now = this.clock.now();
    const updated = await updateOrderGuarded(
      tx,
      order.id,
      { status: order.status, dispatchState: order.dispatchState, verificationStatus: order.verificationStatus },
      {
        status: decision.next.status,
        dispatchState: decision.next.dispatchState,
        verificationStatus: decision.next.verificationStatus,
        ...this.columnsFor(decision, request, now),
      },
    );
    if (!updated) {
      throw new AppError('INVALID_TRANSITION', {
        detail: 'Another request changed this order first. Reload it and try again.',
      });
    }

    // Lock order (feature 11): a reversal locks the order's commission accruals before the ledger locks any wallet, as an approval does.
    await this.completions.beforeMove(tx, updated, decision.money);
    // A settlement is numbered by how many completions came before it, and books the supplier cost only once (B17).
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
    // Feature 11: commissions accrue on a completion and are reversed with a reopen or a refund, in this same transaction.
    await this.completions.afterMove(tx, updated, decision.money, ledgerActorOf(request.actor));

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
    // for staff is told when it is approved). The mail is written in this transaction, so it exists only if the transition does.
    if (updated.clientId === null && updated.customerId !== null && order.status !== updated.status) {
      if (updated.status === 'completed') {
        await this.mails.orderCompleted(tx, { orderId: order.id, completions: completions + 1 });
      } else if (updated.status === 'rejected' && moved.posted) {
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
