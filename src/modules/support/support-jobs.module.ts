// The scheduled jobs of the support chat (feature 28): the email fallback every minute and the nightly attachment retention. Import it in
// the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../infra/queues';
import { JobRunsModule } from '../health';
import { AuditService, SettingsModule, StoredFiles } from '../platform';
import { ReplyMailSweep } from './application/reply-mail-sweep';
import { TicketAttachmentService } from './application/ticket-attachment.service';
import { TicketEvents } from './application/ticket-events';
import { TicketMailOutbox } from './application/ticket-mail-outbox';
import { AttachmentRetentionProcessor, TICKET_ATTACHMENT_RETENTION_JOB } from './jobs/attachment-retention.processor';
import { ReplyMailSweepProcessor, SUPPORT_REPLY_MAIL_SWEEP_JOB } from './jobs/reply-mail-sweep.processor';

/**
 * The id of the scheduler that ticks the email fallback every minute.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const SUPPORT_REPLY_MAIL_SCHEDULER = 'support-reply-mail-sweep';

/** The id of the scheduler of the nightly attachment retention (03:30 UTC). */
export const TICKET_ATTACHMENT_RETENTION_SCHEDULER = 'ticket-attachment-retention';

/**
 * Provides the two jobs of the support chat and registers their schedules.
 *
 * Why: the API never mails or deletes in bulk (decision 020); the worker does. The schedules are BullMQ job schedulers, created on every
 * worker boot (idempotent). The sweep writes the `support.ticket_mail` events the worker's relay hands to `TicketMailJobs`.
 */
@Module({
  imports: [JobRunsModule, SettingsModule],
  providers: [
    // The audit writer is a plain service of the database: the worker has no global AuditModule, so the module provides its own.
    AuditService,
    StoredFiles,
    TicketEvents,
    TicketMailOutbox,
    TicketAttachmentService,
    ReplyMailSweep,
    ReplyMailSweepProcessor,
    AttachmentRetentionProcessor,
  ],
  exports: [ReplyMailSweep, TicketAttachmentService],
})
export class SupportJobsModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedules; the worker creates them in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: SUPPORT_REPLY_MAIL_SCHEDULER,
      queue: 'maintenance',
      jobName: SUPPORT_REPLY_MAIL_SWEEP_JOB,
      pattern: '* * * * *',
      description:
        'Mails the email replies of support tickets that the requester has not seen after support.replyEmailDelayMinutes, one mail per ticket.',
    });
    this.schedulers.register({
      id: TICKET_ATTACHMENT_RETENTION_SCHEDULER,
      queue: 'maintenance',
      jobName: TICKET_ATTACHMENT_RETENTION_JOB,
      pattern: '30 3 * * *',
      description: 'Deletes the attachments of tickets resolved longer ago than support.attachmentRetentionDays.',
    });
  }
}
