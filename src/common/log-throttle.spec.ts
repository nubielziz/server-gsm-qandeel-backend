// Unit tests of the log throttle: one line per interval and key, with a count of what was dropped.
import { describe, expect, it } from 'bun:test';
import { LogThrottle } from './log-throttle';

describe('LogThrottle', () => {
  it('lets the first message through and drops repeats inside the interval', () => {
    let now = 1_000;
    const throttle = new LogThrottle(30_000, () => now);
    expect(throttle.attempt('a')).toEqual({ suppressed: 0 });
    now += 1_000;
    expect(throttle.attempt('a')).toBeUndefined();
    now += 28_999;
    expect(throttle.attempt('a')).toBeUndefined();
  });

  it('reports how many messages were dropped when the interval has passed', () => {
    let now = 0;
    const throttle = new LogThrottle(1_000, () => now);
    throttle.attempt('a');
    for (let i = 0; i < 4; i++) throttle.attempt('a');
    now = 1_000;
    expect(throttle.attempt('a')).toEqual({ suppressed: 4 });
    now = 2_000;
    expect(throttle.attempt('a')).toEqual({ suppressed: 0 });
  });

  it('keeps one clock per key', () => {
    const throttle = new LogThrottle(1_000, () => 5);
    expect(throttle.attempt('a')).toBeDefined();
    expect(throttle.attempt('b')).toBeDefined();
    expect(throttle.attempt('a')).toBeUndefined();
  });
});
