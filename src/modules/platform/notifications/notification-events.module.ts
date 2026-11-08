// The part of the notifications that needs neither the database nor Redis: the event registry and the outbox routes of the events a
// notification is made from. Loaded by the API (it writes the events) and by the worker (its relay needs the same registry).
import { Global, Module } from '@nestjs/common';
import { NotificationEventRegistry } from './notification-events';
import { NotificationRoutes } from './notification-routes';

/**
 * Provides {@link NotificationEventRegistry} and registers the `notifications` routes of the outbox.
 *
 * Why: `OutboxService.add` refuses an event type with no route in the API, and the relay refuses it in the worker, so both load this
 * module; the registry is global because the template routes, the portal's preferences and the planning job all read the same list.
 */
@Global()
@Module({ providers: [NotificationEventRegistry, NotificationRoutes], exports: [NotificationEventRegistry] })
export class NotificationEventsModule {}
