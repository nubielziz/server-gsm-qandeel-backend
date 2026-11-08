// The worker processors of the customer mails (customers module, queue notifications): one per outbox event type, all delegating
// to CustomerMailJobs. Classes are separate because @QueueProcessor names one job per class and the queue is shared with
// feature 12a, so no catch-all processor may exist on it.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { type CustomerMailJobResult, CustomerMailJobs } from '../application/mail/customer-mail-jobs';
import { CUSTOMER_MAIL_EVENTS } from '../application/mail/customer-mail-outbox';

/**
 * Sends the sign-in link a customer asked for.
 *
 * Why: `POST /store/v1/auth/magic-link` writes `customer.magic_link`; this job rotates the link and sends the mail.
 */
@Injectable()
@QueueProcessor('notifications', CUSTOMER_MAIL_EVENTS.magic_link)
export class MagicLinkMailProcessor implements JobProcessor<OutboxJobData, CustomerMailJobResult> {
  constructor(private readonly jobs: CustomerMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, CustomerMailJobResult, string>): Promise<CustomerMailJobResult> {
    return this.jobs.handle('magic_link', job);
  }
}

/**
 * Sends the password-reset link (the customer's request or a staff member's).
 *
 * Why: `POST /store/v1/auth/password/forgot` and `POST /admin/customers/:id/password` write `customer.password_reset`.
 */
@Injectable()
@QueueProcessor('notifications', CUSTOMER_MAIL_EVENTS.password_reset)
export class CustomerPasswordResetMailProcessor implements JobProcessor<OutboxJobData, CustomerMailJobResult> {
  constructor(private readonly jobs: CustomerMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, CustomerMailJobResult, string>): Promise<CustomerMailJobResult> {
    return this.jobs.handle('password_reset', job);
  }
}

/**
 * Sends the invitation of an account that staff created.
 *
 * Why: `POST /admin/customers` and `POST /admin/customers/:id/account` in `reset_link` mode write `customer.invited`.
 */
@Injectable()
@QueueProcessor('notifications', CUSTOMER_MAIL_EVENTS.invited)
export class CustomerInvitedMailProcessor implements JobProcessor<OutboxJobData, CustomerMailJobResult> {
  constructor(private readonly jobs: CustomerMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, CustomerMailJobResult, string>): Promise<CustomerMailJobResult> {
    return this.jobs.handle('invited', job);
  }
}

/**
 * Sends the verification link after an account's email changed.
 *
 * Why: `PATCH /admin/customers/:id` with a new email on an account writes `customer.email_verification` (b2c-16).
 */
@Injectable()
@QueueProcessor('notifications', CUSTOMER_MAIL_EVENTS.email_verification)
export class CustomerEmailVerificationMailProcessor implements JobProcessor<OutboxJobData, CustomerMailJobResult> {
  constructor(private readonly jobs: CustomerMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, CustomerMailJobResult, string>): Promise<CustomerMailJobResult> {
    return this.jobs.handle('email_verification', job);
  }
}
