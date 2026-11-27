// OrderSupplierMoves: the orders module's door for the supplier flows of stage 6 (dispatch, poll, fetch, change-supplier). The suppliers
// module never touches `orders`: it asks this service to claim an order, move its dispatch state, record a supplier's result and
// read the figures its pages show. Moves that post money go through OrderTransitions; the others are applied here with the same
// guarded update, event and outbox rules, plus the supplier columns the generic path leaves alone.
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import { AccountDirectory } from '../../identity';
import { AuditService } from '../../platform';
import { type Order, type OrderEventType, orders } from '../db/schema';
import { isPrepaidOrder } from '../domain/door';
import { cancelWindowEnd } from '../domain/merchant-actions';
import {
  type OrderAction,
  type OrderTransition,
  type PaymentStop,
  decideOrderAction,
  isOpen,
  orderStateOf,
  paymentCanStop,
} from '../domain/order-machine';
import type { TimelineActor } from '../domain/order-timeline';
import {
  type OrderChanges,
  countEventsOfType,
  findOrder,
  insertEvents,
  storeLateReference,
  updateOrderGuarded,
} from '../infra/order.repository';
import {
  type DispatchClaim,
  type PollCandidate,
  type SupplierOrderCounts,
  type SupplierOrderUsage,
  type UnansweredClaim,
  type UnclaimedOrder,
  cancelWindowReads,
  claimDispatch,
  completedSpend,
  openOrderCounts,
  pollCandidates,
  supplierOrderUsage,
  unansweredClaims,
  unclaimedPending,
} from '../infra/order-supplier.repository';
import { OrderOutbox } from './order-outbox';
import {
  CHANGED_FIRST_DETAIL,
  type TransitionOutcome,
  OrderTransitions,
  paymentStopOfOrder,
  refusalError,
} from './order-transitions';

/** The supplier actions a no-money move applies. */
export type SupplierMoveAction = Extract<
  OrderAction,
  {
    kind:
      'staffDispatch' | 'dispatchResult' | 'dispatchBlocked' | 'requeueDispatch' | 'supplierResult' | 'changeSupplier';
  }
>;

/** The data of a timeline line: plain values only. */
export type EventData = Record<string, string | number | boolean | null>;

/** What a no-money move asks for. */
export interface SupplierMove {
  readonly orderId: number;
  readonly action: SupplierMoveAction;
  /** Who is recorded on the line: a staff member, the supplier or the system. */
  readonly actor: TimelineActor;
  /** The supplier columns written in the same guarded update as the state (reference, supplier, cost, send time). */
  readonly columns?: OrderChanges;
  /** The `data` of the machine's timeline line (the review reason, the supplier reference, the change). */
  readonly data?: EventData;
  /** Write the line even when the machine says nothing changes (a staff fetch that finds the order still running). */
  readonly writeOnNoop?: boolean;
  /** The audit verb phrase of a staff action; leave it out for the jobs. */
  readonly audit?: string;
  /** The claim this answer belongs to: the move applies only while `sent_at` is that time (decision 044). */
  readonly claimedAt?: Date;
  /** The supplier and reference a supplier's answer was asked about: the move applies only while the order still names them. */
  readonly asked?: { readonly supplierId: number; readonly supplierRef: string };
}

/** The result a supplier gave for an order, for {@link OrderSupplierMoves.settle}. */
export interface SupplierSettlement {
  readonly orderId: number;
  readonly result: 'completed' | 'rejected';
  readonly supplierId: number;
  /** The CODE of a completed order, or the reason of a rejected one. */
  readonly text: string | null;
  /** The reference the answer is about: it applies only while the order still names this supplier and reference (decision 044). */
  readonly supplierRef: string;
  readonly audit?: string;
}

/**
 * Why a supplier's acceptance is recorded on its own: the order `moved_on` (staff or the sweep acted, a newer claim exists) before the
 * answer was applied, or the answer's own transaction failed (`not_recorded`) while the order may still be `dispatching`.
 */
export type LateAcceptanceCause = 'moved_on' | 'not_recorded';

/** What {@link OrderSupplierMoves.recordLateAcceptance} did. */
export interface LateAcceptance {
  /** True when the reference was stored on the order (it had none and still named the supplier). */
  readonly stored: boolean;
  /** True when a waiting order was moved to `needs_attention` so that no second send follows. */
  readonly stopped: boolean;
}

/**
 * Moves orders for the supplier flows.
 *
 * Why: orders-suppliers-11 and decision 025: the machine (`decideOrderAction`) is the only rule book. A transition that posts money
 * (the supplier's STATUS 4 or 3) runs through `OrderTransitions.apply`, so the ledger, the timeline, the outbox and whatever the
 * order engine adds to a completion all stay in one place; the supplier's result text and `completed_at` are written right after,
 * in the same transaction. A transition that moves no money (sent, needs attention, staff dispatch, change of supplier) is applied
 * here so that the supplier columns and the event's data are written together with the state in one guarded update.
 *
 * Side effects (all on the caller's transaction): updates `orders`, inserts `order_events`, writes the `order.status_changed` and
 * `order.dispatch_requested` outbox rows the move calls for and an `audit_logs` row when `audit` is given.
 *
 * @see docs/decisions/025-order-state-machine.md
 */
@Injectable()
export class OrderSupplierMoves {
  constructor(
    private readonly transitions: OrderTransitions,
    private readonly outbox: OrderOutbox,
    private readonly audit: AuditService,
    private readonly directory: AccountDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads an order.
   *
   * @param db the database or a transaction
   * @param orderId the order
   * @returns the row, or `undefined`
   */
  find(db: DbExecutor, orderId: number): Promise<Order | undefined> {
    return findOrder(db, orderId);
  }

  /**
   * Reads what the payment of a storefront order says about sending it.
   *
   * Why: a storefront order whose payment is disputed, charged back or refunded in full is never sent: the dispatch job stops it in
   * `needs_attention` before it claims it (the reason is `PAYMENT_STOP_REASONS`), and a staff send is refused, so staff decide (a
   * won dispute lets them send it again).
   *
   * @param db the database or a transaction
   * @param order the order (an order held from a wallet is never stopped and its payment is not read: the door decides)
   * @returns the stop, or `undefined` when nothing stops the send
   */
  paymentStop(db: DbExecutor, order: Pick<Order, 'id' | 'source'>): Promise<PaymentStop | undefined> {
    return paymentStopOfOrder(db, order);
  }

  /**
   * Tells until when the dispatch of an order waits for its cancel window.
   *
   * Why: decision 075: a website order of a service that allows cancellation (now) is not claimed for a supplier call before
   * `placed_at + CANCEL_WINDOW_MS`, so the merchant can still cancel it; the dispatch job asks here before it claims and waits until the
   * time this returns. The rule is `cancelWindowEnd`, the same one the portal's `cancelUntil` reads, on the service's `allow_cancel` as it
   * is now and the order's `dispatch` events, read through this module's own queries.
   *
   * @param db the database or a transaction
   * @param order the order as the job read it
   * @returns the end of the window while the order is inside it (the injected clock's time), else `null` (send it now)
   */
  async cancelWindowEnd(db: DbExecutor, order: Order): Promise<Date | null> {
    const reads = await cancelWindowReads(db, order.id);
    if (!reads) return null;
    return cancelWindowEnd({ order, ...reads }, this.clock.now());
  }

  /**
   * Claims an order for one dispatch attempt and writes its `dispatch` event.
   *
   * @param tx the claim's transaction
   * @param claim the order, the chosen supplier service, its unit cost and the time
   * @param supplierName the supplier's name for the timeline line
   * @returns the claimed order, or `undefined` when it could not be claimed (another run has it, or it left `pending`)
   */
  async claim(tx: DbExecutor, claim: DispatchClaim, supplierName: string): Promise<Order | undefined> {
    const claimed = await claimDispatch(tx, claim);
    if (!claimed) return undefined;
    await insertEvents(tx, [
      {
        orderId: claim.orderId,
        type: 'dispatch',
        actorType: 'system',
        actorId: null,
        data: { message: `Sent to ${supplierName}`, supplier: supplierName, supplierId: claim.supplierId },
      },
    ]);
    return claimed;
  }

  /**
   * Applies a move that posts no money.
   *
   * @param tx the caller's transaction
   * @param move the order, the action and what to write with it
   * @returns the order after the move, whether anything was written and the machine's decision
   * @throws {AppError} `NOT_FOUND`; the machine's `409` refusals (`ALREADY_SENT` while the order is being sent; `INVALID_TRANSITION` for
   *   a staff send, or a change of supplier that sends, of a storefront order whose payment is disputed, charged back or refunded in
   *   full); `INVALID_TRANSITION` when the guarded update found the order already changed, when `claimedAt` is no longer the order's
   *   `sent_at`, or when `asked` names a supplier or reference the order no longer has
   * @throws {Error} when the action would post money (a programming error: use {@link OrderSupplierMoves.settle})
   */
  async move(tx: DbExecutor, move: SupplierMove): Promise<TransitionOutcome> {
    const order = await findOrder(tx, move.orderId);
    if (!order) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    if (
      (move.claimedAt !== undefined && order.sentAt?.getTime() !== move.claimedAt.getTime()) ||
      (move.asked !== undefined &&
        (order.supplierId !== move.asked.supplierId || order.supplierRef !== move.asked.supplierRef))
    ) {
      throw new AppError('INVALID_TRANSITION', { detail: CHANGED_FIRST_DETAIL });
    }
    // Only a staff send or a change of supplier that sends asks for the payment of a storefront order.
    const paymentStop = paymentCanStop(move.action) ? await paymentStopOfOrder(tx, order) : undefined;
    const decision = decideOrderAction(orderStateOf(order, false, false, paymentStop), move.action);
    if (!decision.ok) throw refusalError(decision);
    if (decision.money !== null) throw new Error(`The action ${move.action.kind} posts money: use settle().`);
    if (decision.noop) {
      if (move.writeOnNoop) {
        await this.writeLine(tx, order, order.status, decision, move);
        if (move.audit !== undefined) await this.record(tx, move.audit, order, order);
      }
      return { order, applied: false, decision };
    }
    const updated = await updateOrderGuarded(
      tx,
      order.id,
      {
        status: order.status,
        dispatchState: order.dispatchState,
        verificationStatus: order.verificationStatus,
        sentAt: move.claimedAt ?? order.sentAt,
        ...(move.asked === undefined ? {} : { supplier: move.asked }),
      },
      {
        status: decision.next.status,
        dispatchState: decision.next.dispatchState,
        verificationStatus: decision.next.verificationStatus,
        ...move.columns,
      },
    );
    if (!updated) throw new AppError('INVALID_TRANSITION', { detail: CHANGED_FIRST_DETAIL });
    await this.writeLine(tx, order, updated.status, decision, move);
    if (decision.statusChanged) {
      await this.outbox.statusChanged(tx, {
        orderId: order.id,
        accountId: order.accountId,
        source: order.source,
        fromStatus: order.status,
        toStatus: updated.status,
      });
    }
    if (decision.enqueueDispatch) await this.outbox.dispatchRequested(tx, order.id);
    if (move.audit !== undefined) await this.record(tx, move.audit, order, updated);
    return { order: updated, applied: true, decision };
  }

  /**
   * Records the supplier's STATUS 4 (completed) or STATUS 3 (rejected) for an order.
   *
   * Why: scenarios success and reject: the hold becomes revenue with the supplier cost booked, or goes back to the wallet. The
   * state change, money, timeline and outbox come from `OrderTransitions.apply`; the supplier's text becomes the order's result
   * (`result_code`) and `completed_at` is set, in the same transaction.
   *
   * @param tx the caller's transaction
   * @param settlement the order, the result and the supplier's text
   * @returns what the transition did
   * @throws {AppError} the machine's refusals (`INVALID_TRANSITION` when the order is no longer `sent` or `needs_attention`, or no
   *   longer names the supplier and reference the answer is about; `ORDER_NOT_OPEN`), `NOT_FOUND`
   */
  async settle(tx: DbExecutor, settlement: SupplierSettlement): Promise<TransitionOutcome> {
    const outcome = await this.transitions.apply(tx, {
      orderId: settlement.orderId,
      action: { kind: 'supplierResult', result: settlement.result },
      actor: { type: 'supplier', id: settlement.supplierId },
      asked: { supplierId: settlement.supplierId, supplierRef: settlement.supplierRef },
      ...(settlement.result === 'rejected' ? { reason: settlement.text ?? 'Rejected by the supplier' } : {}),
      ...(settlement.audit === undefined ? {} : { audit: settlement.audit }),
    });
    if (outcome.applied) {
      const [row] = await tx
        .update(orders)
        .set({
          resultCode:
            settlement.result === 'rejected' ? (settlement.text ?? 'Rejected by the supplier') : settlement.text,
          resultComment: null,
          completedAt: this.clock.now(),
        })
        .where(eq(orders.id, settlement.orderId))
        .returning();
      return { ...outcome, order: row ?? outcome.order };
    }
    return outcome;
  }

  /**
   * Appends one line to an order's timeline.
   *
   * @param tx the caller's transaction
   * @param orderId the order
   * @param line the type, the actor and the data
   */
  async addLine(
    tx: DbExecutor,
    orderId: number,
    line: { type: OrderEventType; actor: TimelineActor; data: EventData },
  ): Promise<void> {
    await insertEvents(tx, [
      { orderId, type: line.type, actorType: line.actor.type, actorId: line.actor.id, data: line.data },
    ]);
  }

  /**
   * Counts the open orders of suppliers (`openOrders`, `reviewOrders` of the suppliers page).
   *
   * @param db the database
   * @param supplierIds the suppliers
   * @returns the counts by supplier id
   */
  openCounts(db: DbExecutor, supplierIds: readonly number[]): Promise<Map<number, SupplierOrderCounts>> {
    return openOrderCounts(db, supplierIds);
  }

  /**
   * The supplier cost of the completed orders of suppliers since a time (the runway's spending rate).
   *
   * @param db the database
   * @param supplierIds the suppliers
   * @param since the start of the window
   * @returns the cost by supplier id, 4 decimals
   */
  spendSince(db: DbExecutor, supplierIds: readonly number[], since: Date): Promise<Map<number, string>> {
    return completedSpend(db, supplierIds, since);
  }

  /**
   * How orders use a supplier (the delete guard).
   *
   * @param db the transaction of the delete
   * @param supplierId the supplier
   * @returns the number of orders that reference it and how many are open
   */
  usageOf(db: DbExecutor, supplierId: number): Promise<SupplierOrderUsage> {
    return supplierOrderUsage(db, supplierId);
  }

  /**
   * Finds the sent orders that have waited longest for a status poll.
   *
   * @param db the database
   * @param limit the most orders returned
   * @returns the candidates, the longest unasked first
   */
  pollCandidates(db: DbExecutor, limit: number): Promise<PollCandidate[]> {
    return pollCandidates(db, this.clock.now(), limit);
  }

  /**
   * Records a supplier's acceptance that the order's own answer did not record.
   *
   * Why: decision 044: the supplier holds the order and will charge for it, so its reference must not live only in the call log. The
   * reference is stored where the order has none and still names that supplier; a `review` line says who accepted and under which
   * reference; an order that waits in `pending` for another send is moved to `needs_attention` instead, so the next job does not send
   * it a second time. An order a newer attempt has `dispatching` or `sent` is not moved (that would break the attempt): this includes
   * the order whose answer could not be recorded (`cause` `not_recorded`) and is still `dispatching` under the same claim, which keeps
   * its state: the dispatch sweep moves it later and staff can then fetch the result with the stored reference.
   *
   * Side effects (on the caller's transaction): may update `orders.supplier_ref`; writes one `review` event, or the move to
   * `needs_attention` with its event; no outbox row.
   *
   * @param tx the caller's own transaction (a failure here must not undo anything else)
   * @param input the order, the supplier that answered (id and name), its reference and why it is recorded here (`moved_on` by default;
   *   it only picks the sentence the review line carries)
   * @returns what was recorded, or `undefined` when the order does not exist
   * @see docs/decisions/044-dispatch-state.md
   */
  async recordLateAcceptance(
    tx: DbExecutor,
    input: {
      orderId: number;
      supplierId: number;
      supplierName: string;
      reference: string;
      cause?: LateAcceptanceCause;
    },
  ): Promise<LateAcceptance | undefined> {
    const order = await findOrder(tx, input.orderId);
    if (!order) return undefined;
    const stored = await storeLateReference(tx, input.orderId, input.supplierId, input.reference);
    const reason =
      input.cause === 'not_recorded'
        ? `${input.supplierName} accepted this order under reference ${input.reference}, but the answer could not be recorded. Check it with the supplier before sending it again.`
        : `${input.supplierName} accepted this order (reference ${input.reference}) after it had moved on. Check it with the supplier before sending it again.`;
    const data: EventData = {
      message: reason,
      reason,
      ref: input.reference,
      supplier: input.supplierName,
      supplierId: input.supplierId,
      referenceStored: stored,
    };
    const actor: TimelineActor = { type: 'supplier', id: input.supplierId };
    if (isOpen(order.status) && order.dispatchState === 'pending' && order.sentAt === null) {
      try {
        await this.move(tx, { orderId: input.orderId, action: { kind: 'dispatchBlocked' }, actor, data });
        return { stored, stopped: true };
      } catch (error) {
        // A job claimed the order meanwhile: it is now in flight, so the line below is all that is written.
        if (!(error instanceof AppError && (error.code === 'INVALID_TRANSITION' || error.code === 'ORDER_NOT_OPEN'))) {
          throw error;
        }
      }
    }
    await insertEvents(tx, [
      { orderId: input.orderId, type: 'review', actorType: actor.type, actorId: actor.id, data },
    ]);
    return { stored, stopped: false };
  }

  /**
   * Finds the sends whose answer has not been recorded for longer than the supplier's timeout plus a margin.
   *
   * @param db the database
   * @param marginMs added to the supplier's timeout
   * @param limit the most claims returned
   * @returns the claims, the oldest first
   */
  unansweredClaims(db: DbExecutor, marginMs: number, limit: number): Promise<UnansweredClaim[]> {
    return unansweredClaims(db, this.clock.now(), marginMs, limit);
  }

  /**
   * Finds the orders that wait for a first send and were placed before a given wait.
   *
   * @param db the database
   * @param waitedMs how long an order must have waited
   * @param limit the most orders returned
   * @returns the orders, the oldest first
   */
  unclaimedPending(db: DbExecutor, waitedMs: number, limit: number): Promise<UnclaimedOrder[]> {
    return unclaimedPending(db, new Date(this.clock.nowMs() - waitedMs), limit);
  }

  /**
   * Counts the dispatch requests the system itself made again for an order.
   *
   * Why: decision 044 limits the sweep to a few automatic requests in an order's life; each one writes a `retry` line by the system.
   *
   * @param db the database
   * @param orderId the order
   * @returns how many `retry` events by the system the order has
   */
  automaticRequeues(db: DbExecutor, orderId: number): Promise<number> {
    return countEventsOfType(db, orderId, 'retry', 'system');
  }

  private async writeLine(
    tx: DbExecutor,
    order: Order,
    toStatus: Order['status'],
    decision: OrderTransition,
    move: SupplierMove,
  ): Promise<void> {
    await insertEvents(tx, [
      {
        orderId: order.id,
        type: decision.event,
        fromStatus: toStatus === order.status ? null : order.status,
        toStatus: toStatus === order.status ? null : toStatus,
        actorType: move.actor.type,
        actorId: move.actor.id,
        data: move.data ?? {},
      },
    ]);
  }

  private async record(tx: DbExecutor, action: string, before: Order, after: Order): Promise<void> {
    // The label names the account for an order held from a wallet only, as before; a shop order's buyer stays out of the audit text.
    const buyer = isPrepaidOrder(before) ? undefined : await this.directory.findById(tx, before.accountId);
    await this.audit.record(tx, {
      action,
      entityType: 'order',
      entityId: before.id,
      entityLabel: buyer ? `ORD-${before.id} for ${buyer.name}` : `ORD-${before.id}`,
      before: { status: before.status, dispatchState: before.dispatchState },
      after: { status: after.status, dispatchState: after.dispatchState },
    });
  }
}
