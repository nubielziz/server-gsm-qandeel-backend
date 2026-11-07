// The merchant portal's webhook routes (/client/webhooks*, stage 7), served from the identity module. Separate so a test app built without a
// database can leave it out.
import { Module } from '@nestjs/common';
import { MerchantWebhooksModule } from '../platform';
import { MerchantWebhooksController } from './controllers/merchant-webhooks.controller';

/**
 * Provides the controller of `/client/webhooks*`.
 *
 * Why: the use cases are the platform's (`MerchantWebhookService`, from `MerchantWebhooksModule`); only the controller needs identity's
 * request decorators, so it is the one piece of the webhook routes that lives here (decision 032).
 */
@Module({ imports: [MerchantWebhooksModule], controllers: [MerchantWebhooksController] })
export class MerchantWebhookRoutesModule {}
