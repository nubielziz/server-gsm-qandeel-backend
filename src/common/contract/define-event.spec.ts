// Unit tests for defineEvent (decisions 008, 017): key rules, example validation, the registries.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { EventRegistry, defineEvent, eventRegistry, type EventKey } from './define-event';
import { zId } from './zod';

const Payload = z.object({ orderId: zId, status: z.string() });
const spec = (override: Record<string, unknown> = {}) => ({
  key: 'EVENT order.status_changed' as EventKey,
  summary: 'An order changed status',
  payload: Payload,
  ...override,
});

describe('defineEvent', () => {
  it('returns a frozen contract with the event name taken from the key, and registers it', () => {
    const registry = new EventRegistry();
    const event = defineEvent(spec({ example: { orderId: 7, status: 'completed' } }), registry);
    expect(event.name).toBe('order.status_changed');
    expect(event.key).toBe('EVENT order.status_changed');
    expect(event.example).toEqual({ orderId: 7, status: 'completed' });
    expect(Object.isFrozen(event)).toBe(true);
    expect(registry.get('EVENT order.status_changed')).toBe(event);
    expect(registry.keys()).toEqual(['EVENT order.status_changed']);
    expect(registry.all()).toEqual([event]);
  });

  it('accepts dotted names with several parts and underscores', () => {
    const registry = new EventRegistry();
    expect(defineEvent(spec({ key: 'EVENT wallet.low_balance' }), registry).name).toBe('wallet.low_balance');
    expect(defineEvent(spec({ key: 'EVENT order.item.shipped' }), registry).name).toBe('order.item.shipped');
  });

  it('rejects malformed keys', () => {
    for (const key of [
      'order.status_changed',
      'EVENT',
      'EVENT order',
      'EVENT Order.Status',
      'EVENT order..x',
      'POST /x',
    ]) {
      expect(() => defineEvent(spec({ key }), new EventRegistry()), key).toThrow(/key must look like/);
    }
  });

  it('rejects an empty or very long summary', () => {
    expect(() => defineEvent(spec({ summary: ' ' }), new EventRegistry())).toThrow(/summary/);
    expect(() => defineEvent(spec({ summary: 'x'.repeat(121) }), new EventRegistry())).toThrow(/summary/);
  });

  it('rejects an example that does not satisfy the payload schema', () => {
    expect(() => defineEvent(spec({ example: { orderId: 'seven' } }), new EventRegistry())).toThrow(/example/);
  });

  it('refuses a key defined twice in the same registry, and accepts it in another', () => {
    const registry = new EventRegistry();
    defineEvent(spec(), registry);
    expect(() => defineEvent(spec(), registry)).toThrow(/defined twice/);
    expect(() => defineEvent(spec(), new EventRegistry())).not.toThrow();
  });

  it('uses the process-wide registry by default', () => {
    const before = eventRegistry.all();
    try {
      const event = defineEvent(spec({ key: 'EVENT spec.default_registry' }));
      expect(eventRegistry.has('EVENT spec.default_registry')).toBe(true);
      expect(eventRegistry.get('EVENT spec.default_registry')).toBe(event);
      expect(eventRegistry.all()).toHaveLength(before.length + 1);
    } finally {
      // The registry is process-wide: leave it as it was found.
      eventRegistry.clear();
      for (const event of before) eventRegistry.register(event);
    }
  });

  it('clear() empties a registry', () => {
    const local = new EventRegistry();
    defineEvent(spec(), local);
    local.clear();
    expect(local.all()).toEqual([]);
    expect(local.has('EVENT order.status_changed')).toBe(false);
  });
});
