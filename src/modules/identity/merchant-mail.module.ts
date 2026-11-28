// The account mails of the identity module (decision 064; the file keeps its first name): the outbox event types of both ranks' links
// (verification, reset, invitation and, for the retail rank, the sign-in link), their `notifications` queue routes, the job that rotates
// a link and sends it, the worker processors and the one-time link tokens. Loaded by the API (it writes the events) and by the worker
// (src/worker.module.ts: it handles them).
import { Module } from '@nestjs/common';
import { NotificationDeliveryModule } from '../platform';
import { AccountsModule } from './accounts.module';
import { AccountAuthTokenService } from './application/account-auth-tokens';
import { AccountMailJobs } from './application/mail/account-mail-jobs';
import { AccountMailOutboxService } from './application/mail/account-mail-outbox';
import { MerchantLifecycleMails } from './application/mail/merchant-lifecycle-mails';
import { MerchantMailOutbox } from './application/mail/merchant-mail-outbox';
import { NoAccountNote } from './application/mail/no-account-note';
import { IdentityMailEventsModule } from './identity-mail-events.module';
import {
  CustomerEmailVerificationMailProcessor,
  CustomerInvitedMailProcessor,
  CustomerPasswordResetMailProcessor,
  MagicLinkMailProcessor,
  MerchantEmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  MerchantPasswordResetMailProcessor,
  SignUpExistingMailProcessor,
  SignUpLinkMailProcessor,
} from './jobs/account-mail.processors';
import { AccountAuthTokens } from './ports/account-auth-tokens';
import { AccountMailOutbox } from './ports/account-mail-outbox';

/**
 * Provides the account mail events, their nine processors (two of them the sign-up mails of decision 079), the job that rotates a link and sends it, and the account link tokens.
 *
 * Why: brief 2b, features 12a and 14b, decision 064: one set of link mails serves every rank. The API and the worker must both register
 * the event types (the worker's relay only knows the routes registered in its own process: `AccountMailOutboxService` registers them at
 * module init), so both load this module; only the worker turns the processors into BullMQ workers. The mail is sent by the platform's
 * notification delivery (`NotificationService.sendNow`): templates, the mail transport, retries and the log row. It imports
 * `AccountsModule` (the mails read the account), which also makes the account records global in the worker.
 *
 * Port bindings: `AccountAuthTokens` is `AccountAuthTokenService` and `AccountMailOutbox` is `AccountMailOutboxService`, so a test spy on
 * the port sees every call of the services that inject it. The class `AccountAuthTokenService` is exported too: the link sign-in and the
 * link-token resolver need its lookups. `MerchantMailOutbox` stays for the callers of its old event names until the contract release.
 * `NoAccountNote` (decision 079) queues the note to an address without an account through the platform's `NotificationService`.
 */
@Module({
  imports: [NotificationDeliveryModule, IdentityMailEventsModule, AccountsModule],
  providers: [
    MerchantMailOutbox,
    MerchantLifecycleMails,
    AccountAuthTokenService,
    { provide: AccountAuthTokens, useExisting: AccountAuthTokenService },
    AccountMailOutboxService,
    { provide: AccountMailOutbox, useExisting: AccountMailOutboxService },
    AccountMailJobs,
    NoAccountNote,
    MerchantEmailVerificationMailProcessor,
    MerchantPasswordResetMailProcessor,
    MerchantInvitedMailProcessor,
    MagicLinkMailProcessor,
    CustomerPasswordResetMailProcessor,
    CustomerInvitedMailProcessor,
    CustomerEmailVerificationMailProcessor,
    SignUpLinkMailProcessor,
    SignUpExistingMailProcessor,
  ],
  exports: [
    MerchantMailOutbox,
    MerchantLifecycleMails,
    AccountAuthTokenService,
    AccountAuthTokens,
    AccountMailOutbox,
    NoAccountNote,
  ],
})
export class MerchantMailModule {}
