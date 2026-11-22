// Unit tests of the rule that decides whether outbox-driven work was lost (decision 055), one case per rule in its order.
import { describe, expect, it } from 'bun:test';
import { LOST_AFTER_MS, MAX_RECONCILE_REQUESTS, lostWorkAction } from '@src/modules/platform/lost-work/lost-work-rules';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const OLD = ago(2 * 60 * 60_000);

describe('lostWorkAction', () => {
  it('waits ten minutes and asks again at most three times', () => {
    expect(LOST_AFTER_MS).toBe(600_000);
    expect(MAX_RECONCILE_REQUESTS).toBe(3);
  });

  it('answers unknown when the jobs could not be read, whatever else holds', () => {
    for (const newestAt of [null, OLD, ago(1_000)]) {
      for (const reconcileRequests of [0, 3]) {
        expect(lostWorkAction({ state: 'unknown', newestAt, reconcileRequests, now: NOW })).toBe('unknown');
      }
    }
  });

  it('waits for a live request, however old, and after the limit too', () => {
    expect(lostWorkAction({ state: 'live', newestAt: OLD, reconcileRequests: 0, now: NOW })).toBe('wait');
    expect(lostWorkAction({ state: 'live', newestAt: OLD, reconcileRequests: 5, now: NOW })).toBe('wait');
  });

  it('leaves a row that was never requested alone', () => {
    expect(lostWorkAction({ state: 'none', newestAt: null, reconcileRequests: 0, now: NOW })).toBe('never_requested');
  });

  it('waits for a request younger than ten minutes', () => {
    expect(lostWorkAction({ state: 'none', newestAt: ago(9 * 60_000 + 59_000), reconcileRequests: 0, now: NOW })).toBe(
      'wait',
    );
  });

  it('asks again for a request exactly ten minutes old', () => {
    expect(lostWorkAction({ state: 'none', newestAt: ago(LOST_AFTER_MS), reconcileRequests: 0, now: NOW })).toBe(
      'request',
    );
  });

  it('gives up after three earlier re-requests, and asks again after two', () => {
    expect(lostWorkAction({ state: 'none', newestAt: OLD, reconcileRequests: 3, now: NOW })).toBe('give_up');
    expect(lostWorkAction({ state: 'none', newestAt: OLD, reconcileRequests: 2, now: NOW })).toBe('request');
  });
});
