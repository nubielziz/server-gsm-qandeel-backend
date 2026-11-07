// The worker processors of the merchant mails (identity module, queue notifications): one per outbox event type, all
// delegating to MerchantMailJobs. Classes are separate because @QueueProcessor names one job per class and the queue is
// shared with feature 12a, so no catch-all processor may exist on it.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { MERCHANT_MAIL_EVENTS } from '../application/mail/merchant-mail-outbox';
import { type MerchantMailJobResult, MerchantMailJobs } from '../application/mail/merchant-mail-jobs';

/**
 * Sends the email-verification mail of a new merchant.
 *
 * Why: `POST /client/auth/register` (B122) writes `merchant.email_verification`; this job hands it to the mail sender.
 */
@Injectable()
@QueueProcessor('notifications', MERCHANT_MAIL_EVENTS.email_verification)
export class EmailVerificationMailProcessor implements JobProcessor<OutboxJobData, MerchantMailJobResult> {
  constructor(private readonly jobs: MerchantMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was handed over
   */
  process(job: Job<OutboxJobData, MerchantMailJobResult, string>): Promise<MerchantMailJobResult> {
    return this.jobs.handle('email_verification', job);
  }
}

/**
 * Sends the password-reset mail.
 *
 * Why: `POST /client/auth/password/forgot` (B127) writes `merchant.password_reset`.
 */
@Injectable()
@QueueProcessor('notifications', MERCHANT_MAIL_EVENTS.password_reset)
export class PasswordResetMailProcessor implements JobProcessor<OutboxJobData, MerchantMailJobResult> {
  constructor(private readonly jobs: MerchantMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was handed over
   */
  process(job: Job<OutboxJobData, MerchantMailJobResult, string>): Promise<MerchantMailJobResult> {
    return this.jobs.handle('password_reset', job);
  }
}

/**
 * Sends the invitation mail of a merchant that staff created.
 *
 * Why: `POST /admin/clients` (feature 2a, identity-platform-2) writes `merchant.invited`.
 */
@Injectable()
@QueueProcessor('notifications', MERCHANT_MAIL_EVENTS.invited)
export class MerchantInvitedMailProcessor implements JobProcessor<OutboxJobData, MerchantMailJobResult> {
  constructor(private readonly jobs: MerchantMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was handed over
   */
  process(job: Job<OutboxJobData, MerchantMailJobResult, string>): Promise<MerchantMailJobResult> {
    return this.jobs.handle('invited', job);
  }
}
