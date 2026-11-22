// Unit tests of the refusal sentences of OrderTransitions (decision 025, decision 044): the wait sentence of a send in flight and the sentence
// of a storefront payment that stops a release or a send.
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import { PAYMENT_STOP_REASONS, type OrderRefusal } from '@src/modules/orders/domain/order-machine';
import { SEND_IN_PROGRESS_DETAIL, refusalError } from '@src/modules/orders/application/order-transitions';

describe('refusalError', () => {
  it('gives the wait sentence for a send in flight and the usual sentence otherwise (string and decision inputs)', () => {
    const waiting = refusalError({ ok: false, refusal: 'ALREADY_SENT', sending: true });
    expect(waiting).toBeInstanceOf(AppError);
    expect(waiting.code).toBe('ALREADY_SENT');
    expect(waiting.detail).toBe(SEND_IN_PROGRESS_DETAIL);

    const sent = refusalError({ ok: false, refusal: 'ALREADY_SENT' });
    expect(sent.code).toBe('ALREADY_SENT');
    expect(sent.detail).toBe(
      'The supplier already has this order: fetch it, or change supplier with a reset reference first.',
    );
    expect(refusalError('ALREADY_SENT').detail).toBe(sent.detail);

    const closed: OrderRefusal = 'ORDER_NOT_OPEN';
    expect(refusalError(closed).detail).toBe('Only an open order can be changed.');
    expect(refusalError({ ok: false, refusal: closed }).detail).toBe('Only an open order can be changed.');
  });

  it('gives the payment sentence when the payment of a storefront order stops the action, with the code unchanged', () => {
    for (const payment of ['disputed', 'returned'] as const) {
      const stopped = refusalError({ ok: false, refusal: 'INVALID_TRANSITION', payment });
      expect(stopped.code).toBe('INVALID_TRANSITION');
      expect(stopped.detail).toBe(PAYMENT_STOP_REASONS[payment]);
    }
    expect(PAYMENT_STOP_REASONS.disputed).toContain('disputed');
    expect(PAYMENT_STOP_REASONS.returned).toContain('charged back');
  });
});
