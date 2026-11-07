// The merchant mails of the identity module: the outbox event types, their `notifications` queue routes, the worker processors
// and the MailSender seam. Loaded by the API (it writes the events) and by the worker (src/worker.module.ts: it handles them).
import { Module } from '@nestjs/common';
import { LogMailSender } from './application/mail/log-mail-sender';
import { MAIL_SENDER } from './application/mail/mail-sender';
import { MerchantMailJobs } from './application/mail/merchant-mail-jobs';
import { MerchantMailOutbox } from './application/mail/merchant-mail-outbox';
import {
  EmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  PasswordResetMailProcessor,
} from './jobs/merchant-mail.processors';

/**
 * Provides the merchant mail events, their processors and the development mail sender.
 *
 * Why: brief 2b. The API and the worker must both register the event types (the worker's relay only knows the routes
 * registered in its own process), so both load this module; only the worker turns the processors into BullMQ workers. Feature
 * 12a replaces the `MAIL_SENDER` provider with templates and real delivery.
 */
@Module({
  providers: [
    MerchantMailOutbox,
    MerchantMailJobs,
    LogMailSender,
    { provide: MAIL_SENDER, useExisting: LogMailSender },
    EmailVerificationMailProcessor,
    PasswordResetMailProcessor,
    MerchantInvitedMailProcessor,
  ],
  exports: [MerchantMailOutbox, MAIL_SENDER],
})
export class MerchantMailModule {}
