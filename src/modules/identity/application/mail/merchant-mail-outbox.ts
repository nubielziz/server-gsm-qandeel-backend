// MerchantMailOutbox: writes the outbox events of the merchant mails (ids only) and registers their queue routes.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import type { TransactionContext } from '../../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../../platform';
import type { MerchantMailKind } from './mail-sender';

/**
 * The outbox event types of the merchant mails.
 *
 * Why: RESOLUTIONS identity-platform-2 and brief 2b: one event per mail; feature 2a writes `merchant.invited` for
 * `POST /admin/clients`, feature 2b the other two. The queue is `notifications` (docs/queues.md).
 */
export const MERCHANT_MAIL_EVENTS = {
  email_verification: 'merchant.email_verification',
  password_reset: 'merchant.password_reset',
  invited: 'merchant.invited',
} as const satisfies Record<MerchantMailKind, string>;

/** Where each mail's link points in the merchant portal (`<PORTAL_BASE_URL><path>?token=<token>`). */
const PORTAL_PATHS: Readonly<Record<MerchantMailKind, string>> = {
  email_verification: '/verify-email',
  password_reset: '/set-password',
  invited: '/set-password',
};

/**
 * Writes the outbox row of a merchant mail.
 *
 * Why: decision 020: an email is async work, so the use case writes `outbox_events` in its own transaction and the worker's
 * relay turns it into a `notifications` job. The row carries the merchant id and the `auth_tokens` id, never the token.
 *
 * Side effects: registers the three event types with the `notifications` queue at boot (the API and the worker both load this
 * class); `enqueue` inserts one `outbox_events` row; outside production it also logs the link, see {@link enqueue}.
 */
@Injectable()
export class MerchantMailOutbox implements OnModuleInit {
  private readonly logger = new Logger('MerchantMail');

  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Registers the three event types with their queue. */
  onModuleInit(): void {
    for (const type of Object.values(MERCHANT_MAIL_EVENTS)) this.routes.register({ type, queue: 'notifications' });
  }

  /**
   * Writes the event of one mail in the caller's transaction.
   *
   * Development convenience: until feature 12a delivers real mail, a developer needs the link to finish a flow, and the token
   * exists in clear text only here. Outside production the link is written to the log (development and tests only: a link
   * is a credential, so it never reaches a production log).
   *
   * @param work the caller's transaction
   * @param mail the kind, the merchant, and the issued token (id and clear text)
   */
  async enqueue(
    work: Pick<TransactionContext, 'tx' | 'afterCommit'>,
    mail: {
      readonly kind: MerchantMailKind;
      readonly clientId: number;
      readonly tokenId: number;
      readonly token: string;
    },
  ): Promise<void> {
    await this.outbox.add(work.tx, {
      type: MERCHANT_MAIL_EVENTS[mail.kind],
      aggregateType: 'clients',
      aggregateId: mail.clientId,
      payload: { tokenId: mail.tokenId },
    });
    if (this.config.isProduction) return;
    // After the commit, so a rolled-back registration does not print a link that opens nothing.
    work.afterCommit(() => {
      this.logger.log(
        `DEVELOPMENT ONLY: merchant.${mail.kind} link for client ${mail.clientId}: ` +
          `${this.config.http.portalBaseUrl}${PORTAL_PATHS[mail.kind]}?token=${encodeURIComponent(mail.token)}`,
      );
    });
  }
}
