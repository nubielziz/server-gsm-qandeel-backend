// The order state machine (decision 025, resolutions orders-suppliers-11 and -18): one pure function per decision, no
// database. Use cases run the transition it returns inside one guarded UPDATE, write the event, post the money move and
// write the outbox row when the status changed.
import type { OrderDispatchState, OrderEventType, OrderStatus, OrderVerificationStatus } from '../db/schema';

/** What the machine needs to know about an order. */
export interface OrderState {
  readonly status: OrderStatus;
  readonly dispatchState: OrderDispatchState;
  readonly verificationStatus: OrderVerificationStatus | null;
  /** `b2b` for a merchant's order (`client_id` set), `b2c` for a storefront customer's. */
  readonly channel: 'b2b' | 'b2c';
  /** True once the order was completed at least once (`completed_at` is set): a reopened B2C order was delivered. */
  readonly completedBefore: boolean;
}

/** The queue the console shows (`Order.queue`), derived from the state; `null` outside every queue. */
export type OrderQueue = 'pending' | 'manual' | 'needs_attention' | 'verification' | 'review';

/**
 * The money event a transition posts, by the map's names (`docs/slices/money.json`); `null` moves no money.
 *
 * - `complete` / `b2c_deliver`: hold → revenue (B2B) or customer funds → revenue (B2C).
 * - `reject` / `b2c_refund`: the hold goes back before delivery.
 * - `reopen`: revenue back to the hold (B2B) or customer funds (B2C); cogs kept.
 * - `refund`: B2B refund of a completed order, revenue → wallet in one step (reopen + reject), cogs kept.
 */
export type OrderMoneyMove = 'complete' | 'b2c_deliver' | 'reject' | 'b2c_refund' | 'reopen' | 'refund';

/** An action that may change an order. */
export type OrderAction =
  /** Staff take a manual order (`POST /admin/orders/:id/accept`). */
  | { readonly kind: 'accept' }
  /** Staff answer with the result (`reply`): the order completes. */
  | { readonly kind: 'reply' }
  /** Staff reject an open order (`reject`). */
  | { readonly kind: 'reject' }
  /** Staff refund a completed B2B order (`refund`). */
  | { readonly kind: 'refund' }
  /** Staff reopen a completed order (`reopen`). */
  | { readonly kind: 'reopen' }
  /** Staff decide a verification request (`verification`). */
  | { readonly kind: 'verification'; readonly decision: 'accept' | 'refund' }
  /** The merchant asks to verify a completed order (`/client` or `/v1` verify). */
  | { readonly kind: 'requestVerification' }
  /** The merchant cancels an order that was never sent (`/client` or `/v1` cancel). */
  | { readonly kind: 'cancel' }
  /** Staff send the order to a supplier again (`dispatch`, feature 6). */
  | { readonly kind: 'staffDispatch' }
  /** The dispatch job's answer: the supplier took it (REFERENCEID) or not (refusal, timeout, no eligible link). */
  | { readonly kind: 'dispatchResult'; readonly result: 'sent' | 'failed' }
  /** A poll or a staff fetch read the supplier's status: 4 completed, 3 rejected, or still running. */
  | { readonly kind: 'supplierResult'; readonly result: 'completed' | 'rejected' | 'running' }
  /** Staff move the order to another supplier or reset its reference (`change-supplier`). */
  | { readonly kind: 'changeSupplier'; readonly resetReference: boolean; readonly dispatch: boolean }
  /** Risk staff release a held B2C order; `manual` is the placement rule's answer for the order's service. */
  | { readonly kind: 'riskApprove'; readonly manual: boolean }
  /** Risk staff refund a held B2C order. */
  | { readonly kind: 'riskRefund' }
  /** Staff approved a storefront refund of an order that was not delivered: the order is cancelled and the payment goes back. */
  | { readonly kind: 'refundApproved' };

/** The refusals the machine can answer, all `409` in the error catalog. */
export type OrderRefusal =
  | 'ORDER_NOT_OPEN'
  | 'ORDER_HELD'
  | 'ALREADY_SENT'
  | 'INVALID_TRANSITION'
  | 'USE_REFUNDS'
  | 'NOT_MANUAL'
  | 'ORDER_NOT_COMPLETED'
  | 'NOT_IN_VERIFICATION';

/** The state after an allowed action and what the use case must do with it. */
export interface OrderTransition {
  readonly ok: true;
  readonly next: Pick<OrderState, 'status' | 'dispatchState' | 'verificationStatus'>;
  /** The `order_events` type to write (the console's words, orders-suppliers-15). */
  readonly event: OrderEventType;
  readonly money: OrderMoneyMove | null;
  /** True when `status` changes: the use case writes the `order.status_changed` outbox row. */
  readonly statusChanged: boolean;
  /** True when the dispatch job must be enqueued (outbox row) in the same transaction. */
  readonly enqueueDispatch: boolean;
  /** True when nothing changes (a `204` no-op such as dispatching an order already queued): write nothing. */
  readonly noop: boolean;
}

/** A refused action. */
export interface OrderRefused {
  readonly ok: false;
  readonly refusal: OrderRefusal;
}

/** The answer of {@link decideOrderAction}. */
export type OrderDecision = OrderTransition | OrderRefused;

const OPEN: readonly OrderStatus[] = ['pending', 'processing'];

/**
 * True while the order is open (`pending` or `processing`).
 *
 * @param status the order status
 * @returns whether staff and jobs may still act on it
 */
export function isOpen(status: OrderStatus): boolean {
  return OPEN.includes(status);
}

/**
 * The console's queue of an order.
 *
 * Why: decision 025: `review` = held; `manual` = pending + manual; `needs_attention` = needs_attention; `verification` =
 * completed + verification requested; `pending` = pending + dispatch pending; otherwise none (`operator`, `sent` and
 * `done` have no queue).
 *
 * @param state the order's status, dispatch state and verification status
 * @returns the queue, or `null`
 */
export function deriveQueue(
  state: Pick<OrderState, 'status' | 'dispatchState' | 'verificationStatus'>,
): OrderQueue | null {
  if (state.dispatchState === 'held') return 'review';
  if (state.dispatchState === 'needs_attention') return 'needs_attention';
  if (state.status === 'completed' && state.verificationStatus === 'requested') return 'verification';
  if (state.status === 'pending' && state.dispatchState === 'manual') return 'manual';
  if (state.status === 'pending' && state.dispatchState === 'pending') return 'pending';
  return null;
}

/**
 * The dispatch state of a new order.
 *
 * Why: decision 025 placement row: a B2C order that risk holds starts `held`; an inventory code delivered at once is
 * `done`; a manual service or one without an active supplier link is `manual`; anything else waits for the dispatch job.
 *
 * @param input what placement knows about the order
 * @returns the first dispatch state (status is `pending`, or `completed` with `done`)
 */
export function placementDispatchState(input: {
  readonly held: boolean;
  readonly deliveredFromInventory: boolean;
  readonly manualService: boolean;
  readonly hasActiveSupplierLink: boolean;
}): { status: OrderStatus; dispatchState: OrderDispatchState; enqueueDispatch: boolean } {
  if (input.held) return { status: 'pending', dispatchState: 'held', enqueueDispatch: false };
  if (input.deliveredFromInventory) return { status: 'completed', dispatchState: 'done', enqueueDispatch: false };
  if (input.manualService || !input.hasActiveSupplierLink) {
    return { status: 'pending', dispatchState: 'manual', enqueueDispatch: false };
  }
  return { status: 'pending', dispatchState: 'pending', enqueueDispatch: true };
}

function refuse(refusal: OrderRefusal): OrderRefused {
  return { ok: false, refusal };
}

function to(
  from: OrderState,
  next: Partial<Pick<OrderState, 'status' | 'dispatchState' | 'verificationStatus'>>,
  event: OrderEventType,
  money: OrderMoneyMove | null,
  enqueueDispatch = false,
): OrderTransition {
  const status = next.status ?? from.status;
  return {
    ok: true,
    next: {
      status,
      dispatchState: next.dispatchState ?? from.dispatchState,
      verificationStatus: next.verificationStatus === undefined ? from.verificationStatus : next.verificationStatus,
    },
    event,
    money,
    statusChanged: status !== from.status,
    enqueueDispatch,
    noop: false,
  };
}

function noop(from: OrderState, event: OrderEventType): OrderTransition {
  return { ...to(from, {}, event, null), noop: true };
}

/** The open-order checks every staff action shares: closed → ORDER_NOT_OPEN, held → ORDER_HELD. */
function openAndNotHeld(order: OrderState): OrderRefused | undefined {
  if (!isOpen(order.status)) return refuse('ORDER_NOT_OPEN');
  if (order.dispatchState === 'held') return refuse('ORDER_HELD');
  return undefined;
}

/**
 * Decides an action on an order.
 *
 * Why: decision 025's transition table, the single source of the rules: every route, job and scenario asks this function
 * and applies its answer through a guarded `UPDATE ... WHERE status = $from.status AND dispatch_state =
 * $from.dispatchState` (zero rows: another request won, answer `409 INVALID_TRANSITION`).
 *
 * @param order the order as read at the start of the use case
 * @param action what is asked
 * @returns the next state with its event, money move and side effects, or the refusal
 */
export function decideOrderAction(order: OrderState, action: OrderAction): OrderDecision {
  const moneyComplete: OrderMoneyMove = order.channel === 'b2b' ? 'complete' : 'b2c_deliver';
  switch (action.kind) {
    case 'accept': {
      const blocked = openAndNotHeld(order);
      if (blocked) return blocked;
      // The endpoint doc names this refusal: only an order in the manual queue can be accepted.
      if (order.dispatchState !== 'manual') return refuse('NOT_MANUAL');
      return to(order, { status: 'processing', dispatchState: 'operator' }, 'accepted', null);
    }
    case 'reply': {
      const blocked = openAndNotHeld(order);
      if (blocked) return blocked;
      return to(order, { status: 'completed', dispatchState: 'done' }, 'completed', moneyComplete);
    }
    case 'reject': {
      const blocked = openAndNotHeld(order);
      if (blocked) return blocked;
      // A B2C order delivered once (reopened since) is refunded from the refunds page (orders-suppliers-18).
      if (order.channel === 'b2c' && order.completedBefore) return refuse('USE_REFUNDS');
      return to(
        order,
        { status: 'rejected', dispatchState: 'done' },
        'rejected',
        order.channel === 'b2b' ? 'reject' : 'b2c_refund',
      );
    }
    case 'refund': {
      if (order.channel === 'b2c') return refuse('USE_REFUNDS');
      if (order.status !== 'completed') return refuse('ORDER_NOT_COMPLETED');
      return to(order, { status: 'rejected', dispatchState: 'done' }, 'refund', 'refund');
    }
    case 'reopen': {
      if (order.status === 'rejected') return refuse('ORDER_NOT_OPEN');
      if (order.status !== 'completed') return refuse('ORDER_NOT_COMPLETED');
      return to(order, { status: 'processing', dispatchState: 'operator' }, 'reopened', 'reopen');
    }
    case 'verification': {
      if (order.status !== 'completed' || order.verificationStatus !== 'requested')
        return refuse('NOT_IN_VERIFICATION');
      if (action.decision === 'accept') return to(order, { verificationStatus: 'accepted' }, 'verification', null);
      if (order.channel === 'b2c') return refuse('USE_REFUNDS');
      return to(order, { status: 'rejected', verificationStatus: 'refunded' }, 'verification', 'refund');
    }
    case 'requestVerification': {
      if (order.status !== 'completed') return refuse('ORDER_NOT_COMPLETED');
      // One request per order: a decided or pending request cannot be asked again.
      if (order.verificationStatus !== null) return refuse('INVALID_TRANSITION');
      return to(order, { verificationStatus: 'requested' }, 'verification', null);
    }
    case 'cancel': {
      if (!isOpen(order.status)) return refuse('ORDER_NOT_OPEN');
      if (order.dispatchState === 'sent') return refuse('ALREADY_SENT');
      if (!['pending', 'manual', 'held'].includes(order.dispatchState)) return refuse('INVALID_TRANSITION');
      return to(
        order,
        { status: 'rejected', dispatchState: 'done' },
        'rejected',
        order.channel === 'b2b' ? 'reject' : 'b2c_refund',
      );
    }
    case 'staffDispatch': {
      if (!isOpen(order.status)) return refuse('ORDER_NOT_OPEN');
      if (order.dispatchState === 'held') return refuse('ORDER_HELD');
      if (order.dispatchState === 'sent') return refuse('ALREADY_SENT');
      // Already waiting for the dispatch job: a 204 that changes nothing.
      if (order.dispatchState === 'pending') return noop(order, 'retry');
      return to(order, { dispatchState: 'pending' }, 'retry', null, true);
    }
    case 'dispatchResult': {
      if (order.dispatchState !== 'pending' || !isOpen(order.status)) return refuse('INVALID_TRANSITION');
      if (action.result === 'sent') return to(order, { status: 'processing', dispatchState: 'sent' }, 'ack', null);
      // Status unchanged; the use case writes the reason on the review event (decision 025).
      return to(order, { dispatchState: 'needs_attention' }, 'review', null);
    }
    case 'supplierResult': {
      if (!isOpen(order.status) || !['sent', 'needs_attention'].includes(order.dispatchState)) {
        return refuse('INVALID_TRANSITION');
      }
      if (action.result === 'completed') {
        return to(order, { status: 'completed', dispatchState: 'done' }, 'completed', moneyComplete);
      }
      if (action.result === 'rejected') {
        return to(
          order,
          { status: 'rejected', dispatchState: 'done' },
          'rejected',
          order.channel === 'b2b' ? 'reject' : 'b2c_refund',
        );
      }
      // Still running: a needs_attention order goes back to polling; a sent one only records the fetch.
      if (order.dispatchState === 'needs_attention') return to(order, { dispatchState: 'sent' }, 'fetch', null);
      return noop(order, 'fetch');
    }
    case 'changeSupplier': {
      if (!isOpen(order.status)) return refuse('ORDER_NOT_OPEN');
      if (action.dispatch) {
        if (order.dispatchState === 'held') return refuse('ORDER_HELD');
        return to(order, { dispatchState: 'pending' }, 'supplier_changed', null, true);
      }
      if (order.dispatchState === 'sent' && action.resetReference) {
        return to(order, { dispatchState: 'needs_attention' }, 'supplier_changed', null);
      }
      return to(order, {}, 'supplier_changed', null);
    }
    case 'riskApprove': {
      if (order.dispatchState !== 'held' || !isOpen(order.status)) return refuse('INVALID_TRANSITION');
      return action.manual
        ? to(order, { dispatchState: 'manual' }, 'risk', null)
        : to(order, { dispatchState: 'pending' }, 'risk', null, true);
    }
    case 'riskRefund': {
      if (order.dispatchState !== 'held' || !isOpen(order.status)) return refuse('INVALID_TRANSITION');
      return to(order, { status: 'rejected', dispatchState: 'done' }, 'risk', 'b2c_refund');
    }
    case 'refundApproved': {
      // Feature 16: approving a refund of an order that is still open (held, sent, or reopened after a delivery) cancels it. Unlike
      // `reject` it works on a held order and on one delivered before and reopened, because the refund decision is the refund page's.
      if (order.channel !== 'b2c') return refuse('INVALID_TRANSITION');
      if (!isOpen(order.status)) return refuse('ORDER_NOT_OPEN');
      return to(order, { status: 'rejected', dispatchState: 'done' }, 'rejected', 'b2c_refund');
    }
  }
}
