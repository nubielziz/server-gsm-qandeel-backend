// Unit tests of the cancel window of a website order (decision 075): which orders wait before they are sent, and until when.
import { describe, expect, it } from 'bun:test';
import { CANCEL_WINDOW_MS, type CancelWindowFacts, cancelWindowEnd } from '@src/modules/orders/domain/merchant-actions';

const PLACED = new Date('2026-11-27T10:00:00.000Z');
const END = new Date(PLACED.getTime() + CANCEL_WINDOW_MS);
const at = (ms: number) => new Date(PLACED.getTime() + ms);

function facts(
  order: Partial<CancelWindowFacts['order']> = {},
  rest: Partial<Omit<CancelWindowFacts, 'order'>> = {},
): CancelWindowFacts {
  return {
    order: { source: 'portal', status: 'pending', dispatchState: 'pending', sentAt: null, placedAt: PLACED, ...order },
    allowCancel: true,
    everDispatched: false,
    ...rest,
  };
}

describe('CANCEL_WINDOW_MS', () => {
  it('is two minutes', () => {
    expect(CANCEL_WINDOW_MS).toBe(120_000);
  });
});

describe('cancelWindowEnd', () => {
  it('is placed_at plus two minutes for a website order of a service that allows cancellation, until that moment', () => {
    expect(cancelWindowEnd(facts(), PLACED)).toEqual(END);
    expect(cancelWindowEnd(facts(), at(CANCEL_WINDOW_MS - 1))).toEqual(END);
    // The end itself is outside: the job sends at that moment.
    expect(cancelWindowEnd(facts(), END)).toBeNull();
    expect(cancelWindowEnd(facts(), at(CANCEL_WINDOW_MS + 60_000))).toBeNull();
  });

  it('counts from placed_at, whatever time the job runs (an open order that is processing still waits)', () => {
    expect(cancelWindowEnd(facts({ status: 'processing' }), at(30_000))).toEqual(END);
  });

  it('never applies to a Dhru, shop, admin or REST order', () => {
    for (const source of ['dhru', 'store', 'admin', 'v1'] as const) {
      expect(cancelWindowEnd(facts({ source }), PLACED), source).toBeNull();
    }
  });

  it('never applies when the service does not allow cancellation now', () => {
    expect(cancelWindowEnd(facts({}, { allowCancel: false }), PLACED)).toBeNull();
  });

  it('applies only to an order that waits for its first send: never claimed, never sent, pending and open', () => {
    expect(cancelWindowEnd(facts({}, { everDispatched: true }), PLACED)).toBeNull();
    expect(cancelWindowEnd(facts({ sentAt: PLACED }), PLACED)).toBeNull();
    for (const dispatchState of [
      'dispatching',
      'manual',
      'held',
      'operator',
      'sent',
      'needs_attention',
      'done',
    ] as const) {
      expect(cancelWindowEnd(facts({ dispatchState }), PLACED), dispatchState).toBeNull();
    }
    for (const status of ['completed', 'rejected'] as const) {
      expect(cancelWindowEnd(facts({ status }), PLACED), status).toBeNull();
    }
  });
});
