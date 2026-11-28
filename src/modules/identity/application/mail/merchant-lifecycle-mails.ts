// MerchantLifecycleMails: the transactional emails staff actions send to a merchant (suspension, reactivation, security
// notice; feature 20). Each is a `notifications` row plus a `notification.send` outbox event written in the caller's transaction.
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import type { TransactionContext } from '../../../../infra/db';
import { CUSTOMER_SECURITY_NOTICE_EVENT, NotificationService } from '../../../platform';
import type { RankKind } from '../../ports/rank-kind';
import type { Client } from '../../db/schema';
import { accountAreaUrl } from '../../domain/public-links';
import {
  CUSTOMER_PASSWORD_SET_EVENT,
  MERCHANT_REACTIVATED_EVENT,
  MERCHANT_SECURITY_NOTICE_EVENT,
  MERCHANT_SUSPENDED_EVENT,
  PASSWORD_SET_SENTENCE,
} from './identity-mail-events';

/** The changes a security notice names: staff actions, a new API key made by staff, and a staff change of a key. */
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
 * The sentence of a retail rank's notice where it differs from {@link SECURITY_NOTICE_PHRASES}: the temporary password also ended every
 * session, and the account holder chooses a password at the next sign-in. The other kinds read the same for both ranks.
 */
const RETAIL_PHRASES: Readonly<Partial<Record<SecurityNoticeKind, string>>> = {
  temporary_password:
    'a temporary password was set for your account and every device was signed out; you will choose a new password when you sign in again',
};

/** The kinds that exist for a retail rank: it holds no API key. */
const RETAIL_NOTICE_KINDS: readonly SecurityNoticeKind[] = ['temporary_password', 'twofa_reset', 'email_changed'];

/**
 * An account as these mails need it.
 *
 * `rankKind` chooses the family of the security notice (decision 064): `retail` writes `customer.security_notice`, `merchant` or nothing
 * writes `merchant.security_notice`. The other mails of this class are merchant mails and ignore it.
 */
type Recipient = Pick<Client, 'id' | 'name'> & { readonly rankKind?: RankKind };

/**
 * Writes the lifecycle emails of a merchant.
 *
 * Why: LEAD-DECISIONS section 6 and O-6: a merchant is told when staff suspend or reactivate the account, or
 * change something security-relevant (a temporary password, a 2FA reset, a staff change of an API key's addresses or limit, a new email
 * address), and when staff create an API key (the security notice; merchants no longer create keys, decision 067). All are transactional: always sent, whatever the
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
      // The merchant pages live under the signed-in area of the shop (decision 064): the retired /merchant path is not linked.
      portalUrl: accountAreaUrl(this.config.http.storeBaseUrl),
    });
  }

  /**
   * `merchant.security_notice` (or `customer.security_notice` for a retail rank): staff changed something security-relevant or
   * created an API key.
   *
   * @param work the caller's transaction
   * @param client the account; its `rankKind` picks the family (a merchant rank when omitted)
   * @param kind what changed; it decides the sentence (a retail rank holds no API key: those kinds throw)
   * @param options `to`: the address to write to instead of the merchant's current one (decision 047: the notice of an email change goes
   *   to the address before the change)
   * @returns once the notification and its outbox event are written
   * @throws {Error} for an API key notice of a retail rank
   */
  securityNotice(
    work: Pick<TransactionContext, 'tx'>,
    client: Recipient,
    kind: SecurityNoticeKind,
    options: { readonly to?: string } = {},
  ): Promise<void> {
    if (client.rankKind === 'retail') {
      if (!RETAIL_NOTICE_KINDS.includes(kind))
        throw new Error(`The notice "${kind}" does not exist for a retail account.`);
      return this.send(
        work,
        CUSTOMER_SECURITY_NOTICE_EVENT,
        client,
        {
          customerName: client.name.trim() === '' ? 'there' : client.name.trim(),
          change: RETAIL_PHRASES[kind] ?? SECURITY_NOTICE_PHRASES[kind],
        },
        options.to,
      );
    }
    return this.send(
      work,
      MERCHANT_SECURITY_NOTICE_EVENT,
      client,
      { merchantName: client.name, change: SECURITY_NOTICE_PHRASES[kind] },
      options.to,
    );
  }

  /**
   * `customer.password_set`: the finish of a sign-up set the account's first password (decision 079, its re-review).
   *
   * Why: the account made that change itself, so this is not the staff notice (`customer.security_notice` says that support made it). The
   * mail goes to the account's own address, whose owner is the one who can say the change was not theirs. A security mail (decision 047):
   * a missing or switched-off template does not stop it, its shipped text is sent.
   *
   * @param work the caller's transaction
   * @param client the retail account; an empty name is greeted as "there"
   * @returns once the notification and its outbox event are written
   */
  passwordSet(work: Pick<TransactionContext, 'tx'>, client: Pick<Client, 'id' | 'name'>): Promise<void> {
    return this.send(work, CUSTOMER_PASSWORD_SET_EVENT, client, {
      customerName: client.name.trim() === '' ? 'there' : client.name.trim(),
      change: PASSWORD_SET_SENTENCE,
    });
  }

  private async send(
    work: Pick<TransactionContext, 'tx'>,
    event: string,
    client: Pick<Client, 'id'>,
    variables: Record<string, string>,
    to?: string,
  ): Promise<void> {
    await this.notifications.enqueue(work, {
      event,
      recipient: { type: 'account', id: client.id },
      channel: 'email',
      variables,
      ...(to === undefined ? {} : { to }),
    });
  }
}
