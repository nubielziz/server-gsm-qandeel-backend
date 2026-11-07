// The delivery engine of the merchant webhooks: the sender, the fan-out of merchant events and the worker processor of the
// `merchant-webhooks` queue. Loaded by the API (the portal's test and the staff's retry queue deliveries) and by the worker (which
// runs the jobs). It needs the database and Redis, so a test app built without them leaves it out.
import { Module } from '@nestjs/common';
import { MerchantWebhooksProcessor } from './merchant-webhooks.processor';
import { WebhookDeliveries } from './webhook-deliveries';
import { WebhookEventsModule } from './webhook-events.module';
import { WebhookFanOut } from './webhook-fan-out';

/**
 * Provides {@link WebhookDeliveries}, {@link WebhookFanOut} and the queue's processor.
 *
 * Why: decision 020: the worker turns each merchant event into deliveries and sends them. Only the worker starts a BullMQ worker
 * for the processor; the API loads the class and never runs it.
 */
@Module({
  imports: [WebhookEventsModule],
  providers: [WebhookDeliveries, WebhookFanOut, MerchantWebhooksProcessor],
  exports: [WebhookDeliveries],
})
export class WebhookDeliveryModule {}
