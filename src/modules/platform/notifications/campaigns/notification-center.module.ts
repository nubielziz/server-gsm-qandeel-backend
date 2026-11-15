// The routes of the notification center (feature 23): the 12 campaign routes and the 12 inbox routes of the three surfaces, with their use
// cases, and the inbox source of the live streams (feature 27). Imported by `NotificationAdminModule`, so a test app built without a
// database leaves it out with its parent.
import { Module } from '@nestjs/common';
import { CustomerInboxController } from '../inbox/customer-inbox.controller';
import { InboxRealtimeSource } from '../inbox/inbox-realtime.source';
import { InboxService } from '../inbox/inbox.service';
import { MerchantInboxController } from '../inbox/merchant-inbox.controller';
import { StaffInboxController } from '../inbox/staff-inbox.controller';
import { NotificationDeliveryModule } from '../notification-delivery.module';
import { NotificationTransportModule } from '../notification-transport.module';
import { AudiencePreviewService } from './audience-preview.service';
import { CampaignAdminService } from './campaign-admin.service';
import { CampaignSendService } from './campaign-send.service';
import { CampaignsController } from './campaigns.controller';

/**
 * Provides the campaign routes and the inbox routes.
 *
 * Why: owner list E: staff create, preview, test, schedule, send and follow broadcasts, and staff, merchants and customers read their own
 * notifications. The use cases need the notification service
 * and the in-app writer (the test send) from the delivery module and the mail transport (the preview names the sender). The inbox source
 * renders the inbox for the live streams (decision 037); it lives beside the inbox controllers, in the API only.
 */
@Module({
  imports: [NotificationTransportModule, NotificationDeliveryModule],
  controllers: [CampaignsController, StaffInboxController, MerchantInboxController, CustomerInboxController],
  providers: [CampaignAdminService, CampaignSendService, AudiencePreviewService, InboxService, InboxRealtimeSource],
})
export class NotificationCenterModule {}
