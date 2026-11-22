// The security notices a storefront customer gets after a staff action on the account (decision 047).
import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../infra/db';
import { CUSTOMER_SECURITY_NOTICE_EVENT, NotificationService } from '../../../platform';
import { greetingName } from '../../domain/recovery';

/** The staff actions a customer's security notice names. */
export type CustomerSecurityNoticeKind =
  'email_changed' | 'temporary_password' | 'account_created_with_temporary_password';

/**
 * The fixed sentence of each customer security notice (`{{change}}` of `customer.security_notice`).
 *
 * Why: decision 047: the staff action decides the words, never free text, so the notice carries no secret and no address; the
 * sentences of the email change and of the temporary password are the ones the merchant's notice uses. Each sentence completes
 * "Our support team made this change to your account: ...".
 */
export const CUSTOMER_SECURITY_NOTICE_PHRASES: Readonly<Record<CustomerSecurityNoticeKind, string>> = {
  email_changed:
    'the email address of your account was changed, so this address no longer receives the emails of your account',
  temporary_password:
    'a temporary password was set for your account and every device was signed out; you will choose a new password when you sign in again',
  account_created_with_temporary_password:
    'an account was created for this email address with a temporary password; whoever signs in with it chooses a new password first',
};

/**
 * Writes the security notices of a storefront customer.
 *
 * Why: decision 047: a staff change of an account's email moves the account, so the address before the change is told (it may be the
 * only place the owner reads); a temporary password set by staff is a working credential for the account, so the address of the
 * account is told in the same transaction. Transactional: always sent, whatever the preferences.
 *
 * Side effects: each call inserts a `notifications` row and an `outbox_events` row in the caller's transaction.
 */
@Injectable()
export class CustomerSecurityNotices {
  constructor(private readonly notifications: NotificationService) {}

  /**
   * `customer.security_notice` for an email change: written to the address the account had before the change.
   *
   * @param work the caller's transaction
   * @param customer the customer (id and name)
   * @param previousEmail the address before the change, which the row names (the delivery sends there, not to the new address)
   * @returns once the notification and its outbox event are written
   */
  async emailChanged(
    work: Pick<TransactionContext, 'tx'>,
    customer: { readonly id: number; readonly name: string },
    previousEmail: string,
  ): Promise<void> {
    await this.write(work, customer, previousEmail, 'email_changed');
  }

  /**
   * `customer.security_notice` for a temporary password that staff set (on an account, or when they create the account with it):
   * written to the address of the account.
   *
   * @param work the caller's transaction
   * @param customer the customer (id, name and the locked row's email)
   * @param kind `temporary_password` for an existing account, `account_created_with_temporary_password` for a new one
   * @returns once the notification and its outbox event are written
   */
  async temporaryPasswordSet(
    work: Pick<TransactionContext, 'tx'>,
    customer: { readonly id: number; readonly name: string; readonly email: string },
    kind: 'temporary_password' | 'account_created_with_temporary_password',
  ): Promise<void> {
    await this.write(work, customer, customer.email, kind);
  }

  private async write(
    work: Pick<TransactionContext, 'tx'>,
    customer: { readonly id: number; readonly name: string },
    to: string,
    kind: CustomerSecurityNoticeKind,
  ): Promise<void> {
    // No dedupe key: the guarded change a notice rides on happens once, like the merchant lifecycle mails.
    await this.notifications.enqueue(work, {
      event: CUSTOMER_SECURITY_NOTICE_EVENT,
      recipient: { type: 'customer', id: customer.id },
      channel: 'email',
      variables: {
        customerName: greetingName(customer.name),
        change: CUSTOMER_SECURITY_NOTICE_PHRASES[kind],
      },
      to,
    });
  }
}
