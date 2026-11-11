// The part of the notifications that needs neither the database nor Redis: the event registry and the outbox routes of the events a
// notification is made from. Loaded by the API (it writes the events) and by the worker (its relay needs the same registry).
import { Global, Module } from '@nestjs/common';
import { BroadcastEvents } from './campaigns/broadcast-events';
import { NotificationAudiences } from './campaigns/notification-audiences';
import { NotificationPrivacy } from './campaigns/notification-privacy';
import { InboxTextRegistry } from './inbox/inbox-texts';
import { NotificationEventRegistry } from './notification-events';
import { NotificationRoutes } from './notification-routes';

/**
 * Provides {@link NotificationEventRegistry} and registers the `notifications` routes of the outbox; feature 23 adds the registries of the
 * notification center ({@link NotificationAudiences}, {@link InboxTextRegistry}) and its events ({@link BroadcastEvents}).
 *
 * Why: `OutboxService.add` refuses an event type with no route in the API, and the relay refuses it in the worker, so both load this
 * module; the registry is global because the template routes, the portal's preferences and the planning job all read the same list.
 * Identity and customers register their audience providers here at boot (platform imports no module, decision 032); {@link NotificationPrivacy}
 * is here for the same reason (it takes the caller's transaction, so it needs no database provider).
 */
@Global()
@Module({
  providers: [
    NotificationEventRegistry,
    NotificationRoutes,
    NotificationAudiences,
    InboxTextRegistry,
    BroadcastEvents,
    NotificationPrivacy,
  ],
  exports: [NotificationEventRegistry, NotificationAudiences, InboxTextRegistry, NotificationPrivacy],
})
export class NotificationEventsModule {}
