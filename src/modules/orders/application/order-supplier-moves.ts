// OrderSupplierMoves: the orders module's door for the supplier flows of stage 6 (dispatch, poll, fetch, change-supplier). The suppliers
// module never touches `orders`: it asks this service to claim an order, move its dispatch state, record a supplier's result and
// read the figures its pages show. Moves that post money go through OrderTransitions; the others are applied here with the same
// guarded update, event and outbox rules, plus the supplier columns the generic path leaves alone.
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import { AuditService } from '../../platform';
import { type Order, type OrderEventType, orders } from '../db/schema';
import { type OrderAction, type OrderTransition, decideOrderAction } from '../domain/order-machine';
import type { TimelineActor } from '../domain/order-timeline';
import { merchantOf } from '../infra/foreign-reads.repository';
import { type OrderChanges, findOrder, insertEvents, updateOrderGuarded } from '../infra/order.repository';
import {
  type DispatchClaim,
  type PollCandidate,
  type SupplierOrderCounts,
  type SupplierOrderUsage,
  claimDispatch,
  completedSpend,
  openOrderCounts,
  pollCandidates,
  supplierOrderUsage,
} from '../infra/order-supplier.repository';
import { OrderOutbox } from './order-outbox';
import { type TransitionOutcome, OrderTransitions, refusalError } from './order-transitions';

/** The supplier actions a no-money move applies. */
export type SupplierMoveAction = Extract<
  OrderAction,
  { kind: 'staffDispatch' | 'dispatchResult' | 'supplierResult' | 'changeSupplier' }
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
}

/** The result a supplier gave for an order, for {@link OrderSupplierMoves.settle}. */
export interface SupplierSettlement {
  readonly orderId: number;
  readonly result: 'completed' | 'rejected';
  readonly supplierId: number;
  /** The CODE of a completed order, or the reason of a rejected one. */
  readonly text: string | null;
  readonly audit?: string;
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
   * @throws {AppError} `NOT_FOUND`; the machine's `409` refusals; `INVALID_TRANSITION` when the guarded update found the order
   *   already changed
   * @throws {Error} when the action would post money (a programming error: use {@link OrderSupplierMoves.settle})
   */
  async move(tx: DbExecutor, move: SupplierMove): Promise<TransitionOutcome> {
    const order = await findOrder(tx, move.orderId);
    if (!order) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    const decision = decideOrderAction(
      {
        status: order.status,
        dispatchState: order.dispatchState,
        verificationStatus: order.verificationStatus,
        channel: order.clientId === null ? 'b2c' : 'b2b',
        completedBefore: false,
      },
      move.action,
    );
    if (!decision.ok) throw refusalError(decision.refusal);
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
      { status: order.status, dispatchState: order.dispatchState, verificationStatus: order.verificationStatus },
      {
        status: decision.next.status,
        dispatchState: decision.next.dispatchState,
        verificationStatus: decision.next.verificationStatus,
        ...move.columns,
      },
    );
    if (!updated) {
      throw new AppError('INVALID_TRANSITION', {
        detail: 'Another request changed this order first. Reload it and try again.',
      });
    }
    await this.writeLine(tx, order, updated.status, decision, move);
    if (decision.statusChanged) {
      await this.outbox.statusChanged(tx, {
        orderId: order.id,
        clientId: order.clientId,
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
   * @throws {AppError} the machine's refusals (`INVALID_TRANSITION` when the order is no longer `sent` or `needs_attention`,
   *   `ORDER_NOT_OPEN`), `NOT_FOUND`
   */
  async settle(tx: DbExecutor, settlement: SupplierSettlement): Promise<TransitionOutcome> {
    const outcome = await this.transitions.apply(tx, {
      orderId: settlement.orderId,
      action: { kind: 'supplierResult', result: settlement.result },
      actor: { type: 'supplier', id: settlement.supplierId },
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
    const merchant = before.clientId === null ? undefined : await merchantOf(tx, before.clientId);
    await this.audit.record(tx, {
      action,
      entityType: 'order',
      entityId: before.id,
      entityLabel: merchant ? `ORD-${before.id} for ${merchant.name}` : `ORD-${before.id}`,
      before: { status: before.status, dispatchState: before.dispatchState },
      after: { status: after.status, dispatchState: after.dispatchState },
    });
  }
}
