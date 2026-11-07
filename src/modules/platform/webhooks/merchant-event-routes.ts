// Registers the outbox routes of the merchant events this feature owns: `wallet.low_balance` and `service.price_changed`.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { OutboxRouteRegistry } from '../outbox/outbox-routes';

/** Outbox event type of the low-balance alert (written by the money module's posting hook). */
export const WALLET_LOW_BALANCE_EVENT = 'wallet.low_balance';
/** Outbox event type of a price change (written by the catalog's price change scan). */
export const SERVICE_PRICE_CHANGED_EVENT = 'service.price_changed';

/**
 * Registers the queue of the events 7b owns.
 *
 * Why: `OutboxService.add` refuses a type with no route, and the relay needs the same registry in the worker. The API and the
 * worker both load this class. Feature 5 registers `order.status_changed` and feature 8 registers `invoice.paid` itself (both to
 * `merchant-webhooks`, with `payload.clientId`): a type is registered once, so this class does not register them.
 *
 * Side effects: registers two types with the `merchant-webhooks` queue at boot.
 */
@Injectable()
export class MerchantEventRoutes implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the two event types. */
  onModuleInit(): void {
    this.routes.register({ type: WALLET_LOW_BALANCE_EVENT, queue: 'merchant-webhooks' });
    this.routes.register({ type: SERVICE_PRICE_CHANGED_EVENT, queue: 'merchant-webhooks' });
  }
}
