// Unit tests of the source registry (decision 037): topics and cursor letters are unique, `session` is the hub's own.
import { describe, expect, it } from 'bun:test';
import { RealtimeSources } from '@src/infra/realtime/realtime-sources';
import type { RealtimeSource } from '@src/infra/realtime/realtime.types';

const source = (topic: string, cursorKey: string): RealtimeSource => ({
  topic,
  cursorKey,
  keysFor: () => [],
  head: () => Promise.resolve(0),
  replay: () => Promise.resolve([]),
  snapshot: () => Promise.resolve([]),
  resolve: () => Promise.resolve([]),
});

describe('RealtimeSources', () => {
  it('keeps sources in registration order and finds them by topic', () => {
    const sources = new RealtimeSources();
    const inbox = source('inbox', 'i');
    const ticket = source('ticket', 't');
    sources.register(inbox);
    sources.register(ticket);
    expect(sources.all()).toEqual([inbox, ticket]);
    expect(sources.get('ticket')).toBe(ticket);
    expect(sources.get('orders')).toBeUndefined();
  });

  it('refuses the reserved topic, a malformed topic or letter, and anything taken', () => {
    const sources = new RealtimeSources();
    sources.register(source('inbox', 'i'));
    expect(() => sources.register(source('session', 's'))).toThrow('cannot be a real-time topic');
    expect(() => sources.register(source('Bad Topic', 'b'))).toThrow('cannot be a real-time topic');
    expect(() => sources.register(source('ticket', 'tt'))).toThrow('one lower-case letter');
    expect(() => sources.register(source('ticket', 'T'))).toThrow('one lower-case letter');
    expect(() => sources.register(source('inbox', 'x'))).toThrow('registered twice');
    expect(() => sources.register(source('ticket', 'i'))).toThrow('is taken');
  });
});
