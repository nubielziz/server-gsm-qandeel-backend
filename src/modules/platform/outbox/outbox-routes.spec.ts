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

  it('refuses the same type on the same queue twice and a queue that does not exist', () => {
    const registry = new OutboxRouteRegistry();
    registry.register({ type: 'order.status_changed', queue: 'merchant-webhooks' });
    expect(() => registry.register({ type: 'order.status_changed', queue: 'merchant-webhooks', jobName: 'x' })).toThrow(
      /already registered for the queue "merchant-webhooks"/,
    );
    expect(() => registry.register({ type: 'a.b', queue: 'no-such-queue' as never })).toThrow(/unknown queue/);
  });

  it('lets one type route to several queues, one route per queue, in registration order', () => {
    const registry = new OutboxRouteRegistry();
    registry.register({ type: 'order.status_changed', queue: 'merchant-webhooks' });
    registry.register({ type: 'order.status_changed', queue: 'notifications', jobName: 'notification.plan' });
    registry.register({ type: 'wallet.low_balance', queue: 'merchant-webhooks' });
    expect(registry.routesOf('order.status_changed')).toEqual([
      { type: 'order.status_changed', queue: 'merchant-webhooks' },
      { type: 'order.status_changed', queue: 'notifications', jobName: 'notification.plan' },
    ]);
    // `get` keeps answering the first route, so a caller that only asks "is it registered" works as before.
    expect(registry.get('order.status_changed')?.queue).toBe('merchant-webhooks');
    expect(registry.routesOf('nope.nope')).toEqual([]);
    expect(registry.list().map((route) => `${route.type}>${route.queue}`)).toEqual([
      'order.status_changed>merchant-webhooks',
      'order.status_changed>notifications',
      'wallet.low_balance>merchant-webhooks',
    ]);
  });
});
