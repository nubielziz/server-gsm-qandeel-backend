// Unit tests of the dispatch sweep's pure rule (decision 044): when a lost dispatch request is asked for again and when it is given up.
import { describe, expect, it } from 'bun:test';
import {
  DISPATCH_REQUEUE_AFTER_MS,
  DISPATCH_REQUEUE_MAX_AGE_MS,
  MAX_AUTOMATIC_REQUEUES,
  lostRequestAction,
} from '@src/modules/suppliers/domain/dispatch-sweep-rules';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const base = {
  requests: 'none' as const,
  lastRequestedAt: ago(DISPATCH_REQUEUE_AFTER_MS + 1),
  automaticRequeues: 0,
  now: NOW,
};

describe('lostRequestAction', () => {
  it('waits while a request is live or unknown, or younger than 5 minutes', () => {
    expect(lostRequestAction({ ...base, requests: 'live' })).toBe('wait');
    expect(lostRequestAction({ ...base, requests: 'unknown' })).toBe('wait');
    expect(lostRequestAction({ ...base, lastRequestedAt: ago(DISPATCH_REQUEUE_AFTER_MS - 1) })).toBe('wait');
    // A live request waits however old it is: the job decides.
    expect(
      lostRequestAction({ ...base, requests: 'live', lastRequestedAt: ago(DISPATCH_REQUEUE_MAX_AGE_MS * 2) }),
    ).toBe('wait');
  });

  it('requeues after 5 minutes without a live request, and stops after 3 automatic requests and after 24 hours', () => {
    expect(lostRequestAction({ ...base, lastRequestedAt: ago(DISPATCH_REQUEUE_AFTER_MS) })).toBe('requeue');
    expect(lostRequestAction(base)).toBe('requeue');
    expect(lostRequestAction({ ...base, automaticRequeues: MAX_AUTOMATIC_REQUEUES - 1 })).toBe('requeue');
    expect(lostRequestAction({ ...base, automaticRequeues: MAX_AUTOMATIC_REQUEUES })).toBe('stop_repeated');
    expect(lostRequestAction({ ...base, lastRequestedAt: ago(DISPATCH_REQUEUE_MAX_AGE_MS) })).toBe('requeue');
    expect(lostRequestAction({ ...base, lastRequestedAt: ago(DISPATCH_REQUEUE_MAX_AGE_MS + 1) })).toBe('stop_old');
    // Too old wins over the request count: nobody asks again after a day.
    expect(
      lostRequestAction({
        ...base,
        lastRequestedAt: ago(DISPATCH_REQUEUE_MAX_AGE_MS + 1),
        automaticRequeues: MAX_AUTOMATIC_REQUEUES,
      }),
    ).toBe('stop_old');
  });

  it('waits for an order that never had a request: nothing was lost, however old the order is', () => {
    expect(lostRequestAction({ ...base, lastRequestedAt: null })).toBe('wait');
    expect(lostRequestAction({ ...base, lastRequestedAt: null, automaticRequeues: MAX_AUTOMATIC_REQUEUES })).toBe(
      'wait',
    );
    expect(lostRequestAction({ ...base, lastRequestedAt: null, requests: 'live' })).toBe('wait');
    expect(lostRequestAction({ ...base, lastRequestedAt: null, requests: 'unknown' })).toBe('wait');
  });
});
