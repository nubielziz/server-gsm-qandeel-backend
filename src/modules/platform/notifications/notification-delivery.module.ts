// The delivery engine of the notifications: the planning of events, the sender and the worker processors of the `notifications` queue that
// belong to feature 12a. Loaded by the API (use cases enqueue notifications) and by the worker (which runs the jobs). It needs the database
// and the queue Redis, so a test app built without them leaves it out.
import { Module } from '@nestjs/common';
import { EventNotifier } from './event-notifier';
import { NotificationDelivery } from './notification-delivery';
import { NotificationPlanProcessor, NotificationSendProcessor } from './notification.processors';
import { NotificationService } from './notification.service';
import { NotificationTransportModule } from './notification-transport.module';

/**
 * Provides {@link NotificationService} and the processors of `notification.plan` and `notification.send`.
 *
 * Why: decision 020: the worker turns each event into notifications and sends them. Only the worker starts a BullMQ worker for the
 * processors; the API loads the classes and never runs them (like the webhook delivery module).
 */
@Module({
  imports: [NotificationTransportModule],
  providers: [
    NotificationDelivery,
    NotificationService,
    EventNotifier,
    NotificationPlanProcessor,
    NotificationSendProcessor,
  ],
  exports: [NotificationService, NotificationDelivery],
})
export class NotificationDeliveryModule {}
