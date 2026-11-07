// OrderLedger: the money of the order engine. It turns the money move a transition names (decision 025) into the ledger posting
// of the money module, with the idempotency keys of decision 024, inside the transition's own transaction.
import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import {
  type MoneyEventPosting,
  LedgerPoster,
  OrderSettlements,
  type ReversalPosting,
  b2cDeliver,
  b2cRefund,
  complete,
  order as holdEvent,
  refund,
  reject,
  reopen,
  reopenB2c,
} from '../../money';
import type { Order } from '../db/schema';
import type { OrderMoneyMove } from '../domain/order-machine';

/** Who posts: the ledger records the actor of the transition. */
export interface LedgerActor {
  readonly type: 'staff' | 'client' | 'customer' | 'system';
  readonly id: number | null;
}

/** What a posted move did, for the order's timeline. */
export interface MoveOutcome {
  /** True when a posting was written (a zero-price order moves no money). */
  readonly posted: boolean;
  /** The amount that moved (the order price), 4 decimals. */
  readonly amount: string;
  /** The supplier cost booked by a settlement (`0.0000` when none was booked). */
  readonly cost: string;
}

/** What the use case knows when it asks for a move. */
export interface MoveContext {
  readonly actor: LedgerActor;
  /** How many times the order was completed before this one: the settle key of a second completion is numbered. */
  readonly completedBefore: number;
  /** True when an earlier settlement already booked the supplier cost (B17: a reopen keeps the cost). */
  readonly costBooked: boolean;
}

const memo = (word: string, order: Order): string => `${word} ORD-${order.id}`;

/**
 * Posts the ledger side of order transitions.
 *
 * Why: decision 024 and 025 and the brief: placement holds the price (`order`), completion settles it (`complete`: hold to
 * revenue, with the cost lines only when a supplier executed the order and no earlier settlement booked the cost), rejection
 * releases it (`reject`), a reopen moves the revenue back to the hold and a B2B refund moves it to the wallet, both keeping the
 * cost. Keys: `order:<id>:hold`, `order:<id>:settle` (numbered from the second completion), `order:<id>:release`,
 * `order:<id>:refund` (B2C), and `reverse:<settlement id>` for a reopen or a B2B refund, the key `MerchantSpend` reads to stop
 * counting a reversed settlement. A repeated key posts nothing, so a retried or doubled transition never moves money twice.
 *
 * Side effects: inserts ledger transactions and entries and changes account balances through `LedgerPoster` (locks the accounts
 * in id order); throws `INSUFFICIENT_FUNDS` when a hold would take the wallet below its credit limit.
 *
 * @see docs/decisions/024-ledger.md
 */
@Injectable()
export class OrderLedger {
  constructor(
    private readonly poster: LedgerPoster,
    private readonly settlements: OrderSettlements,
  ) {}

  /**
   * Holds the price of a new order: wallet to hold.
   *
   * @param tx the placement transaction
   * @param order the stored order (its id is the ledger reference)
   * @param actor the merchant (or key) placing it
   * @returns what moved
   * @throws {AppError} `INSUFFICIENT_FUNDS` (402) when the wallet cannot cover the price within its credit limit
   */
  async hold(tx: DbExecutor, order: Order, actor: LedgerActor): Promise<MoveOutcome> {
    const amount = Money.of(order.totalPrice);
    const clientId = order.clientId;
    if (clientId === null) throw new RangeError('Only a merchant order is held from a wallet.');
    return this.post(
      tx,
      order,
      holdEvent({ clientId, amount }),
      `order:${order.id}:hold`,
      memo('Hold for', order),
      actor,
      {
        amount,
        cost: Money.zero(),
      },
    );
  }

  /**
   * Posts the money move a transition decided.
   *
   * @param tx the transition's transaction (the order row is changed by the guarded update before this runs)
   * @param order the order after the update
   * @param move the move named by the state machine, or `null` for none
   * @param context the actor and what earlier settlements did
   * @returns what moved
   */
  async move(tx: DbExecutor, order: Order, move: OrderMoneyMove | null, context: MoveContext): Promise<MoveOutcome> {
    if (move === null) return { posted: false, amount: Money.zero().toWire(), cost: Money.zero().toWire() };
    const price = Money.of(order.totalPrice);
    switch (move) {
      case 'complete':
      case 'b2c_deliver': {
        const cost = this.costToBook(order, context);
        const posting =
          move === 'complete'
            ? complete({
                clientId: this.merchantOf(order),
                price,
                cost,
                ...(cost.isZero() ? {} : { supplierId: order.supplierId! }),
              })
            : b2cDeliver({ net: price, cost, ...(cost.isZero() ? {} : { supplierId: order.supplierId! }) });
        const key =
          context.completedBefore === 0
            ? `order:${order.id}:settle`
            : `order:${order.id}:settle:${context.completedBefore + 1}`;
        return this.post(tx, order, posting, key, memo('Settle', order), context.actor, { amount: price, cost });
      }
      case 'reject':
        return this.post(
          tx,
          order,
          reject({ clientId: this.merchantOf(order), amount: price }),
          `order:${order.id}:release`,
          memo('Release', order),
          context.actor,
          { amount: price, cost: Money.zero() },
        );
      case 'b2c_refund':
        // The ledger part of the refund; the refunds row and the gateway refund arrive with feature 16 (B16).
        return this.post(
          tx,
          order,
          b2cRefund({ net: price, vat: Money.of(order.taxAmount) }),
          `order:${order.id}:refund`,
          memo('Refund', order),
          context.actor,
          { amount: price, cost: Money.zero() },
        );
      case 'reopen':
      case 'refund': {
        const settlement = await this.settlements.liveOf(tx, order.id);
        if (!settlement) {
          if (price.isZero()) return { posted: false, amount: price.toWire(), cost: Money.zero().toWire() };
          // A completed order with money must have a live settlement: anything else is corrupt data, never a client error.
          throw new Error(`Order ${order.id} has no live settlement to reverse for its ${move}.`);
        }
        const posting: ReversalPosting =
          move === 'refund'
            ? refund({ clientId: this.merchantOf(order), amount: price })
            : order.clientId === null
              ? reopenB2c({ net: price })
              : reopen({ clientId: order.clientId, amount: price });
        return this.post(
          tx,
          order,
          posting,
          `reverse:${settlement.id}`,
          `Reversal of JRN-${settlement.id}`,
          context.actor,
          { amount: price, cost: Money.zero() },
        );
      }
    }
  }

  /** The supplier cost a settlement books: only when a supplier executed the order and no earlier settlement booked it. */
  private costToBook(order: Order, context: MoveContext): Money {
    if (context.costBooked || order.supplierId === null || order.supplierRef === null) return Money.zero();
    return Money.of(order.totalCost);
  }

  private merchantOf(order: Order): number {
    if (order.clientId === null) throw new RangeError('This money move is for a merchant order.');
    return order.clientId;
  }

  private async post(
    tx: DbExecutor,
    order: Order,
    posting: MoneyEventPosting | ReversalPosting,
    idempotencyKey: string,
    text: string,
    actor: LedgerActor,
    outcome: { amount: Money; cost: Money },
  ): Promise<MoveOutcome> {
    // A free order (price 0, no cost) has no lines: nothing to post.
    if (posting.lines.length === 0)
      return { posted: false, amount: outcome.amount.toWire(), cost: outcome.cost.toWire() };
    await this.poster.post(tx, {
      kind: posting.kind,
      refType: posting.refType,
      refId: order.id,
      idempotencyKey,
      currency: order.currency,
      lines: posting.lines,
      memo: text,
      createdBy: { type: actor.type, id: actor.id },
    });
    return { posted: true, amount: outcome.amount.toWire(), cost: outcome.cost.toWire() };
  }
}
