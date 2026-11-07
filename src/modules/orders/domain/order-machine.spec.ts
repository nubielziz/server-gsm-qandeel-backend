// Unit tests of the order state machine: every row of decision 025's transition table, with the queue each result shows
// (resolution orders-suppliers-11: "every action has a test of its resulting queue") and every refusal.
import { describe, expect, it } from 'bun:test';
import {
  type OrderAction,
  type OrderDecision,
  type OrderState,
  type OrderTransition,
  decideOrderAction,
  deriveQueue,
  isOpen,
  placementDispatchState,
} from './order-machine';

const b2b = (state: Partial<OrderState> = {}): OrderState => ({
  status: 'pending',
  dispatchState: 'pending',
  verificationStatus: null,
  channel: 'b2b',
  completedBefore: false,
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

  it('staff dispatch: needs_attention, manual and operator go back to the dispatch job; pending is a no-op', () => {
    for (const [status, dispatchState] of [
      ['pending', 'needs_attention'],
      ['pending', 'manual'],
      ['processing', 'operator'],
    ] as const) {
      const result = allowed(decideOrderAction(b2b({ status, dispatchState }), { kind: 'staffDispatch' }));
      expect(result.next.dispatchState).toBe('pending');
      expect(result.next.status).toBe(status);
      expect(result).toMatchObject({ event: 'retry', enqueueDispatch: true, noop: false, money: null });
    }
    expect(queueAfter(b2b({ dispatchState: 'manual' }), { kind: 'staffDispatch' })).toBe('pending');
    expect(allowed(decideOrderAction(b2b(), { kind: 'staffDispatch' }))).toMatchObject({
      noop: true,
      enqueueDispatch: false,
    });
    expect(decideOrderAction(b2c({ dispatchState: 'held' }), { kind: 'staffDispatch' })).toEqual({
      ok: false,
      refusal: 'ORDER_HELD',
    });
    expect(decideOrderAction(b2b({ status: 'processing', dispatchState: 'sent' }), { kind: 'staffDispatch' })).toEqual({
      ok: false,
      refusal: 'ALREADY_SENT',
    });
  });

  it('change-supplier: unchanged, except a reset reference on a sent order and the dispatch option', () => {
    const sent = b2b({ status: 'processing', dispatchState: 'sent' });
    const kept = allowed(decideOrderAction(sent, { kind: 'changeSupplier', resetReference: false, dispatch: false }));
    expect(kept.next.dispatchState).toBe('sent');
    expect(kept.event).toBe('supplier_changed');
    const reset = allowed(decideOrderAction(sent, { kind: 'changeSupplier', resetReference: true, dispatch: false }));
    expect(reset.next.dispatchState).toBe('needs_attention');
    expect(deriveQueue(reset.next)).toBe('needs_attention');
    const redispatch = allowed(
      decideOrderAction(b2b({ dispatchState: 'needs_attention' }), {
        kind: 'changeSupplier',
        resetReference: true,
        dispatch: true,
      }),
    );
    expect(redispatch).toMatchObject({ next: { dispatchState: 'pending' }, enqueueDispatch: true });
    expect(
      decideOrderAction(b2c({ dispatchState: 'held' }), {
        kind: 'changeSupplier',
        resetReference: false,
        dispatch: true,
      }),
    ).toEqual({ ok: false, refusal: 'ORDER_HELD' });
    expect(
      decideOrderAction(b2b({ status: 'completed', dispatchState: 'done' }), {
        kind: 'changeSupplier',
        resetReference: false,
        dispatch: false,
      }),
    ).toEqual({ ok: false, refusal: 'ORDER_NOT_OPEN' });
  });
});

describe('supplier jobs', () => {
  it('dispatch result: REFERENCEID → sent (processing); a refusal or timeout → needs_attention, status unchanged', () => {
    const sent = allowed(decideOrderAction(b2b(), { kind: 'dispatchResult', result: 'sent' }));
    expect(sent.next).toEqual({ status: 'processing', dispatchState: 'sent', verificationStatus: null });
    expect(sent).toMatchObject({ event: 'ack', statusChanged: true });
    expect(deriveQueue(sent.next)).toBeNull();
    const failed = allowed(decideOrderAction(b2b(), { kind: 'dispatchResult', result: 'failed' }));
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
});
