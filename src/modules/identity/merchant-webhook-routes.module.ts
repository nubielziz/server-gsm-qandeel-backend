// The merchant portal's webhook routes (/client/webhooks*, stage 7), served from the identity module. Separate so a test app built without a
// database can leave it out.
import { Module } from '@nestjs/common';
import { MerchantWebhooksModule } from '../platform';
import { MachineCredentialHold } from './application/machine-credential-hold';
import { MerchantWebhooksController } from './controllers/merchant-webhooks.controller';

/**
 * Provides the controller of `/client/webhooks*`.
 *
 * Why: the use cases are the platform's (`MerchantWebhookService`, from `MerchantWebhooksModule`); only the controller needs identity's
 * request decorators, so it is the one piece of the webhook routes that lives here (decision 032), with the identity check that a new or
 * changed endpoint needs (`MachineCredentialHold`: it reads `clients`, which the platform module does not touch).
 */
@Module({
  imports: [MerchantWebhooksModule],
  controllers: [MerchantWebhooksController],
  providers: [MachineCredentialHold],
})
export class MerchantWebhookRoutesModule {}
