// Unit tests of the order state machine: every row of decision 025's transition table, with the queue each result shows
// (resolution orders-suppliers-11: "every action has a test of its resulting queue") and every refusal.
import { describe, expect, it } from 'bun:test';
import { ORDER_DISPATCH_STATES } from '@src/modules/orders/db/schema';
import {
  type OrderAction,
  type OrderDecision,
  type OrderState,
  type OrderTransition,
  WIRE_DISPATCH_STATES,
  decideOrderAction,
  deriveQueue,
  isOpen,
  orderStateOf,
  placementDispatchState,
  wireDispatchState,
} from '@src/modules/orders/domain/order-machine';

const b2b = (state: Partial<OrderState> = {}): OrderState => ({
  status: 'pending',
  dispatchState: 'pending',
  verificationStatus: null,
  channel: 'b2b',
  completedBefore: false,
  everDispatched: false,
  ...state,
});
const b2c = (state: Partial<OrderState> = {}): OrderState => b2b({ channel: 'b2c', ...state });

/** The transition of an allowed action (fails the test when the machine refused it). */
function allowed(decision: OrderDecision): OrderTransition {
  if (!decision.ok) throw new Error(`expected a transition, got ${decision.refusal}`);
  return decision;
}

/** The queue the console shows after the transition. */
function queueAfter(order: OrderState, action: OrderAction) {
  return deriveQueue(allowed(decideOrderAction(order, action)).next);
}

describe('deriveQueue', () => {
  it('derives each queue of decision 025 and none for operator, sent and done', () => {
    expect(deriveQueue(b2c({ dispatchState: 'held' }))).toBe('review');
    expect(deriveQueue(b2b({ dispatchState: 'manual' }))).toBe('manual');
    expect(deriveQueue(b2b({ dispatchState: 'needs_attention' }))).toBe('needs_attention');
    expect(deriveQueue(b2b({ dispatchState: 'pending' }))).toBe('pending');
    expect(deriveQueue(b2b({ status: 'completed', dispatchState: 'done', verificationStatus: 'requested' }))).toBe(
      'verification',
    );
    expect(deriveQueue(b2b({ status: 'processing', dispatchState: 'operator' }))).toBeNull();
    expect(deriveQueue(b2b({ status: 'processing', dispatchState: 'sent' }))).toBeNull();
    expect(deriveQueue(b2b({ status: 'completed', dispatchState: 'done' }))).toBeNull();
    expect(deriveQueue(b2b({ status: 'completed', dispatchState: 'done', verificationStatus: 'accepted' }))).toBeNull();
  });

  it('derives the pending queue for a pending order being sent, and none for a processing one', () => {
    expect(deriveQueue(b2b({ dispatchState: 'dispatching' }))).toBe('pending');
    expect(deriveQueue(b2b({ status: 'processing', dispatchState: 'dispatching' }))).toBeNull();
  });

  it('knows which statuses are open', () => {
    expect(isOpen('pending')).toBe(true);
    expect(isOpen('processing')).toBe(true);
    expect(isOpen('completed')).toBe(false);
    expect(isOpen('rejected')).toBe(false);
  });
});

describe('placementDispatchState', () => {
  const base = { held: false, deliveredFromInventory: false, manualService: false, hasActiveSupplierLink: true };

  it('holds, delivers from inventory, goes manual or waits for the dispatch job', () => {
    expect(placementDispatchState({ ...base, held: true })).toEqual({
      status: 'pending',
      dispatchState: 'held',
      enqueueDispatch: false,
    });
    expect(placementDispatchState({ ...base, deliveredFromInventory: true })).toEqual({
      status: 'completed',
      dispatchState: 'done',
      enqueueDispatch: false,
    });
    expect(placementDispatchState({ ...base, manualService: true }).dispatchState).toBe('manual');
    expect(placementDispatchState({ ...base, hasActiveSupplierLink: false }).dispatchState).toBe('manual');
    expect(placementDispatchState(base)).toEqual({
      status: 'pending',
      dispatchState: 'pending',
      enqueueDispatch: true,
    });
  });
});

describe('staff actions', () => {
  it('accept: manual → operator (processing, no queue), and only from manual', () => {
    const result = allowed(decideOrderAction(b2b({ dispatchState: 'manual' }), { kind: 'accept' }));
    expect(result.next).toEqual({ status: 'processing', dispatchState: 'operator', verificationStatus: null });
    expect(result).toMatchObject({ event: 'accepted', money: null, statusChanged: true });
    expect(deriveQueue(result.next)).toBeNull();
    expect(decideOrderAction(b2b(), { kind: 'accept' })).toEqual({ ok: false, refusal: 'NOT_MANUAL' });
    expect(decideOrderAction(b2b({ dispatchState: 'operator' }), { kind: 'accept' })).toEqual({
      ok: false,
      refusal: 'NOT_MANUAL',
    });
    expect(decideOrderAction(b2c({ dispatchState: 'held' }), { kind: 'accept' })).toEqual({
      ok: false,
      refusal: 'ORDER_HELD',
    });
    expect(decideOrderAction(b2b({ status: 'completed', dispatchState: 'done' }), { kind: 'accept' })).toEqual({
      ok: false,
      refusal: 'ORDER_NOT_OPEN',
    });
  });

  it('reply: any open order that is not held completes and settles (B2B complete, B2C deliver)', () => {
    for (const dispatchState of ['pending', 'manual', 'operator', 'sent', 'needs_attention'] as const) {
      const status = dispatchState === 'operator' || dispatchState === 'sent' ? 'processing' : 'pending';
      const result = allowed(decideOrderAction(b2b({ status, dispatchState }), { kind: 'reply' }));
      expect(result.next).toEqual({ status: 'completed', dispatchState: 'done', verificationStatus: null });
      expect(result).toMatchObject({ event: 'completed', money: 'complete', statusChanged: true });
      expect(deriveQueue(result.next)).toBeNull();
    }
    expect(allowed(decideOrderAction(b2c({ dispatchState: 'manual' }), { kind: 'reply' })).money).toBe('b2c_deliver');
    expect(decideOrderAction(b2c({ dispatchState: 'held' }), { kind: 'reply' })).toEqual({
      ok: false,
      refusal: 'ORDER_HELD',
    });
    expect(decideOrderAction(b2b({ status: 'rejected', dispatchState: 'done' }), { kind: 'reply' })).toEqual({
      ok: false,
      refusal: 'ORDER_NOT_OPEN',
    });
  });

  it('reject: any open order that is not held is released; a reopened B2C order goes to the refunds page', () => {
    const result = allowed(decideOrderAction(b2b({ dispatchState: 'needs_attention' }), { kind: 'reject' }));
    expect(result.next).toEqual({ status: 'rejected', dispatchState: 'done', verificationStatus: null });
    expect(result).toMatchObject({ event: 'rejected', money: 'reject', statusChanged: true });
    expect(deriveQueue(result.next)).toBeNull();
    expect(allowed(decideOrderAction(b2c({ dispatchState: 'manual' }), { kind: 'reject' })).money).toBe('b2c_refund');
    expect(
      decideOrderAction(b2c({ status: 'processing', dispatchState: 'operator', completedBefore: true }), {
        kind: 'reject',
      }),
    ).toEqual({ ok: false, refusal: 'USE_REFUNDS' });
    expect(decideOrderAction(b2c({ dispatchState: 'held' }), { kind: 'reject' })).toEqual({
      ok: false,
      refusal: 'ORDER_HELD',
    });
  });

  it('refund: a completed B2B order becomes rejected in one step (revenue → wallet); B2C uses the refunds page', () => {
    const result = allowed(decideOrderAction(b2b({ status: 'completed', dispatchState: 'done' }), { kind: 'refund' }));
    expect(result.next).toEqual({ status: 'rejected', dispatchState: 'done', verificationStatus: null });
    expect(result).toMatchObject({ event: 'refund', money: 'refund', statusChanged: true });
    expect(decideOrderAction(b2b({ status: 'processing', dispatchState: 'operator' }), { kind: 'refund' })).toEqual({
      ok: false,
      refusal: 'ORDER_NOT_COMPLETED',
    });
    expect(decideOrderAction(b2c({ status: 'completed', dispatchState: 'done' }), { kind: 'refund' })).toEqual({
      ok: false,
      refusal: 'USE_REFUNDS',
    });
  });

  it('reopen: completed → operator (processing, no queue), revenue back to the hold; never a rejected order', () => {
    const result = allowed(decideOrderAction(b2b({ status: 'completed', dispatchState: 'done' }), { kind: 'reopen' }));
    expect(result.next).toEqual({ status: 'processing', dispatchState: 'operator', verificationStatus: null });
    expect(result).toMatchObject({ event: 'reopened', money: 'reopen', statusChanged: true });
    expect(deriveQueue(result.next)).toBeNull();
    expect(decideOrderAction(b2b({ status: 'rejected', dispatchState: 'done' }), { kind: 'reopen' })).toEqual({
      ok: false,
      refusal: 'ORDER_NOT_OPEN',
    });
    expect(decideOrderAction(b2b({ status: 'processing', dispatchState: 'operator' }), { kind: 'reopen' })).toEqual({
      ok: false,
      refusal: 'ORDER_NOT_COMPLETED',
    });
  });

  it('verification: accept keeps the charge; refund rejects with the refund money; only for a pending request', () => {
    const waiting = b2b({ status: 'completed', dispatchState: 'done', verificationStatus: 'requested' });
    expect(deriveQueue(waiting)).toBe('verification');
    const accepted = allowed(decideOrderAction(waiting, { kind: 'verification', decision: 'accept' }));
    expect(accepted.next).toEqual({ status: 'completed', dispatchState: 'done', verificationStatus: 'accepted' });
    expect(accepted).toMatchObject({ event: 'verification', money: null, statusChanged: false });
    expect(deriveQueue(accepted.next)).toBeNull();
    const refunded = allowed(decideOrderAction(waiting, { kind: 'verification', decision: 'refund' }));
    expect(refunded.next).toEqual({ status: 'rejected', dispatchState: 'done', verificationStatus: 'refunded' });
    expect(refunded).toMatchObject({ event: 'verification', money: 'refund', statusChanged: true });
    expect(
      decideOrderAction(b2b({ status: 'completed', dispatchState: 'done' }), {
        kind: 'verification',
        decision: 'accept',
      }),
    ).toEqual({ ok: false, refusal: 'NOT_IN_VERIFICATION' });
  });

  it('staff dispatch: needs_attention, manual and operator go back to the dispatch job; a pending order whose request is live is a no-op', () => {
    for (const [status, dispatchState] of [
      ['pending', 'needs_attention'],
      ['pending', 'manual'],
      ['processing', 'operator'],
    ] as const) {
      const result = allowed(
        decideOrderAction(b2b({ status, dispatchState }), { kind: 'staffDispatch', requestLive: false }),
      );
      expect(result.next.dispatchState).toBe('pending');
      expect(result.next.status).toBe(status);
      expect(result).toMatchObject({ event: 'retry', enqueueDispatch: true, noop: false, money: null });
    }
    expect(queueAfter(b2b({ dispatchState: 'manual' }), { kind: 'staffDispatch', requestLive: false })).toBe('pending');
    expect(allowed(decideOrderAction(b2b(), { kind: 'staffDispatch', requestLive: true }))).toMatchObject({
      noop: true,
      enqueueDispatch: false,
    });
    expect(decideOrderAction(b2c({ dispatchState: 'held' }), { kind: 'staffDispatch', requestLive: false })).toEqual({
      ok: false,
      refusal: 'ORDER_HELD',
    });
    expect(
      decideOrderAction(b2b({ status: 'processing', dispatchState: 'sent' }), {
        kind: 'staffDispatch',
        requestLive: false,
      }),
    ).toEqual({ ok: false, refusal: 'ALREADY_SENT' });
  });

  it('staff dispatch: a pending order whose request was lost is queued again; with a live request it is a no-op', () => {
    const lost = allowed(decideOrderAction(b2b(), { kind: 'staffDispatch', requestLive: false }));
    expect(lost).toMatchObject({
      next: { status: 'pending', dispatchState: 'pending' },
      event: 'retry',
      enqueueDispatch: true,
      noop: false,
      money: null,
    });
    expect(allowed(decideOrderAction(b2b(), { kind: 'staffDispatch', requestLive: true }))).toMatchObject({
      event: 'retry',
      enqueueDispatch: false,
      noop: true,
    });
  });

  it('change-supplier: unchanged, except a forgotten reference on a sent order and the dispatch option', () => {
    const sent = b2b({ status: 'processing', dispatchState: 'sent' });
    const kept = allowed(
      decideOrderAction(sent, {
        kind: 'changeSupplier',
        resetReference: false,
        dispatch: false,
        supplierChanges: false,
      }),
    );
    expect(kept.next.dispatchState).toBe('sent');
    expect(kept.event).toBe('supplier_changed');
    const reset = allowed(
      decideOrderAction(sent, {
        kind: 'changeSupplier',
        resetReference: true,
        dispatch: false,
        supplierChanges: false,
      }),
    );
    expect(reset.next.dispatchState).toBe('needs_attention');
    expect(deriveQueue(reset.next)).toBe('needs_attention');
    const redispatch = allowed(
      decideOrderAction(b2b({ dispatchState: 'needs_attention' }), {
        kind: 'changeSupplier',
        resetReference: true,
        dispatch: true,
        supplierChanges: true,
      }),
    );
    expect(redispatch).toMatchObject({ next: { dispatchState: 'pending' }, enqueueDispatch: true });
    expect(
      decideOrderAction(b2c({ dispatchState: 'held' }), {
        kind: 'changeSupplier',
        resetReference: false,
        dispatch: true,
        supplierChanges: false,
      }),
    ).toEqual({ ok: false, refusal: 'ORDER_HELD' });
    expect(
      decideOrderAction(b2b({ status: 'completed', dispatchState: 'done' }), {
        kind: 'changeSupplier',
        resetReference: false,
        dispatch: false,
        supplierChanges: false,
      }),
    ).toEqual({ ok: false, refusal: 'ORDER_NOT_OPEN' });
  });

  it('change-supplier: another supplier makes a sent order need attention even without a reset; the same supplier keeps it sent', () => {
    const sent = b2b({ status: 'processing', dispatchState: 'sent' });
    const other = allowed(
      decideOrderAction(sent, {
        kind: 'changeSupplier',
        resetReference: false,
        dispatch: false,
        supplierChanges: true,
      }),
    );
    expect(other.next.dispatchState).toBe('needs_attention');
    const same = allowed(
      decideOrderAction(sent, {
        kind: 'changeSupplier',
        resetReference: false,
        dispatch: false,
        supplierChanges: false,
      }),
    );
    expect(same.next.dispatchState).toBe('sent');
    // The same call that dispatches sends the order again instead.
    const again = allowed(
      decideOrderAction(sent, { kind: 'changeSupplier', resetReference: false, dispatch: true, supplierChanges: true }),
    );
    expect(again).toMatchObject({ next: { dispatchState: 'pending' }, enqueueDispatch: true });
  });
});

describe('supplier jobs', () => {
  it('dispatch result: REFERENCEID → sent (processing); a refusal or timeout → needs_attention, status unchanged; only an order being sent takes it', () => {
    const sending = b2b({ dispatchState: 'dispatching' });
    const sent = allowed(decideOrderAction(sending, { kind: 'dispatchResult', result: 'sent' }));
    expect(sent.next).toEqual({ status: 'processing', dispatchState: 'sent', verificationStatus: null });
    expect(sent).toMatchObject({ event: 'ack', statusChanged: true });
    expect(deriveQueue(sent.next)).toBeNull();
    const failed = allowed(decideOrderAction(sending, { kind: 'dispatchResult', result: 'failed' }));
    expect(failed.next).toEqual({ status: 'pending', dispatchState: 'needs_attention', verificationStatus: null });
    expect(failed).toMatchObject({ event: 'review', statusChanged: false, money: null });
    expect(deriveQueue(failed.next)).toBe('needs_attention');
    // A retried or duplicated job meets an order that moved on: refused, so it does nothing.
    expect(
      decideOrderAction(b2b({ status: 'processing', dispatchState: 'sent' }), {
        kind: 'dispatchResult',
        result: 'sent',
      }),
    ).toEqual({ ok: false, refusal: 'INVALID_TRANSITION' });
  });

  it('dispatch result: only an order being sent takes the answer; a pending one is refused', () => {
    for (const result of ['sent', 'failed'] as const) {
      expect(decideOrderAction(b2b(), { kind: 'dispatchResult', result })).toEqual({
        ok: false,
        refusal: 'INVALID_TRANSITION',
      });
      expect(
        decideOrderAction(b2b({ status: 'completed', dispatchState: 'done' }), { kind: 'dispatchResult', result }),
      ).toEqual({ ok: false, refusal: 'INVALID_TRANSITION' });
      expect(
        decideOrderAction(b2b({ status: 'rejected', dispatchState: 'dispatching' }), {
          kind: 'dispatchResult',
          result,
        }),
      ).toEqual({ ok: false, refusal: 'INVALID_TRANSITION' });
    }
  });

  it('dispatchBlocked: a pending order stops in needs_attention (review, status unchanged, nothing queued); refused once claimed or closed', () => {
    const blocked = allowed(decideOrderAction(b2b(), { kind: 'dispatchBlocked' }));
    expect(blocked.next).toEqual({ status: 'pending', dispatchState: 'needs_attention', verificationStatus: null });
    expect(blocked).toMatchObject({ event: 'review', statusChanged: false, enqueueDispatch: false, money: null });
    expect(deriveQueue(blocked.next)).toBe('needs_attention');
    for (const state of [
      b2b({ dispatchState: 'dispatching' }),
      b2b({ status: 'processing', dispatchState: 'sent' }),
      b2b({ dispatchState: 'needs_attention' }),
      b2b({ status: 'rejected', dispatchState: 'pending' }),
    ]) {
      expect(decideOrderAction(state, { kind: 'dispatchBlocked' })).toEqual({
        ok: false,
        refusal: 'INVALID_TRANSITION',
      });
    }
  });

  it('requeueDispatch: only a pending order; event retry, the job queued, the state unchanged', () => {
    const again = allowed(decideOrderAction(b2b(), { kind: 'requeueDispatch' }));
    expect(again.next).toEqual({ status: 'pending', dispatchState: 'pending', verificationStatus: null });
    expect(again).toMatchObject({
      event: 'retry',
      enqueueDispatch: true,
      noop: false,
      statusChanged: false,
      money: null,
    });
    for (const state of [
      b2b({ dispatchState: 'dispatching' }),
      b2b({ dispatchState: 'needs_attention' }),
      b2b({ dispatchState: 'manual' }),
      b2b({ status: 'completed', dispatchState: 'done' }),
    ]) {
      expect(decideOrderAction(state, { kind: 'requeueDispatch' })).toEqual({
        ok: false,
        refusal: 'INVALID_TRANSITION',
      });
    }
  });

  it('poll or fetch: STATUS 4 completes, STATUS 3 rejects, still running sends needs_attention back to polling', () => {
    const sent = b2b({ status: 'processing', dispatchState: 'sent' });
    expect(allowed(decideOrderAction(sent, { kind: 'supplierResult', result: 'completed' }))).toMatchObject({
      next: { status: 'completed', dispatchState: 'done' },
      event: 'completed',
      money: 'complete',
    });
    expect(allowed(decideOrderAction(sent, { kind: 'supplierResult', result: 'rejected' }))).toMatchObject({
      next: { status: 'rejected', dispatchState: 'done' },
      event: 'rejected',
      money: 'reject',
    });
    expect(allowed(decideOrderAction(sent, { kind: 'supplierResult', result: 'running' }))).toMatchObject({
      noop: true,
      event: 'fetch',
    });
    const waiting = b2b({ dispatchState: 'needs_attention' });
    const back = allowed(decideOrderAction(waiting, { kind: 'supplierResult', result: 'running' }));
    expect(back.next.dispatchState).toBe('sent');
    expect(deriveQueue(back.next)).toBeNull();
    expect(
      decideOrderAction(b2b({ dispatchState: 'manual' }), { kind: 'supplierResult', result: 'completed' }),
    ).toEqual({ ok: false, refusal: 'INVALID_TRANSITION' });
  });
});

describe('merchant and risk actions', () => {
  it('cancel: only while never sent (pending, manual, held), releasing the hold', () => {
    for (const dispatchState of ['pending', 'manual'] as const) {
      expect(allowed(decideOrderAction(b2b({ dispatchState }), { kind: 'cancel' }))).toMatchObject({
        next: { status: 'rejected', dispatchState: 'done' },
        event: 'rejected',
        money: 'reject',
      });
    }
    expect(decideOrderAction(b2b({ status: 'processing', dispatchState: 'sent' }), { kind: 'cancel' })).toEqual({
      ok: false,
      refusal: 'ALREADY_SENT',
    });
    expect(decideOrderAction(b2b({ status: 'processing', dispatchState: 'operator' }), { kind: 'cancel' })).toEqual({
      ok: false,
      refusal: 'INVALID_TRANSITION',
    });
    expect(decideOrderAction(b2b({ status: 'completed', dispatchState: 'done' }), { kind: 'cancel' })).toEqual({
      ok: false,
      refusal: 'ORDER_NOT_OPEN',
    });
  });

  it('request verification: once per completed order', () => {
    const done = b2b({ status: 'completed', dispatchState: 'done' });
    const asked = allowed(decideOrderAction(done, { kind: 'requestVerification' }));
    expect(asked.next.verificationStatus).toBe('requested');
    expect(deriveQueue(asked.next)).toBe('verification');
    expect(decideOrderAction({ ...done, verificationStatus: 'accepted' }, { kind: 'requestVerification' })).toEqual({
      ok: false,
      refusal: 'INVALID_TRANSITION',
    });
    expect(decideOrderAction(b2b(), { kind: 'requestVerification' })).toEqual({
      ok: false,
      refusal: 'ORDER_NOT_COMPLETED',
    });
  });

  it('risk: approve releases a held order to the dispatch job or the manual queue; refund rejects it', () => {
    const held = b2c({ dispatchState: 'held' });
    expect(allowed(decideOrderAction(held, { kind: 'riskApprove', manual: false }))).toMatchObject({
      next: { dispatchState: 'pending' },
      enqueueDispatch: true,
      event: 'risk',
    });
    expect(queueAfter(held, { kind: 'riskApprove', manual: true })).toBe('manual');
    expect(allowed(decideOrderAction(held, { kind: 'riskRefund' }))).toMatchObject({
      next: { status: 'rejected', dispatchState: 'done' },
      money: 'b2c_refund',
    });
    expect(decideOrderAction(b2c(), { kind: 'riskRefund' })).toEqual({ ok: false, refusal: 'INVALID_TRANSITION' });
  });
  it('refund approved (feature 16): cancels an open storefront order in any queue, even held or reopened, and refunds its money', () => {
    for (const state of [
      b2c({ dispatchState: 'pending' }),
      b2c({ dispatchState: 'manual' }),
      b2c({ dispatchState: 'held' }),
      b2c({ status: 'processing', dispatchState: 'sent' }),
      b2c({ status: 'processing', dispatchState: 'needs_attention' }),
      b2c({ status: 'pending', dispatchState: 'manual', completedBefore: true }),
    ]) {
      expect(allowed(decideOrderAction(state, { kind: 'refundApproved' }))).toMatchObject({
        next: { status: 'rejected', dispatchState: 'done' },
        event: 'rejected',
        money: 'b2c_refund',
      });
    }
    expect(queueAfter(b2c({ dispatchState: 'held' }), { kind: 'refundApproved' })).toBeNull();
  });

  it('refund approved: refuses a merchant order and an order that is already closed', () => {
    expect(decideOrderAction(b2b(), { kind: 'refundApproved' })).toEqual({ ok: false, refusal: 'INVALID_TRANSITION' });
    for (const status of ['completed', 'rejected'] as const) {
      expect(decideOrderAction(b2c({ status, dispatchState: 'done' }), { kind: 'refundApproved' })).toEqual({
        ok: false,
        refusal: 'ORDER_NOT_OPEN',
      });
    }
  });
});

describe('a send in flight (decision 044)', () => {
  const sending = (state: Partial<OrderState> = {}) => b2b({ dispatchState: 'dispatching', ...state });
  const WAIT = { ok: false, refusal: 'ALREADY_SENT', sending: true } as const;

  it('staff reply, reject, every change of supplier, staff dispatch and a storefront refund approval wait (ALREADY_SENT, sending)', () => {
    expect(decideOrderAction(sending(), { kind: 'reply' })).toEqual(WAIT);
    expect(decideOrderAction(sending(), { kind: 'reject' })).toEqual(WAIT);
    expect(decideOrderAction(b2c({ dispatchState: 'dispatching' }), { kind: 'reject' })).toEqual(WAIT);
    expect(decideOrderAction(sending(), { kind: 'staffDispatch', requestLive: false })).toEqual(WAIT);
    expect(decideOrderAction(sending(), { kind: 'staffDispatch', requestLive: true })).toEqual(WAIT);
    for (const resetReference of [false, true]) {
      for (const dispatch of [false, true]) {
        for (const supplierChanges of [false, true]) {
          expect(
            decideOrderAction(sending(), { kind: 'changeSupplier', resetReference, dispatch, supplierChanges }),
          ).toEqual(WAIT);
        }
      }
    }
    expect(decideOrderAction(b2c({ dispatchState: 'dispatching' }), { kind: 'refundApproved' })).toEqual(WAIT);
    // A processing order claimed by the job waits just the same.
    expect(decideOrderAction(sending({ status: 'processing' }), { kind: 'reply' })).toEqual(WAIT);
  });

  it('a merchant cancel is refused like a sent order (ALREADY_SENT without the sending flag)', () => {
    expect(decideOrderAction(sending(), { kind: 'cancel' })).toEqual({ ok: false, refusal: 'ALREADY_SENT' });
    expect(decideOrderAction(b2b({ status: 'processing', dispatchState: 'sent' }), { kind: 'cancel' })).toEqual({
      ok: false,
      refusal: 'ALREADY_SENT',
    });
  });

  it('a merchant cancel is refused for good once the order was ever claimed: pending, manual and held answer ALREADY_SENT without the sending flag', () => {
    for (const dispatchState of ['pending', 'manual', 'held'] as const) {
      expect(decideOrderAction(b2b({ dispatchState, everDispatched: true }), { kind: 'cancel' })).toEqual({
        ok: false,
        refusal: 'ALREADY_SENT',
      });
      expect(decideOrderAction(b2c({ dispatchState, everDispatched: true }), { kind: 'cancel' })).toEqual({
        ok: false,
        refusal: 'ALREADY_SENT',
      });
      expect(
        allowed(decideOrderAction(b2b({ dispatchState, everDispatched: false }), { kind: 'cancel' })),
      ).toMatchObject({
        next: { status: 'rejected', dispatchState: 'done' },
        money: 'reject',
      });
    }
    // The flag answers before the state list: a claimed order in needs attention or with an operator is ALREADY_SENT, not INVALID_TRANSITION.
    for (const dispatchState of ['needs_attention', 'operator'] as const) {
      expect(decideOrderAction(b2b({ dispatchState, everDispatched: true }), { kind: 'cancel' })).toEqual({
        ok: false,
        refusal: 'ALREADY_SENT',
      });
      expect(decideOrderAction(b2b({ dispatchState, everDispatched: false }), { kind: 'cancel' })).toEqual({
        ok: false,
        refusal: 'INVALID_TRANSITION',
      });
    }
    // A closed order stays ORDER_NOT_OPEN whatever the flag says.
    expect(
      decideOrderAction(b2b({ status: 'rejected', dispatchState: 'done', everDispatched: true }), { kind: 'cancel' }),
    ).toEqual({ ok: false, refusal: 'ORDER_NOT_OPEN' });
  });

  it('accept answers NOT_MANUAL, a supplier result and the risk actions INVALID_TRANSITION', () => {
    expect(decideOrderAction(sending(), { kind: 'accept' })).toEqual({ ok: false, refusal: 'NOT_MANUAL' });
    for (const result of ['completed', 'rejected', 'running'] as const) {
      expect(decideOrderAction(sending(), { kind: 'supplierResult', result })).toEqual({
        ok: false,
        refusal: 'INVALID_TRANSITION',
      });
    }
    expect(decideOrderAction(sending(), { kind: 'riskApprove', manual: false })).toEqual({
      ok: false,
      refusal: 'INVALID_TRANSITION',
    });
    expect(decideOrderAction(sending(), { kind: 'riskRefund' })).toEqual({ ok: false, refusal: 'INVALID_TRANSITION' });
  });
});

describe('the wire view of the dispatch state (decision 044)', () => {
  it('shows dispatching as pending and keeps the others; WIRE_DISPATCH_STATES is every stored state but dispatching, in the contract order', () => {
    expect(wireDispatchState('dispatching')).toBe('pending');
    for (const state of ORDER_DISPATCH_STATES.filter((value) => value !== 'dispatching')) {
      expect(wireDispatchState(state)).toBe(state);
    }
    expect([...WIRE_DISPATCH_STATES]).toEqual([
      'pending',
      'held',
      'manual',
      'operator',
      'sent',
      'needs_attention',
      'done',
    ]);
    expect([...WIRE_DISPATCH_STATES]).toEqual(ORDER_DISPATCH_STATES.filter((value) => value !== 'dispatching'));
  });

  it('orderStateOf treats a pending order with sent_at (a claim of an earlier release) as dispatching, and maps the channel', () => {
    const base = { status: 'pending', verificationStatus: null, clientId: 7, sentAt: null } as const;
    expect(orderStateOf({ ...base, dispatchState: 'pending' })).toEqual({
      status: 'pending',
      dispatchState: 'pending',
      verificationStatus: null,
      channel: 'b2b',
      completedBefore: false,
      everDispatched: false,
    });
    expect(orderStateOf({ ...base, dispatchState: 'pending' }, false, true).everDispatched).toBe(true);
    expect(orderStateOf({ ...base, dispatchState: 'pending', sentAt: new Date(0) }).dispatchState).toBe('dispatching');
    expect(orderStateOf({ ...base, dispatchState: 'dispatching', sentAt: new Date(0) }).dispatchState).toBe(
      'dispatching',
    );
    // sent_at is also set on sent and needs_attention orders: only a pending one is a claim in flight.
    expect(orderStateOf({ ...base, dispatchState: 'sent', sentAt: new Date(0) }).dispatchState).toBe('sent');
    expect(orderStateOf({ ...base, dispatchState: 'needs_attention', sentAt: new Date(0) }).dispatchState).toBe(
      'needs_attention',
    );
    expect(orderStateOf({ ...base, clientId: null, dispatchState: 'held' }, true)).toMatchObject({
      channel: 'b2c',
      completedBefore: true,
    });
  });
});
