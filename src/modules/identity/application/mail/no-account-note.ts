// NoAccountNote: the mail that answers a sign-in link asked for an address without an account (decision 079): a link no longer makes an
// account, so the address is told where an account is made.
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import type { TransactionContext } from '../../../../infra/db';
import { NotificationService } from '../../../platform';
import { signUpPageUrl } from '../../domain/public-links';
import { CUSTOMER_NO_ACCOUNT_EVENT } from './identity-mail-events';

/** What the note says was asked (its `{{change}}`, which a security notice keeps: decision 047). */
export const NO_ACCOUNT_CHANGE = 'A sign-in link was asked for this email address, and no account uses it yet.';

/**
 * Queues the note to an address that has no account.
 *
 * Why: decision 079: `POST /store/v1/auth/magic-link` mails a sign-in link to a login account only; an address with no login account (no
 * row, or only a guest row) gets this note with the shop's sign-up page instead, from the same request, with the same answer. The note is
 * addressed to the email that was typed (`NotificationService.enqueueToEmail`), never to a row: the review of decision 079 found that
 * making a guest row only to address the note let anybody plant rows for any address, so the request leaves no row behind.
 *
 * Side effects: `enqueue` inserts a `notifications` row (recipient `account` 0, the address in its payload's `to`) and its
 * `outbox_events` row (`notification.send`, ids only) in the caller's transaction; the platform's delivery sends the mail.
 */
@Injectable()
export class NoAccountNote {
  constructor(
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Queues the note in the caller's transaction.
   *
   * @param work the caller's transaction (the request's; a run that sends no mail is rolled back with it)
   * @param email the normalised address the visitor typed
   */
  async enqueue(work: Pick<TransactionContext, 'tx'>, email: string): Promise<void> {
    await this.notifications.enqueueToEmail(work, {
      event: CUSTOMER_NO_ACCOUNT_EVENT,
      audience: 'customer',
      to: email,
      variables: { change: NO_ACCOUNT_CHANGE, signUpUrl: signUpPageUrl(this.config.http.storeBaseUrl) },
    });
  }
}
