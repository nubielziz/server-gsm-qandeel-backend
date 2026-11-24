// MerchantLifecycleMails: the transactional emails staff actions send to a merchant (suspension, reactivation, security
// notice; feature 20) and the notice of an API key the merchant made in the portal. Each is a `notifications` row plus a
// `notification.send` outbox event written in the caller's transaction.
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import type { TransactionContext } from '../../../../infra/db';
import { NotificationService } from '../../../platform';
import type { Client } from '../../db/schema';
import {
  MERCHANT_PORTAL_API_KEY_CREATED_EVENT,
  MERCHANT_REACTIVATED_EVENT,
  MERCHANT_SECURITY_NOTICE_EVENT,
  MERCHANT_SUSPENDED_EVENT,
} from './identity-mail-events';

/** The changes a security notice names: staff actions, a new API key made by staff and a staff change of a key. */
export type SecurityNoticeKind =
  'temporary_password' | 'twofa_reset' | 'api_key_created' | 'api_key_changed' | 'email_changed';

/**
 * The fixed sentence of each security notice (`{{change}}` of `merchant.security_notice`).
 *
 * Why: the staff action decides the words, never free text, so the notice cannot carry a secret or a staff opinion. One sentence per kind:
 * every merchant reads English (decision 039).
 */
export const SECURITY_NOTICE_PHRASES: Readonly<Record<SecurityNoticeKind, string>> = {
  temporary_password: 'a temporary password was set for your account; you will choose a new one when you sign in',
  twofa_reset: 'two-factor sign-in was turned off for your account',
  api_key_created: 'a new API key was created for your account',
  api_key_changed: 'the allowed addresses or the rate limit of one of your API keys was changed',
  email_changed:
    'the email address of your account was changed, so this address no longer receives the emails of your account',
};

/**
 * The sentence of the notice of a key the merchant made in the portal (`{{change}}` of `merchant.portal_api_key_created`).
 *
 * Why: the notice of a staff action opens with "Our support team made this change", which is not true of a key the merchant made; this
 * notice says where the key was made, in neutral words, and its template says what to do. A fixed sentence, like the others (decision 039).
 */
export const PORTAL_API_KEY_NOTICE_PHRASE = "A new API key was created in your account's portal.";

/** A merchant as these mails need it. */
type Recipient = Pick<Client, 'id' | 'name'>;

/**
 * Writes the lifecycle emails of a merchant.
 *
 * Why: LEAD-DECISIONS section 6 and O-6: a merchant is told when staff suspend or reactivate the account, or
 * change something security-relevant (a temporary password, a 2FA reset, a staff change of an API key's addresses or limit, a new email
 * address), and when an API key is created (by staff: the security notice; by the merchant in the portal: its own notice). All are transactional: always sent, whatever the
 * preferences, and also to a suspended merchant. The mail is the event's one English template (decision 039). The suspension
 * mail does not carry the staff reason (it is an internal note).
 *
 * Side effects: each call inserts a `notifications` row and an `outbox_events` row in the caller's transaction. A missing or switched-off template
 * sends nothing and is not an error (RULES settings 10); the security notice is the exception: it is written from its shipped text (decision 047). No dedupe key: the guarded change a mail rides on happens once.
 */
@Injectable()
export class MerchantLifecycleMails {
  constructor(
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * `merchant.suspended`: the account was suspended. The staff reason is not sent.
   *
   * @param work the caller's transaction
   * @param client the merchant
   * @returns once the notification and its outbox event are written
   */
  suspended(work: Pick<TransactionContext, 'tx'>, client: Recipient): Promise<void> {
    return this.send(work, MERCHANT_SUSPENDED_EVENT, client, { merchantName: client.name });
  }

  /**
   * `merchant.reactivated`: a suspended account is active again.
   *
   * @param work the caller's transaction
   * @param client the merchant
   * @returns once the notification and its outbox event are written
   */
  reactivated(work: Pick<TransactionContext, 'tx'>, client: Recipient): Promise<void> {
    return this.send(work, MERCHANT_REACTIVATED_EVENT, client, {
      merchantName: client.name,
      portalUrl: this.config.http.portalBaseUrl,
    });
  }

  /**
   * `merchant.security_notice`: staff changed something security-relevant, or staff created an API key.
   *
   * @param work the caller's transaction
   * @param client the merchant
   * @param kind what changed; it decides the sentence
   * @param options `to`: the address to write to instead of the merchant's current one (decision 047: the notice of an email change goes
   *   to the address before the change)
   * @returns once the notification and its outbox event are written
   */
  securityNotice(
    work: Pick<TransactionContext, 'tx'>,
    client: Recipient,
    kind: SecurityNoticeKind,
    options: { readonly to?: string } = {},
  ): Promise<void> {
    return this.send(
      work,
      MERCHANT_SECURITY_NOTICE_EVENT,
      client,
      { merchantName: client.name, change: SECURITY_NOTICE_PHRASES[kind] },
      options.to,
    );
  }

  /**
   * `merchant.portal_api_key_created`: the merchant created an API key in the portal.
   *
   * Why: the merchant learns of the key in neutral words, without being told that the support team acted, and what to do about a key it
   * did not make. The notice of a key staff made stays `securityNotice(…, 'api_key_created')`.
   *
   * @param work the caller's transaction
   * @param client the merchant
   * @returns once the notification and its outbox event are written
   */
  portalApiKeyCreated(work: Pick<TransactionContext, 'tx'>, client: Recipient): Promise<void> {
    return this.send(work, MERCHANT_PORTAL_API_KEY_CREATED_EVENT, client, {
      merchantName: client.name,
      change: PORTAL_API_KEY_NOTICE_PHRASE,
    });
  }

  private async send(
    work: Pick<TransactionContext, 'tx'>,
    event: string,
    client: Recipient,
    variables: Record<string, string>,
    to?: string,
  ): Promise<void> {
    await this.notifications.enqueue(work, {
      event,
      recipient: { type: 'client', id: client.id },
      channel: 'email',
      variables,
      ...(to === undefined ? {} : { to }),
    });
  }
}
