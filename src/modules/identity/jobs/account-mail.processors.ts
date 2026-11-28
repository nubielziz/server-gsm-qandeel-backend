// The worker processors of the account mails (identity module, queue notifications): one per outbox event type, all delegating to
// AccountMailJobs. Classes are separate because @QueueProcessor names one job per class and the queue is shared with other mails, so no
// catch-all processor may exist on it. The three merchant events and the six retail events (the four of decision 064 and the two mails of
// the shop's sign-up, decision 079) are all handled here.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { type AccountMailJobResult, AccountMailJobs } from '../application/mail/account-mail-jobs';
import { ACCOUNT_MAIL_EVENTS, SIGN_UP_MAIL_EVENTS } from '../domain/account-mail';

/**
 * Sends the email-verification mail of a merchant-rank account.
 *
 * Why: `POST /client/auth/verify-email/resend` and a staff change of the address write `merchant.email_verification`; this job hands it to the mail sender.
 */
@Injectable()
@QueueProcessor('notifications', ACCOUNT_MAIL_EVENTS.merchant.email_verification)
export class MerchantEmailVerificationMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(ACCOUNT_MAIL_EVENTS.merchant.email_verification, job);
  }
}

/**
 * Sends the password-reset mail of a merchant-rank account.
 *
 * Why: `POST /client/auth/password/forgot` and the staff reset link write `merchant.password_reset`.
 */
@Injectable()
@QueueProcessor('notifications', ACCOUNT_MAIL_EVENTS.merchant.password_reset)
export class MerchantPasswordResetMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(ACCOUNT_MAIL_EVENTS.merchant.password_reset, job);
  }
}

/**
 * Sends the invitation mail of a merchant-rank account that staff created.
 *
 * Why: `POST /admin/clients` (and a rank change of an account without a password) writes `merchant.invited`.
 */
@Injectable()
@QueueProcessor('notifications', ACCOUNT_MAIL_EVENTS.merchant.invited)
export class MerchantInvitedMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(ACCOUNT_MAIL_EVENTS.merchant.invited, job);
  }
}

/**
 * Sends the sign-in link a retail-rank account asked for.
 *
 * Why: `POST /store/v1/auth/magic-link` writes `customer.magic_link`; this job rotates the link and sends the mail.
 */
@Injectable()
@QueueProcessor('notifications', ACCOUNT_MAIL_EVENTS.retail.magic_link)
export class MagicLinkMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(ACCOUNT_MAIL_EVENTS.retail.magic_link, job);
  }
}

/**
 * Sends the password-reset link of a retail-rank account (its own request or a staff member's).
 *
 * Why: The forgot-password route and the staff reset write `customer.password_reset`.
 */
@Injectable()
@QueueProcessor('notifications', ACCOUNT_MAIL_EVENTS.retail.password_reset)
export class CustomerPasswordResetMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(ACCOUNT_MAIL_EVENTS.retail.password_reset, job);
  }
}

/**
 * Sends the invitation of a retail-rank account that staff created or moved to the retail rank.
 *
 * Why: The staff create route and the rank change write `customer.invited`.
 */
@Injectable()
@QueueProcessor('notifications', ACCOUNT_MAIL_EVENTS.retail.invited)
export class CustomerInvitedMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(ACCOUNT_MAIL_EVENTS.retail.invited, job);
  }
}

/**
 * Sends the verification link after a retail-rank account's email changed.
 *
 * Why: A staff change of the email and the resend route write `customer.email_verification`.
 */
@Injectable()
@QueueProcessor('notifications', ACCOUNT_MAIL_EVENTS.retail.email_verification)
export class CustomerEmailVerificationMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(ACCOUNT_MAIL_EVENTS.retail.email_verification, job);
  }
}

/**
 * Sends the link of a shop sign-up: "finish creating your account".
 *
 * Why: decision 079 (the review's S3): `POST /store/v1/auth/sign-up` for an address without an account writes `customer.sign_up_link`; the
 * mail says that no account is made until the link is opened. This job rotates the link and sends the mail.
 */
@Injectable()
@QueueProcessor('notifications', SIGN_UP_MAIL_EVENTS.sign_up_link)
export class SignUpLinkMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(SIGN_UP_MAIL_EVENTS.sign_up_link, job);
  }
}

/**
 * Sends the answer to a sign-up for an address that already has an account: "you already have an account, nothing was changed", with
 * its ordinary sign-in link.
 *
 * Why: decision 079 (the review's S3): `POST /store/v1/auth/sign-up` for a retail account that may get a link writes
 * `customer.sign_up_existing`, so the reader knows the form changed nothing. This job rotates the link and sends the mail.
 */
@Injectable()
@QueueProcessor('notifications', SIGN_UP_MAIL_EVENTS.sign_up_existing)
export class SignUpExistingMailProcessor implements JobProcessor<OutboxJobData, AccountMailJobResult> {
  constructor(private readonly jobs: AccountMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was sent, and why not
   */
  process(job: Job<OutboxJobData, AccountMailJobResult, string>): Promise<AccountMailJobResult> {
    return this.jobs.handle(SIGN_UP_MAIL_EVENTS.sign_up_existing, job);
  }
}
