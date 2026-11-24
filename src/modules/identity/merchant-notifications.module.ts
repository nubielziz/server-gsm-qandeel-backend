// The merchant portal's notification settings (routes /client/notification-preferences, stage 12). Separate so a test app built without a
// database can leave it out.
import { Module } from '@nestjs/common';
import { MerchantNotificationSettings } from './application/merchant-notification-settings.service';
import { MerchantNotificationsController } from './controllers/merchant-notifications.controller';

/**
 * Provides the two routes of B165.
 *
 * Why: the use cases need the global database, clock and event-registry providers; the module is exported to the rest of the app only
 * through `index.ts`.
 */
@Module({
  controllers: [MerchantNotificationsController],
  providers: [MerchantNotificationSettings],
})
export class MerchantNotificationsModule {}
