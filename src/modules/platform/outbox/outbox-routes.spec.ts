// Unit tests of the outbox route registry (decision 020): modules register an event type with its queue; mistakes are
// found at boot.
import { describe, expect, it } from 'bun:test';
import { OutboxRouteRegistry } from './outbox-routes';

describe('OutboxRouteRegistry', () => {
  it('returns the route of a registered type and nothing for an unknown one', () => {
    const registry = new OutboxRouteRegistry();
    registry.register({ type: 'order.status_changed', queue: 'merchant-webhooks' });
    registry.register({ type: 'wallet.low_balance', queue: 'notifications', jobName: 'low_balance' });
    expect(registry.get('order.status_changed')).toEqual({ type: 'order.status_changed', queue: 'merchant-webhooks' });
    expect(registry.get('wallet.low_balance')?.jobName).toBe('low_balance');
    expect(registry.get('nope.nope')).toBeUndefined();
    expect(registry.list().map((route) => route.type)).toEqual(['order.status_changed', 'wallet.low_balance']);
  });

  it('refuses a type registered twice and a queue that does not exist', () => {
    const registry = new OutboxRouteRegistry();
    registry.register({ type: 'order.status_changed', queue: 'merchant-webhooks' });
    expect(() => registry.register({ type: 'order.status_changed', queue: 'notifications' })).toThrow(
      /already registered/,
    );
    expect(() => registry.register({ type: 'a.b', queue: 'no-such-queue' as never })).toThrow(/unknown queue/);
  });
});
