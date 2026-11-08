// The staff's routes of the notifications (stage 12): `/admin/notification-templates*` and `/admin/notifications*`. Separate so a test app
// built without a database can leave it out.
import { Module } from '@nestjs/common';
import { NotificationLogAdminService } from './notification-log-admin.service';
import { NotificationTemplateAdminService } from './notification-template-admin.service';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationTransportModule } from './notification-transport.module';
import { NotificationsController } from './notifications.controller';

/**
 * Provides the 8 admin routes of feature 12a (6 for the templates, 2 for the log).
 *
 * Why: the routes need the global database, audit, clock and configuration providers and the mail transport (the preview names the sender);
 * the module is exported to the rest of the app only through `index.ts`.
 */
@Module({
  imports: [NotificationTransportModule],
  controllers: [NotificationTemplatesController, NotificationsController],
  providers: [NotificationTemplateAdminService, NotificationLogAdminService],
})
export class NotificationAdminModule {}
