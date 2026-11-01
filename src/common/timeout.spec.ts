// Unit tests of the promise helpers used by startup and shutdown code: a deadline that cleans up after itself.
// Real waits (decision 031): these tests are about the real timers behind `withTimeout` and `sleep`; each wait is 60 ms at most.
import { describe, expect, it } from 'bun:test';
import { expectRejection } from '../../test/support/rejection';
import { TimeoutError, sleep, withTimeout } from './timeout';

describe('withTimeout', () => {
  it('returns what the work resolves with, when it is quicker than the deadline', async () => {
    expect(await withTimeout(Promise.resolve('done'), 1_000, 'work')).toBe('done');
  });

  it('passes on the rejection of the work', async () => {
    const error = await expectRejection(withTimeout(Promise.reject(new Error('boom')), 1_000, 'work'), 'boom');
    expect(error).not.toBeInstanceOf(TimeoutError);
  });

  it('rejects with a TimeoutError naming the work and the deadline when the work is too slow', async () => {
    const started = performance.now();
    const error = await expectRejection(
      withTimeout(new Promise<never>(() => undefined), 60, 'Redis connection'),
      TimeoutError,
    );
    expect((error as TimeoutError).message).toBe('Redis connection timed out after 60 ms');
    expect((error as TimeoutError).timeoutMs).toBe(60);
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('does not turn a rejection that arrives after the deadline into an unhandled rejection', async () => {
    let rejectLate: (reason: Error) => void = () => undefined;
    const late = new Promise<never>((_resolve, reject) => (rejectLate = reject));
    await expectRejection(withTimeout(late, 30, 'work'), TimeoutError);
    rejectLate(new Error('too late')); // would crash the test run if nobody handled it
    await sleep(20);
  });

  it('leaves no timer behind after a quick success (the process can exit at once)', async () => {
    const started = performance.now();
    await withTimeout(Promise.resolve(1), 5_000, 'work');
    // If the 5 s timer were still pending, the awaited sleep below would not change that, but the abort is observable:
    // a second call must not be affected by the first one's deadline.
    await withTimeout(sleep(30), 5_000, 'work');
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe('sleep', () => {
  it('waits about the given time', async () => {
    const started = performance.now();
    await sleep(50);
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });
});
