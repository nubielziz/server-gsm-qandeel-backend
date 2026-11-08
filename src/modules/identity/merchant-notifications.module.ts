// The merchant portal's notification settings and Telegram's update webhook (routes /client/notification-preferences, /client/telegram/link and
// /webhooks/telegram/:secret, stage 12). Separate so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { NotificationDeliveryModule } from '../platform';
import { MerchantNotificationSettings } from './application/merchant-notification-settings.service';
import { TelegramLinking } from './application/telegram-linking.service';
import { TelegramWebhookSecret } from './application/telegram-webhook-secret';
import { MerchantNotificationsController } from './controllers/merchant-notifications.controller';

/**
 * Provides the four routes of B165.
 *
 * Why: the use cases need the global database, crypto and clock providers and the platform's notification service (which writes the answer the bot
 * sends); the module is exported to the rest of the app only through `index.ts`.
 */
@Module({
  imports: [NotificationDeliveryModule],
  controllers: [MerchantNotificationsController],
  providers: [MerchantNotificationSettings, TelegramLinking, TelegramWebhookSecret],
})
export class MerchantNotificationsModule {}
