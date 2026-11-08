// The merchant mails of the identity module: the outbox event types, their `notifications` queue routes and the worker processors. Loaded by
// the API (it writes the events) and by the worker (src/worker.module.ts: it handles them).
import { Module } from '@nestjs/common';
import { NotificationDeliveryModule } from '../platform';
import { MerchantMailJobs } from './application/mail/merchant-mail-jobs';
import { MerchantMailOutbox } from './application/mail/merchant-mail-outbox';
import {
  EmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  PasswordResetMailProcessor,
} from './jobs/merchant-mail.processors';

/**
 * Provides the merchant mail events, their processors and the job that rotates a link and sends it.
 *
 * Why: brief 2b and feature 12a. The API and the worker must both register the event types (the worker's relay only knows the routes
 * registered in its own process), so both load this module; only the worker turns the processors into BullMQ workers. The mail is sent
 * by the platform's notification delivery (`NotificationService.sendNow`): templates, the mail transport, retries and the log row.
 */
@Module({
  imports: [NotificationDeliveryModule],
  providers: [
    MerchantMailOutbox,
    MerchantMailJobs,
    EmailVerificationMailProcessor,
    PasswordResetMailProcessor,
    MerchantInvitedMailProcessor,
  ],
  exports: [MerchantMailOutbox],
})
export class MerchantMailModule {}
