// The worker processors of the staff mails (identity module, queue notifications): one per outbox event type, both delegating to
// StaffMailJobs. Separate classes because @QueueProcessor names one job per class and the queue is shared (no catch-all processor).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { type StaffMailJobResult, StaffMailJobs } from '../application/mail/staff-mail-jobs';
import { STAFF_MAIL_EVENTS } from '../application/mail/staff-mail-outbox';

/**
 * Sends the invitation mail of a staff member an owner added.
 *
 * Why: `POST /admin/staff` with `onboarding: 'invite'` writes `staff.invited` (feature 20, slice C).
 */
@Injectable()
@QueueProcessor('notifications', STAFF_MAIL_EVENTS.invited)
export class StaffInvitedMailProcessor implements JobProcessor<OutboxJobData, StaffMailJobResult> {
  constructor(private readonly jobs: StaffMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was handed over
   */
  process(job: Job<OutboxJobData, StaffMailJobResult, string>): Promise<StaffMailJobResult> {
    return this.jobs.handle('invited', job);
  }
}

/**
 * Sends the link to choose a new password to a staff member.
 *
 * Why: `POST /admin/staff/:id/password` in `reset_link` mode writes `staff.password_reset` (or `staff.invited` while the member has not
 * accepted the invitation yet).
 */
@Injectable()
@QueueProcessor('notifications', STAFF_MAIL_EVENTS.password_reset)
export class StaffPasswordResetMailProcessor implements JobProcessor<OutboxJobData, StaffMailJobResult> {
  constructor(private readonly jobs: StaffMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was handed over
   */
  process(job: Job<OutboxJobData, StaffMailJobResult, string>): Promise<StaffMailJobResult> {
    return this.jobs.handle('password_reset', job);
  }
}
