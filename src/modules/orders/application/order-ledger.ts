// OrderLedger: the money of the order engine. It turns the money move a transition names (decision 025) into the ledger posting
// of the money module, with the idempotency keys of decision 024, inside the transition's own transaction.
import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import {
  B2cRefunds,
  type MoneyEventPosting,
  LedgerPoster,
  OrderSettlements,
  type ReversalPosting,
  b2cDeliver,
  complete,
  order as holdEvent,
  refund,
  reject,
  reopen,
  reopenB2c,
} from '../../money';
import { StorefrontPolicies } from '../../storefront';
import type { Order } from '../db/schema';
import { type LiveWalletKind, refundCreditsKind } from '../domain/buyer-rules';
import { isPrepaidOrder } from '../domain/door';
import type { OrderMoneyMove } from '../domain/order-machine';

/** Who posts: the ledger records the actor of the transition (a person's account, staff, or the system). */
export interface LedgerActor {
  readonly type: 'staff' | 'account' | 'system';
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
  /** True when no refund was made and a refund request waits for staff (`autoRefundFailed` off); `amount` is what it asks for (USD). */
  readonly requested?: boolean;
  /** True when the request waits because the buyer disputed the payment with the card network (decision 048). */
  readonly disputed?: boolean;
  /**
   * True when the payment was charged back: nothing was refunded; `amount` is what the sale had booked that went back against the
   * chargeback loss (USD).
   */
  readonly chargedBack?: boolean;
}

/** What the use case knows when it asks for a move. */
export interface MoveContext {
  readonly actor: LedgerActor;
  /** How many times the order was completed before this one: the settle key of a second completion is numbered. */
  readonly completedBefore: number;
  /**
   * True when an earlier settlement already booked the supplier cost of the order's current supplier acceptance (B17: a reopen keeps
   * the cost; a supplier that accepted the order again since then is a new charge).
   */
  readonly costBooked: boolean;
  /** The storefront refund an approval is paying out (feature 16): its journal is the refund's, not a new automatic refund's. */
  readonly refundId?: number | undefined;
  /**
   * True when the system decided the rejection (a supplier's answer), not a person: only then does the storefront policy `autoRefundFailed`
   * apply. A staff member who rejects or cancels an order has decided to refund it.
   */
  readonly systemDecided?: boolean;
  /**
   * The kind of wallet the buyer lives on now, read under the account row lock. Required for the `refund` and `reopen` of a hold-and-settle
   * order (`readsLiveWallet`): the refund credits that wallet (decision 064). Left out for every other move.
   */
  readonly wallet?: LiveWalletKind | undefined;
}

const memo = (word: string, order: Order): string => `${word} ORD-${order.id}`;

/**
 * Posts the ledger side of order transitions.
 *
 * Why: decision 024 and 025 and the brief: placement holds the price (`order`), completion settles it (`complete`: hold to
 * revenue, with the cost lines only when a supplier executed the order and no earlier settlement booked the cost of the
 * same supplier acceptance), rejection releases it (`reject`), a reopen moves the revenue back to the hold and a B2B refund
 * moves it to the account's live wallet, both keeping the cost. Keys: `order:<id>:hold`, `order:<id>:settle` (numbered from the second completion), `order:<id>:release`,
 * `order:<id>:refund` (B2C, or `refund:<id>` for an approved refund, posted by `B2cRefunds`; none while `autoRefundFailed` is off and the
 * system rejected the order: a refund request waits for staff instead), and `reverse:<settlement id>` for a reopen or a B2B refund (decision 024). A repeated key posts nothing, so a retried or doubled transition never moves money twice.
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
    private readonly refunds: B2cRefunds,
    private readonly policies: StorefrontPolicies,
  ) {}

  /**
   * Holds the price of a new order: wallet to hold.
   *
   * @param tx the placement transaction
   * @param order the stored order (its id is the ledger reference)
   * @param actor the account (or its key) placing it
   * @returns what moved
   * @throws {AppError} `INSUFFICIENT_FUNDS` (402) when the wallet cannot cover the price within its credit limit
   * @throws {RangeError} when the order came through the shop door: a paid-first order is never held from a wallet
   */
  async hold(tx: DbExecutor, order: Order, actor: LedgerActor): Promise<MoveOutcome> {
    const amount = Money.of(order.totalPrice);
    const accountId = this.heldBy(order);
    return this.post(
      tx,
      order,
      holdEvent({ clientId: accountId, amount }),
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
                clientId: this.heldBy(order),
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
          reject({ clientId: this.heldBy(order), amount: price }),
          `order:${order.id}:release`,
          memo('Release', order),
          context.actor,
          { amount: price, cost: Money.zero() },
        );
      case 'b2c_refund': {
        // Feature 16: the money module posts the refund (what is left on the payment, the VAT share, the refund row and the gateway
        // job); an order without a payment on record keeps the journal feature 5 wrote. RULES settings 5: a rejection the system decided
        // is refunded by the system while `autoRefundFailed` is on; when it is off the refund waits as a request for staff to approve.
        const mode =
          context.systemDecided === true &&
          context.refundId === undefined &&
          !(await this.policies.autoRefundFailed(tx))
            ? 'request'
            : 'refund';
        const refunded = await this.refunds.onOrderRefund(tx, {
          order,
          actor: context.actor,
          refundId: context.refundId,
          mode,
        });
        return {
          posted: refunded.posted,
          amount: refunded.amount,
          cost: Money.zero().toWire(),
          ...(refunded.requested ? { requested: true } : {}),
          ...(refunded.disputed ? { disputed: true } : {}),
          ...(refunded.chargedBack === true ? { chargedBack: true } : {}),
        };
      }
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
            ? this.refundPosting(order, price, context)
            : isPrepaidOrder(order)
              ? reopenB2c({ net: price })
              : reopen({ clientId: order.accountId, amount: price });
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

  /** The supplier cost a settlement books: only for a supplier's acceptance that no earlier settlement booked. */
  private costToBook(order: Order, context: MoveContext): Money {
    if (context.costBooked || order.supplierId === null || order.supplierRef === null) return Money.zero();
    return Money.of(order.totalCost);
  }

  /** The account a hold-and-settle order is held from (its buyer); a paid-first order has no hold. */
  private heldBy(order: Order): number {
    if (isPrepaidOrder(order)) throw new RangeError('This money move is for a hold-and-settle order.');
    return order.accountId;
  }

  /**
   * The refund of a completed hold-and-settle order: the revenue goes back to the account's live wallet (decision 064), through the money module's `refund` with that wallet kind.
   *
   * Why: the account may have changed rank since the order, so the merchant wallet is not always where the money belongs: a refund is never
   * refused for a crossing, it credits the wallet that is live now. The caller read the kind under the account row lock.
   */
  private refundPosting(order: Order, price: Money, context: MoveContext): ReversalPosting {
    const accountId = this.heldBy(order);
    if (context.wallet === undefined) {
      throw new Error(
        `The refund of order ${order.id} needs the live wallet of its account: the use case reads it first.`,
      );
    }
    return refund({ clientId: accountId, amount: price, wallet: refundCreditsKind(context.wallet) });
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
