// Unit tests of the notification outbox routes (feature 12a, merged with feature 8): which events reach the `notifications` queue.
import { describe, expect, it } from 'bun:test';
import { OutboxRouteRegistry } from '@src/modules/platform/outbox/outbox-routes';
import { NotificationRoutes } from '@src/modules/platform/notifications/notification-routes';

describe('NotificationRoutes', () => {
  it("plans a notification for feature 8's invoice.paid as its only route, and nothing for the retired deposit.approved", () => {
    const registry = new OutboxRouteRegistry();
    new NotificationRoutes(registry).onModuleInit();
    expect(registry.routesOf('invoice.paid').map((route) => [route.queue, route.jobName])).toEqual([
      ['notifications', 'notification.plan'],
    ]);
    // The deposit event is retired: nothing routes it.
    expect(registry.routesOf('deposit.approved')).toEqual([]);
    expect(
      registry
        .list()
        .filter((route) => route.queue === 'notifications')
        .map((route) => route.type)
        .sort(),
    ).toEqual([
      'invoice.paid',
      'notification.campaign_fanout',
      'notification.send',
      'order.status_changed',
      'service.price_changed',
      'wallet.low_balance',
    ]);
  });

  it('gives each merchant event one route only, to the notifications queue (the webhooks that were a second route are retired)', () => {
    const registry = new OutboxRouteRegistry();
    new NotificationRoutes(registry).onModuleInit();
    for (const type of ['order.status_changed', 'wallet.low_balance', 'service.price_changed', 'invoice.paid'])
      expect(
        registry.routesOf(type).map((route) => route.queue),
        type,
      ).toEqual(['notifications']);
    // The notice of a switched-off webhook endpoint went with the endpoints.
    expect(registry.routesOf('webhook.endpoint_disabled')).toEqual([]);
  });
});
