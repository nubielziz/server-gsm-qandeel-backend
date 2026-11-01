// Unit tests of ShortMemo: freshness, sharing one load, the last good value on a failed reload, and clear().
import { describe, expect, it } from 'bun:test';
import { expectRejection } from '../../test/support/rejection';
import { ShortMemo } from './short-memo';

/** A clock the test moves by hand. */
function clock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe('ShortMemo', () => {
  it('serves a value for ttlMs and loads again after that', async () => {
    const c = clock();
    const memo = new ShortMemo<number>({ ttlMs: 1000, now: c.now });
    let loads = 0;
    const load = () => Promise.resolve(++loads);
    expect(await memo.get(load)).toBe(1);
    c.advance(999);
    expect(await memo.get(load)).toBe(1);
    c.advance(1);
    expect(await memo.get(load)).toBe(2);
    expect(loads).toBe(2);
  });

  it('loads again when the clock was stepped back, instead of trusting the value for the whole step', async () => {
    const c = clock();
    const memo = new ShortMemo<number>({ ttlMs: 1000, now: c.now });
    let loads = 0;
    const load = () => Promise.resolve(++loads);
    c.advance(10_000);
    expect(await memo.get(load)).toBe(1);
    c.advance(-5_000);
    expect(await memo.get(load)).toBe(2);
  });

  it('shares one load between concurrent callers', async () => {
    const memo = new ShortMemo<string>({ ttlMs: 1000 });
    let loads = 0;
    let release: (value: string) => void = () => undefined;
    const load = () => {
      loads++;
      return new Promise<string>((resolve) => (release = resolve));
    };
    const a = memo.get(load);
    const b = memo.get(load);
    release('rules');
    expect(await Promise.all([a, b])).toEqual(['rules', 'rules']);
    expect(loads).toBe(1);
  });

  it('serves the last good value when a reload fails, and says so', async () => {
    const c = clock();
    const seen: unknown[] = [];
    const memo = new ShortMemo<string>({ ttlMs: 1000, now: c.now, onStale: (error) => seen.push(error) });
    expect(await memo.get(() => Promise.resolve('good'))).toBe('good');
    c.advance(5000);
    const failure = new Error('database down');
    expect(await memo.get(() => Promise.reject(failure))).toBe('good');
    expect(seen).toEqual([failure]);
  });

  it('throws when the first load fails (nothing to fall back on), and recovers on the next call', async () => {
    const memo = new ShortMemo<string>({ ttlMs: 1000 });
    await expectRejection(
      memo.get(() => Promise.reject(new Error('cold failure'))),
      'cold failure',
    );
    expect(await memo.get(() => Promise.resolve('ok'))).toBe('ok');
  });

  it('forgets everything on clear(): the next call loads, and a failure then throws instead of serving old data', async () => {
    const memo = new ShortMemo<string>({ ttlMs: 60_000 });
    expect(await memo.get(() => Promise.resolve('old'))).toBe('old');
    memo.clear();
    await expectRejection(
      memo.get(() => Promise.reject(new Error('down'))),
      'down',
    );
    expect(await memo.get(() => Promise.resolve('new'))).toBe('new');
  });

  it('does not store the result of a load that was running when clear() was called', async () => {
    const memo = new ShortMemo<string>({ ttlMs: 60_000 });
    let release: (value: string) => void = () => undefined;
    const slow = memo.get(() => new Promise<string>((resolve) => (release = resolve)));
    memo.clear();
    release('stale answer');
    // The caller that started the load still gets what it asked for, but the memo does not keep it.
    expect(await slow).toBe('stale answer');
    expect(await memo.get(() => Promise.resolve('fresh'))).toBe('fresh');
  });
});
