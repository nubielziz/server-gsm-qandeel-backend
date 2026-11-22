// Unit tests of the retries of a cache invalidation (decision 055): a fake wait records the pauses, so no time passes.
import { describe, expect, it } from 'bun:test';
import { INVALIDATION_RETRY_DELAYS_MS, withRetries } from '@src/infra/cache/cache-invalidation';

/** A wait that records how long it was asked to wait and returns at once. */
function recordingWait() {
  const waits: number[] = [];
  return { waits, wait: (ms: number) => Promise.resolve(void waits.push(ms)) };
}

/** An attempt that fails the given number of times, then answers `value`. */
function failingTimes<T>(failures: number, value: T) {
  const state = { calls: 0 };
  return {
    state,
    attempt: () => {
      state.calls += 1;
      return state.calls <= failures ? Promise.reject(new Error(`failure ${state.calls}`)) : Promise.resolve(value);
    },
  };
}

describe('withRetries', () => {
  it('tries three times in all, with waits of 50 and 250 ms', () => {
    expect(INVALIDATION_RETRY_DELAYS_MS).toEqual([50, 250]);
  });

  it('answers at the first success without waiting', async () => {
    const { waits, wait } = recordingWait();
    const source = failingTimes(0, 3);
    expect(await withRetries(source.attempt, INVALIDATION_RETRY_DELAYS_MS, wait)).toEqual({
      ok: true,
      value: 3,
      attempts: 1,
    });
    expect(waits).toEqual([]);
    expect(source.state.calls).toBe(1);
  });

  it('tries again after 50 and 250 ms and answers the third success', async () => {
    const { waits, wait } = recordingWait();
    const source = failingTimes(2, 'deleted');
    expect(await withRetries(source.attempt, INVALIDATION_RETRY_DELAYS_MS, wait)).toEqual({
      ok: true,
      value: 'deleted',
      attempts: 3,
    });
    expect(waits).toEqual([50, 250]);
  });

  it('gives up after three failures with the last error and never throws', async () => {
    const { waits, wait } = recordingWait();
    const source = failingTimes(10, 'never');
    const outcome = await withRetries(source.attempt, INVALIDATION_RETRY_DELAYS_MS, wait);
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(String((outcome as { error: unknown }).error)).toContain('failure 3');
    expect(source.state.calls).toBe(3);
    expect(waits).toEqual([50, 250]);
  });

  it('does not throw when the wait itself fails', async () => {
    const source = failingTimes(1, 'ok');
    const outcome = await withRetries(source.attempt, [10], () => Promise.reject(new Error('timer gone')));
    expect(outcome).toEqual({ ok: true, value: 'ok', attempts: 2 });
  });
});
