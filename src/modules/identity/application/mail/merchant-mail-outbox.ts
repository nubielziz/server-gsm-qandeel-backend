// MerchantMailOutbox: writes the outbox events of the merchant mails (ids only) and registers their queue routes.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TransactionContext } from '../../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../../platform';

/** The three mails of the merchant portal. */
export type MerchantMailKind = 'email_verification' | 'password_reset' | 'invited';

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

/**
 * Writes the outbox row of a merchant mail.
 *
 * Why: decision 020: an email is async work, so the use case writes `outbox_events` in its own transaction and the worker's
 * relay turns it into a `notifications` job. The row carries the merchant id and the `auth_tokens` id, never the token: the job
 * that sends the mail issues the clear token itself (feature 12a, `MerchantMailJobs`), so no clear token is ever stored or logged.
 *
 * Side effects: registers the three event types with the `notifications` queue at boot (the API and the worker both load this
 * class); `enqueue` inserts one `outbox_events` row.
 */
@Injectable()
export class MerchantMailOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers the three event types with their queue. */
  onModuleInit(): void {
    for (const type of Object.values(MERCHANT_MAIL_EVENTS)) this.routes.register({ type, queue: 'notifications' });
  }

  /**
   * Writes the event of one mail in the caller's transaction.
   *
   * @param work the caller's transaction
   * @param mail the kind, the merchant and the `auth_tokens` row of the link (the placeholder the mail job rotates)
   */
  async enqueue(
    work: Pick<TransactionContext, 'tx'>,
    mail: { readonly kind: MerchantMailKind; readonly clientId: number; readonly tokenId: number },
  ): Promise<void> {
    await this.outbox.add(work.tx, {
      type: MERCHANT_MAIL_EVENTS[mail.kind],
      aggregateType: 'clients',
      aggregateId: mail.clientId,
      payload: { tokenId: mail.tokenId },
    });
  }
}
