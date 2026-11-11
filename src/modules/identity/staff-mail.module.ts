// The staff mails of the identity module (feature 20, slice C): the outbox event types, their `notifications` queue routes and the worker
// processors. Loaded by the API (it writes the events) and by the worker (src/worker.module.ts: it handles them).
import { Module } from '@nestjs/common';
import { NotificationDeliveryModule } from '../platform';
import { StaffMailJobs } from './application/mail/staff-mail-jobs';
import { StaffMailOutbox } from './application/mail/staff-mail-outbox';
import { IdentityMailEventsModule } from './identity-mail-events.module';
import { StaffInvitedMailProcessor, StaffPasswordResetMailProcessor } from './jobs/staff-mail.processors';

/**
 * Provides the staff mail events, their processors and the job that rotates a link and sends it.
 *
 * Why: LEAD-DECISIONS section 6 and brief 20 (O-8): the invitation and the reset link reach the staff member by email. The API and the
 * worker must both register the event types and the notification events (the worker's relay only knows the routes registered in its
 * own process), so both load this module; only the worker turns the processors into BullMQ workers.
 */
@Module({
  imports: [NotificationDeliveryModule, IdentityMailEventsModule],
  providers: [StaffMailOutbox, StaffMailJobs, StaffInvitedMailProcessor, StaffPasswordResetMailProcessor],
  exports: [StaffMailOutbox],
})
export class StaffMailModule {}
