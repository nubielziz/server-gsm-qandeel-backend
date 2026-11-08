// The customer mails of the customers module: the outbox event types, their `notifications` queue routes, the worker processors and the job
// that rotates a link and sends it. Loaded by the API (it writes the events) and by the worker (src/worker.module.ts: it handles them).
import { Module } from '@nestjs/common';
import { CustomerTokensModule } from '../identity';
import { NotificationDeliveryModule } from '../platform';
import { CustomerMailJobs } from './application/mail/customer-mail-jobs';
import { CustomerMailOutbox } from './application/mail/customer-mail-outbox';
import {
  CustomerEmailVerificationMailProcessor,
  CustomerInvitedMailProcessor,
  CustomerPasswordResetMailProcessor,
  MagicLinkMailProcessor,
} from './jobs/customer-mail.processors';

/**
 * Provides the customer mail events, their processors and the job that rotates a link and sends it.
 *
 * Why: feature 14b and decision 033. The API and the worker must both register the event types (the worker's relay only knows the routes
 * registered in its own process), so both load this module; only the worker turns the processors into BullMQ workers. The mail is sent
 * by the platform's notification delivery (`NotificationService.sendNow`): templates, the mail transport, retries and the log row.
 */
@Module({
  imports: [CustomerTokensModule, NotificationDeliveryModule],
  providers: [
    CustomerMailOutbox,
    CustomerMailJobs,
    MagicLinkMailProcessor,
    CustomerPasswordResetMailProcessor,
    CustomerInvitedMailProcessor,
    CustomerEmailVerificationMailProcessor,
  ],
  exports: [CustomerMailOutbox],
})
export class CustomerMailModule {}
