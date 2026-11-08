// OrderCompletionListeners: the leaf through which other modules learn that a merchant order was settled or its settlement was
// reversed, inside the transition's own transaction, without orders importing them (decision 032; feature 11 commissions).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import type { Order } from '../db/schema';
import type { OrderMoneyMove } from '../domain/order-machine';
import type { LedgerActor } from './order-ledger';

/** Why a completed order stopped being completed: the staff reopened it, or it was refunded (B2B refund, verification refund). */
export type OrderReversalReason = 'reopen' | 'refund';

/** Someone who wants to act in the same transaction as a settlement or a reversal of an order. */
export interface OrderCompletionListener {
  /**
   * Called after an order completed: the order row is `completed`, its settlement is posted and its timeline is about to be
   * written, all in `tx`. Throwing rolls the whole completion back, so the listener's rows exist if and only if the completion
   * committed.
   *
   * @param tx the transition's transaction
   * @param order the order after the update (a storefront order has `clientId` null)
   * @param actor who completed it (the staff member, the system for a supplier result or a stock delivery)
   */
  orderCompleted(tx: DbExecutor, order: Order, actor: LedgerActor): Promise<void>;

  /**
   * Called after a completed order was reopened or refunded: the order row has its new state and the reversing posting exists,
   * all in `tx`. Throwing rolls the whole reversal back.
   *
   * @param tx the transition's transaction
   * @param order the order after the update
   * @param reason `reopen` or `refund`
   * @param actor who reopened or refunded it: the ledger records them on any posting the listener makes
   */
  orderReversed(tx: DbExecutor, order: Order, reason: OrderReversalReason, actor: LedgerActor): Promise<void>;

  /**
   * Optional. Called before the ledger posts the reversing move of a reopen or a refund, in the same transaction, so a listener can
   * take its own row locks before any wallet is locked.
   *
   * Why: lock order. A bulk approval of commissions locks the accruals and then the agent's wallet; a reversal used to lock the
   * order merchant's wallet (the ledger move) and then the accruals. When the merchant is its own agent (a rebate plan) the two
   * could wait for each other (Postgres 40P01: the losing request is rolled back and answers a retryable 409). Commissions implements this hook to lock the order's live accruals first, so
   * every path locks accruals before wallets.
   *
   * @param tx the transition's transaction
   * @param order the order after the update (the move is not posted yet)
   */
  lockForReversal?(tx: DbExecutor, order: Order): Promise<void>;
}

/**
 * The list of listeners of order completions and reversals.
 *
 * Why: RULES commissions 1 and user rule 5: an accrual is born when an order completes and is reversed when it is refunded or
 * reopened, in the same transaction, so a commission exists if and only if the completion committed. Commissions registers at
 * boot (in the API and in the worker, which settles supplier results); orders only calls the list. Unlike the catalog's price
 * version listeners, a listener that throws fails the transition: the listeners write money-related rows that must not be lost.
 *
 * Side effects: none of its own; each listener writes on the transition's transaction.
 *
 * @see docs/decisions/032-import-cycles.md
 */
@Injectable()
export class OrderCompletionListeners {
  private readonly listeners: OrderCompletionListener[] = [];

  /**
   * Adds a listener (called once at boot by the module that listens).
   *
   * @param listener who to tell
   */
  add(listener: OrderCompletionListener): void {
    this.listeners.push(listener);
  }

  /**
   * Lets the listeners take their locks before a reversing move is posted: a `reopen` or a B2B `refund` is a reversal, every other
   * move is not their business.
   *
   * @param tx the transition's transaction
   * @param order the order after the update
   * @param move the money move the state machine named, or `null` for none
   * @throws whatever a listener throws (the transition rolls back)
   */
  async beforeMove(tx: DbExecutor, order: Order, move: OrderMoneyMove | null): Promise<void> {
    if (move !== 'reopen' && move !== 'refund') return;
    for (const listener of this.listeners) await listener.lockForReversal?.(tx, order);
  }

  /**
   * Tells the listeners about the money move a transition just posted: a settlement is a completion, a `reopen` or a B2B `refund`
   * is a reversal, every other move (hold release, B2C refund) is not their business.
   *
   * @param tx the transition's transaction
   * @param order the order after the update
   * @param move the money move the state machine named, or `null` for none
   * @param actor who made the transition
   * @throws whatever a listener throws (the transition rolls back)
   */
  async afterMove(tx: DbExecutor, order: Order, move: OrderMoneyMove | null, actor: LedgerActor): Promise<void> {
    if (move === 'complete' || move === 'b2c_deliver') await this.completed(tx, order, actor);
    else if (move === 'reopen' || move === 'refund') await this.reversed(tx, order, move, actor);
  }

  /**
   * Tells every listener that an order completed.
   *
   * @param tx the transition's transaction
   * @param order the order after the update
   * @param actor who completed it
   */
  async completed(tx: DbExecutor, order: Order, actor: LedgerActor): Promise<void> {
    for (const listener of this.listeners) await listener.orderCompleted(tx, order, actor);
  }

  /**
   * Tells every listener that a completed order was reversed.
   *
   * @param tx the transition's transaction
   * @param order the order after the update
   * @param reason `reopen` or `refund`
   * @param actor who reopened or refunded it
   */
  async reversed(tx: DbExecutor, order: Order, reason: OrderReversalReason, actor: LedgerActor): Promise<void> {
    for (const listener of this.listeners) await listener.orderReversed(tx, order, reason, actor);
  }
}
