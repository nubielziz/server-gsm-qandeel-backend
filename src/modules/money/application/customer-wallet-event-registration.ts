// Registers the customer wallet notification events (feature 21) with the platform's registry at boot, in the API and the worker (the support
// module's pattern, src/modules/support/support-events.module.ts).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { NotificationEventRegistry } from '../../platform';
import { CUSTOMER_WALLET_EVENTS } from './customer-wallet-notifications';

/**
 * Adds {@link CUSTOMER_WALLET_EVENTS} to the platform's event registry.
 *
 * Why: `NotificationDelivery` looks the event of a row up in the registry of its own process, so the worker must know the wallet events
 * too: `MoneyOutboxModule`, loaded by both processes, provides this.
 *
 * Side effects: adds five events to the registry at boot.
 */
@Injectable()
export class CustomerWalletEventRegistration implements OnModuleInit {
  constructor(private readonly registry: NotificationEventRegistry) {}

  /** Adds the events. */
  onModuleInit(): void {
    for (const definition of CUSTOMER_WALLET_EVENTS) this.registry.register(definition);
  }
}
