// The merchant webhook use cases and the staff's delivery log of the platform module (stage 7): `/admin/webhook-deliveries*` and the
// service behind identity's `/client/webhooks*` controller. Separate so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { MerchantWebhookService } from './merchant-webhook.service';
import { WebhookDeliveryAdminService } from './webhook-delivery-admin.service';
import { WebhookDeliveryModule } from './webhook-delivery.module';
import { WebhookDeliveriesController } from './webhook-deliveries.controller';

/**
 * Provides `/admin/webhook-deliveries*` and exports `MerchantWebhookService` for identity's `/client/webhooks*` controller.
 *
 * Why: the routes need the global database, crypto, audit, rate-limit and clock providers and the delivery engine.
 */
@Module({
  imports: [WebhookDeliveryModule],
  controllers: [WebhookDeliveriesController],
  providers: [MerchantWebhookService, WebhookDeliveryAdminService],
  exports: [MerchantWebhookService],
})
export class MerchantWebhooksModule {}
