// Unit tests of the notification outbox routes (feature 12a, merged with feature 8): which events reach the `notifications` queue.
import { describe, expect, it } from 'bun:test';
import { OutboxRouteRegistry } from '../outbox/outbox-routes';
import { NotificationRoutes } from './notification-routes';

describe('NotificationRoutes', () => {
  it("plans a notification for feature 8's invoice.paid next to its merchant webhook, and nothing for deposit.approved", () => {
    const registry = new OutboxRouteRegistry();
    // What the money module registers for its own event (InvoiceOutbox).
    registry.register({ type: 'invoice.paid', queue: 'merchant-webhooks' });
    new NotificationRoutes(registry).onModuleInit();
    expect(registry.routesOf('invoice.paid').map((route) => [route.queue, route.jobName])).toEqual([
      ['merchant-webhooks', undefined],
      ['notifications', 'notification.plan'],
    ]);
    // Every credited top-up already writes invoice.paid: a second event would tell the merchant twice.
    expect(registry.routesOf('deposit.approved')).toEqual([]);
    expect(
      registry
        .list()
        .filter((route) => route.queue === 'notifications')
        .map((route) => route.type)
        .sort(),
    ).toEqual([
      'invoice.paid',
      'notification.send',
      'order.status_changed',
      'service.price_changed',
      'wallet.low_balance',
    ]);
  });
});
