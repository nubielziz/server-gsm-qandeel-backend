// Registers the identity notification events of feature 20 (merchant lifecycle and staff link mails) in the API and in the worker.
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { NotificationEventRegistry } from '../platform';
import { IDENTITY_MAIL_EVENTS } from './application/mail/identity-mail-events';

/**
 * Registers {@link IDENTITY_MAIL_EVENTS} with the platform's event registry.
 *
 * Why: `NotificationDelivery` looks the event of a row up in the registry of its own process, so the worker must know these events
 * too. Nest builds a module once, so importing {@link IdentityMailEventsModule} from several modules registers the events once.
 *
 * Side effects: adds eight events to the registry at boot.
 */
@Injectable()
export class IdentityMailEventRegistration implements OnModuleInit {
  constructor(private readonly registry: NotificationEventRegistry) {}

  /** Adds the events. */
  onModuleInit(): void {
    for (const definition of IDENTITY_MAIL_EVENTS) this.registry.register(definition);
  }
}

/** Provides {@link IdentityMailEventRegistration}. */
@Module({ providers: [IdentityMailEventRegistration] })
export class IdentityMailEventsModule {}
