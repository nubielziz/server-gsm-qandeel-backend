// The order state machine (decision 025, resolutions orders-suppliers-11 and -18): one pure function per decision, no
// database. Use cases run the transition it returns inside one guarded UPDATE, write the event, post the money move and
// write the outbox row when the status changed.
import type { Order, OrderDispatchState, OrderEventType, OrderStatus, OrderVerificationStatus } from '../db/schema';

/** What the machine needs to know about an order. */
export interface OrderState {
  readonly status: OrderStatus;
  readonly dispatchState: OrderDispatchState;
  readonly verificationStatus: OrderVerificationStatus | null;
  /** `b2b` for a merchant's order (`client_id` set), `b2c` for a storefront customer's. */
  readonly channel: 'b2b' | 'b2c';
  /** True once the order was completed at least once (`completed_at` is set): a reopened B2C order was delivered. */
  readonly completedBefore: boolean;
  /**
   * True once the order was claimed for a supplier call at least once (it has a `dispatch` event), even if it reads `pending`
   * again after a failed or lost send: the supplier may hold the first attempt, so only staff can end the order (decision 044).
   */
  readonly everDispatched: boolean;
  /**
   * Set when the payment of a storefront order stops its release, its send, or its accept and reply by staff ({@link paymentStopOf}); left
   * out, nothing stops it. The use cases read it only for the actions it can refuse ({@link paymentCanStop}) and never for a merchant's
   * order.
   */
  readonly paymentStop?: PaymentStop;
}

/**
 * What the payment of a storefront order says about releasing it from a risk hold, sending it to a supplier, or accepting and completing it
 * by staff: `disputed` while a dispute of the payment is open (the action waits until it is decided), `returned` once the money went back
 * (charged back, or refunded in full: the order is never sent, or delivered by staff for the first time).
 */
export type PaymentStop = 'disputed' | 'returned';

/**
 * The stop a payment status means.
 *
 * Why: the customer's bank or the shop took the money back, or may still do so: the supplier cost of a send, or a result delivered by staff,
 * would be spent on a sale that is not paid. A partial refund or a won dispute does not stop the order.
 *
 * @param status the status of the payment that paid the order (`payments.status`), or `undefined` when it has none
 * @returns `disputed`, `returned`, or `undefined` when the payment stands
 */
export function paymentStopOf(status: string | undefined): PaymentStop | undefined {
  if (status === 'disputed') return 'disputed';
  if (status === 'chargeback' || status === 'refunded') return 'returned';
  return undefined;
}

/**
 * The sentence staff read when the payment stops an action, as the refusal's `detail` and as the reason of the `review` line the
 * dispatch job writes.
 */
export const PAYMENT_STOP_REASONS: Readonly<Record<PaymentStop, string>> = {
  disputed:
    'The payment of this order is disputed: it is not released or sent to a supplier until the dispute is decided.',
  returned: 'The payment of this order was charged back or refunded in full: it is not released or sent to a supplier.',
};

/**
 * True for the actions the payment of a storefront order can refuse: the release from a risk hold, a staff send, a change of supplier
 * that sends, a staff accept and a staff reply (also each line of the bulk reply). The dispatch job checks the payment itself before it
 * claims the order; a supplier that already has the order still completes it.
 *
 * @param action the action asked
 * @returns whether the use case must read the payment before it decides
 */
export function paymentCanStop(action: OrderAction): boolean {
  return (
    action.kind === 'riskApprove' ||
    action.kind === 'staffDispatch' ||
    (action.kind === 'changeSupplier' && action.dispatch) ||
    action.kind === 'accept' ||
    action.kind === 'reply'
  );
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
  /** The merchant asks to verify a completed order (`/client` verify). */
  | { readonly kind: 'requestVerification' }
  /** The merchant cancels an order that was never claimed for a supplier call (`/client` cancel). */
  | { readonly kind: 'cancel' }
  /**
   * Staff send the order to a supplier again (`dispatch`, feature 6). `requestLive` = a dispatch request of this order is still on
   * its way: not relayed yet, or its job waits, is delayed or runs (decision 044).
   */
  | { readonly kind: 'staffDispatch'; readonly requestLive: boolean }
  /**
   * The dispatch job's answer to a call it made: the supplier took it (REFERENCEID) or not (refusal, timeout), or the sweep gave up
   * on an answer that never came. Accepted from `dispatching` only (decision 044).
   */
  | { readonly kind: 'dispatchResult'; readonly result: 'sent' | 'failed' }
  /**
   * The dispatch job cannot start a send (no eligible supplier service, the supplier too busy or its limits unreadable on the last
   * attempt) or the dispatch sweep gives up on a lost request. Accepted from `pending` only (decision 044).
   */
  | { readonly kind: 'dispatchBlocked' }
  /** The dispatch sweep asks for the send of a pending order again: its earlier request was lost (decision 044). */
  | { readonly kind: 'requeueDispatch' }
  /** A poll or a staff fetch read the supplier's status: 4 completed, 3 rejected, or still running. */
  | { readonly kind: 'supplierResult'; readonly result: 'completed' | 'rejected' | 'running' }
  /**
   * Staff move the order to another supplier or reset its reference (`change-supplier`). `supplierChanges` = the request names a
   * supplier other than the order's: its old reference is forgotten (decision 044).
   */
  | {
      readonly kind: 'changeSupplier';
      readonly resetReference: boolean;
      readonly dispatch: boolean;
      readonly supplierChanges: boolean;
    }
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
  /** Set when the order is being sent to its supplier and the action must wait for the answer (decision 044). */
  readonly sending?: true;
  /** Set when the payment of the storefront order stops the action ({@link PaymentStop}). */
  readonly payment?: PaymentStop;
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
 * completed + verification requested; `pending` = pending + dispatch pending or dispatching (decision 044: a send in flight
 * keeps the queue it had before); otherwise none (`operator`, `sent` and `done` have no queue).
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
  if (state.status === 'pending' && (state.dispatchState === 'pending' || state.dispatchState === 'dispatching')) {
    return 'pending';
  }
  return null;
}

/**
 * The dispatch states the wire carries (the console's enum, in its order): every stored state but `dispatching`.
 *
 * Why: decision 044: the response shapes do not change, so a send in flight reads as `pending`.
 */
export const WIRE_DISPATCH_STATES = [
  'pending',
  'held',
  'manual',
  'operator',
  'sent',
  'needs_attention',
  'done',
] as const satisfies readonly OrderDispatchState[];

/** One value of {@link WIRE_DISPATCH_STATES}. */
export type WireDispatchState = (typeof WIRE_DISPATCH_STATES)[number];

/**
 * The dispatch state a response shows.
 *
 * Why: decision 044: `dispatching` maps to what `pending` with `sent_at` set showed before, so no client sees a new value.
 *
 * @param state the stored dispatch state
 * @returns the state the wire carries
 */
export function wireDispatchState(state: OrderDispatchState): WireDispatchState {
  return state === 'dispatching' ? 'pending' : state;
}

/**
 * What the machine needs to know about a stored order.
 *
 * Why: decision 044: one conversion for every use case, job and sweep, so the rule below cannot differ between them.
 *
 * @param order the stored order
 * @param completedBefore true once the order was completed at least once (only a storefront order needs it)
 * @param everDispatched true once the order has a `dispatch` event (only the merchant's cancel asks for it)
 * @param paymentStop what the payment of a storefront order says about releasing or sending it (only the actions of
 *   {@link paymentCanStop} ask for it)
 * @returns the machine's view of the order
 */
export function orderStateOf(
  order: Pick<Order, 'status' | 'dispatchState' | 'verificationStatus' | 'clientId' | 'sentAt'>,
  completedBefore = false,
  everDispatched = false,
  paymentStop?: PaymentStop,
): OrderState {
  return {
    status: order.status,
    // A claim of an earlier release kept `pending` and set `sent_at`: its answer may still come, so it counts as a send in flight
    // (decision 044).
    dispatchState: order.dispatchState === 'pending' && order.sentAt !== null ? 'dispatching' : order.dispatchState,
    verificationStatus: order.verificationStatus,
    channel: order.clientId === null ? 'b2c' : 'b2b',
    completedBefore,
    everDispatched,
    ...(paymentStop === undefined ? {} : { paymentStop }),
  };
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

/** The order is being sent: the action waits for the supplier's answer (decision 044). */
function sending(): OrderRefused {
  return { ok: false, refusal: 'ALREADY_SENT', sending: true };
}

/** The payment of the storefront order stops a release or a send. */
function paymentStopped(stop: PaymentStop): OrderRefused {
  return { ok: false, refusal: 'INVALID_TRANSITION', payment: stop };
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
 * $from.dispatchState AND sent_at IS NOT DISTINCT FROM $from.sentAt` (zero rows: another request won, answer `409
 * INVALID_TRANSITION`). Decision 044: while the order is `dispatching` the actions that would change it wait for the
 * supplier's answer (`ALREADY_SENT` with the `sending` flag), and the merchant's cancel is refused (`ALREADY_SENT`) once the order
 * was ever claimed for a supplier call (`everDispatched`), whatever state it reads now. A storefront order whose payment is disputed,
 * charged back or refunded in full (`paymentStop`) is not released from its risk hold, sent by staff, sent with a change of supplier,
 * accepted or completed by a staff reply (`INVALID_TRANSITION` with the `payment` flag): staff can still refund or reject it, and a
 * supplier's own answer still completes or rejects an order it already has. A storefront order delivered before and reopened
 * (`completedBefore`) is still delivered again by a staff reply, since its reject is `USE_REFUNDS`.
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
      if (order.paymentStop !== undefined) return paymentStopped(order.paymentStop);
      return to(order, { status: 'processing', dispatchState: 'operator' }, 'accepted', null);
    }
    case 'reply': {
      const blocked = openAndNotHeld(order);
      if (blocked) return blocked;
      if (order.dispatchState === 'dispatching') return sending();
      // An order delivered before and reopened is delivered again whatever its payment says: the result already reached the buyer, a
      // second delivery books no new supplier cost, and its reject is USE_REFUNDS, so the reply is its way out.
      if (order.paymentStop !== undefined && !order.completedBefore) return paymentStopped(order.paymentStop);
      return to(order, { status: 'completed', dispatchState: 'done' }, 'completed', moneyComplete);
    }
    case 'reject': {
      const blocked = openAndNotHeld(order);
      if (blocked) return blocked;
      if (order.dispatchState === 'dispatching') return sending();
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
      // Refused like a sent order (decision 044): the supplier has the order or may be taking it, and an order claimed once keeps that
      // answer after a failed or lost send reads `pending` again, until staff end it.
      if (order.everDispatched || order.dispatchState === 'sent' || order.dispatchState === 'dispatching') {
        return refuse('ALREADY_SENT');
      }
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
      if (order.dispatchState === 'dispatching') return sending();
      if (order.paymentStop !== undefined) return paymentStopped(order.paymentStop);
      // A request still on its way is left alone: a 204 that changes nothing. A lost one is asked for again.
      if (order.dispatchState === 'pending' && action.requestLive) return noop(order, 'retry');
      return to(order, { dispatchState: 'pending' }, 'retry', null, true);
    }
    case 'dispatchResult': {
      // Only an order being sent takes the answer of a call (the use case also compares `sent_at`: the answer belongs to its claim).
      if (order.dispatchState !== 'dispatching' || !isOpen(order.status)) return refuse('INVALID_TRANSITION');
      if (action.result === 'sent') return to(order, { status: 'processing', dispatchState: 'sent' }, 'ack', null);
      // Status unchanged; the use case writes the reason on the review event (decision 025).
      return to(order, { dispatchState: 'needs_attention' }, 'review', null);
    }
    case 'dispatchBlocked': {
      if (order.dispatchState !== 'pending' || !isOpen(order.status)) return refuse('INVALID_TRANSITION');
      return to(order, { dispatchState: 'needs_attention' }, 'review', null);
    }
    case 'requeueDispatch': {
      if (order.dispatchState !== 'pending' || !isOpen(order.status)) return refuse('INVALID_TRANSITION');
      return to(order, {}, 'retry', null, true);
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
      if (order.dispatchState === 'dispatching') return sending();
      if (action.dispatch) {
        if (order.dispatchState === 'held') return refuse('ORDER_HELD');
        if (order.paymentStop !== undefined) return paymentStopped(order.paymentStop);
        return to(order, { dispatchState: 'pending' }, 'supplier_changed', null, true);
      }
      // The reference is forgotten (reset, or another supplier): a sent order has nothing to poll and needs a person.
      if (order.dispatchState === 'sent' && (action.resetReference || action.supplierChanges)) {
        return to(order, { dispatchState: 'needs_attention' }, 'supplier_changed', null);
      }
      return to(order, {}, 'supplier_changed', null);
    }
    case 'riskApprove': {
      if (order.dispatchState !== 'held' || !isOpen(order.status)) return refuse('INVALID_TRANSITION');
      if (order.paymentStop !== undefined) return paymentStopped(order.paymentStop);
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
      if (order.dispatchState === 'dispatching') return sending();
      return to(order, { status: 'rejected', dispatchState: 'done' }, 'rejected', 'b2c_refund');
    }
  }
}
