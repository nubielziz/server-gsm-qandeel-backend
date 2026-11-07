// The part of the merchant webhooks that needs neither the database nor Redis: the outbox routes of the events 7b owns and the
// four event contracts. Loaded by the API (it writes the events) and by the worker (its relay needs the same registry).
import { Module } from '@nestjs/common';
import { MerchantEventRoutes } from './merchant-event-routes';
import './webhook-events';

/**
 * Registers `wallet.low_balance` and `service.price_changed` with the `merchant-webhooks` queue and defines the event contracts.
 *
 * Why: `OutboxService.add` refuses an event type with no route, in the API; the relay refuses it in the worker. The module has no
 * dependency on the database, so it stays loaded in an app built without one. Importing `./webhook-events` registers the four
 * event contracts of the public OpenAPI document (decision 017).
 */
@Module({ providers: [MerchantEventRoutes] })
export class WebhookEventsModule {}
