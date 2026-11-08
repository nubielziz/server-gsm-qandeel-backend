// The part of the support module that needs neither the database nor Redis: it registers the support notification events and the outbox route
// of the ticket messages. Loaded by the API (the use cases write the events) and by the worker (the delivery and the relay need the same lists).
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { NotificationEventRegistry } from '../platform';
import { SUPPORT_EVENTS } from './application/support-events';
import { TicketMailRoutes } from './application/ticket-mail-outbox';

/**
 * Registers {@link SUPPORT_EVENTS} with the platform's event registry.
 *
 * Why: `NotificationDelivery` looks the event of a row up in the registry of its own process, so the worker must know the support events
 * too: this module is imported by `SupportModule` (API) and by the worker's root module.
 *
 * Side effects: adds three events to the registry at boot.
 */
@Injectable()
export class SupportEventRegistration implements OnModuleInit {
  constructor(private readonly registry: NotificationEventRegistry) {}

  /** Adds the events. */
  onModuleInit(): void {
    for (const definition of SUPPORT_EVENTS) this.registry.register(definition);
  }
}

/** Provides {@link SupportEventRegistration} and {@link TicketMailRoutes}. */
@Module({ providers: [SupportEventRegistration, TicketMailRoutes] })
export class SupportEventsModule {}
