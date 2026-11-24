// Unit tests of the connection registry (decision 037): audience keys, sessions, caps and their release, heartbeat buckets with
// fake timers.
import { describe, expect, it } from 'bun:test';
import { ManualTimers } from '../../../support/clock';
import { ConnectionRegistry, type RegisteredStream, startBucketTicker } from '@src/infra/realtime/connection-registry';

const caps = (session: number, ip = '203.0.113.9') => [
  { key: `session:${session}`, max: 3 },
  { key: `ip:${ip}`, max: 4 },
];
const stream = (id: number, session: number | null, keys: string[], ip?: string): RegisteredStream => ({
  id,
  keys,
  caps: session === null ? [{ key: `ticket:${id}`, max: 3 }] : caps(session, ip),
  sessionId: session,
});

describe('ConnectionRegistry', () => {
  it('finds streams by audience key (each once) and by session', () => {
    const registry = new ConnectionRegistry(15);
    const a = stream(1, 91, ['u:account:42']);
    const b = stream(2, 91, ['u:account:42', 'support:staff']);
    const c = stream(3, 92, ['u:client:42']);
    for (const s of [a, b, c]) registry.add(s);
    expect(registry.size).toBe(3);
    expect(registry.has('u:account:42')).toBe(true);
    expect(registry.has('u:staff:42')).toBe(false);
    expect([...registry.withKeys(['u:account:42', 'support:staff'])]).toEqual([a, b]);
    expect(registry.ofSession(91)).toEqual([a, b]);
    expect(registry.ofSession(7)).toEqual([]);
  });

  it('refuses the newest stream over a cap and frees the place when one closes', () => {
    const registry = new ConnectionRegistry(15);
    const open = [1, 2, 3].map((id) => stream(id, 91, ['u:account:42']));
    for (const s of open) registry.add(s);
    expect(registry.capCount('session:91')).toBe(3);
    expect(registry.fullCap(caps(91))).toEqual({ key: 'session:91', max: 3 });
    expect(registry.fullCap(caps(92))).toBeUndefined();
    expect(registry.remove(open[0]!)).toBe(true);
    expect(registry.remove(open[0]!)).toBe(false);
    expect(registry.capCount('session:91')).toBe(2);
    expect(registry.fullCap(caps(91))).toBeUndefined();
  });

  it('counts the per-address cap across sessions', () => {
    const registry = new ConnectionRegistry(15);
    for (const id of [1, 2, 3]) registry.add(stream(id, 91, ['u:account:1']));
    registry.add(stream(4, 92, ['u:account:2']));
    expect(registry.capCount('ip:203.0.113.9')).toBe(4);
    expect(registry.fullCap(caps(93))).toEqual({ key: 'ip:203.0.113.9', max: 4 });
    expect(registry.fullCap(caps(93, '198.51.100.1'))).toBeUndefined();
  });

  it('drops empty indexes, so a key nobody listens to is unknown again', () => {
    const registry = new ConnectionRegistry(15);
    const s = stream(1, null, ['ticket:5']);
    registry.add(s);
    expect(registry.has('ticket:5')).toBe(true);
    registry.remove(s);
    expect(registry.has('ticket:5')).toBe(false);
    expect(registry.capCount('ticket:1')).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('refuses one id twice', () => {
    const registry = new ConnectionRegistry(15);
    registry.add(stream(1, 91, []));
    expect(() => registry.add(stream(1, 92, []))).toThrow('registered twice');
  });

  it('puts each stream in the bucket of its id', () => {
    const registry = new ConnectionRegistry(15);
    for (const id of [1, 16, 2, 30]) registry.add(stream(id, id, []));
    expect(registry.bucket(1).map((s) => s.id)).toEqual([1, 16]);
    expect(registry.bucket(2).map((s) => s.id)).toEqual([2]);
    expect(registry.bucket(0).map((s) => s.id)).toEqual([30]);
    expect(registry.bucketCount).toBe(15);
    expect(() => new ConnectionRegistry(0)).toThrow(RangeError);
  });
});

describe('startBucketTicker', () => {
  it('visits one bucket a second, round and round, until it is stopped', () => {
    const timers = new ManualTimers();
    const visited: number[] = [];
    const ticker = startBucketTicker(timers, 3, 1000, (index) => visited.push(index));
    timers.advance(999);
    expect(visited).toEqual([]);
    timers.advance(1);
    expect(visited).toEqual([0]);
    timers.advance(6000);
    expect(visited).toEqual([0, 1, 2, 0, 1, 2, 0]);
    ticker.stop();
    timers.advance(10_000);
    expect(visited).toHaveLength(7);
    expect(timers.pending).toBe(0);
  });

  it('keeps ticking after a bucket handler throws', () => {
    const timers = new ManualTimers();
    const visited: number[] = [];
    startBucketTicker(timers, 2, 1000, (index) => {
      visited.push(index);
      if (index === 0) throw new Error('boom');
    });
    expect(() => timers.advance(1000)).toThrow('boom');
    timers.advance(1000);
    expect(visited).toEqual([0, 1]);
  });
});
