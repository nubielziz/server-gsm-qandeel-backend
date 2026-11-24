// MerchantMailOutbox: the old entry of the merchant mails, kept until the contract release (decision 064). The seam is `AccountMailOutbox`
// (`account-mail-outbox.ts`), which picks the family by the rank kind and registers the queue routes of all seven mails.
import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../infra/db';
import { OutboxService } from '../../../platform';
import { ACCOUNT_MAIL_EVENTS } from '../../domain/account-mail';

/** The three mails of a merchant rank. */
export type MerchantMailKind = keyof typeof ACCOUNT_MAIL_EVENTS.merchant;

/**
 * The outbox event types of the merchant mails.
 *
 * Why: RESOLUTIONS identity-platform-2 and brief 2b: one event per mail. The queue is `notifications` (docs/queues.md). The names are the
 * merchant family of {@link ACCOUNT_MAIL_EVENTS}; the stored templates keep them (decision 064).
 */
export const MERCHANT_MAIL_EVENTS = ACCOUNT_MAIL_EVENTS.merchant;

/**
 * Writes the outbox row of a merchant mail, for the callers that have not moved to `AccountMailOutbox` yet.
 *
 * Why: the same row as `AccountMailOutbox.enqueue` writes for a merchant rank (the account id as the aggregate and in the payload, with
 * the link row); it takes no lock and does not choose a family, so only a flow that already knows the account is a merchant may use it.
 * The routes are registered by the account mail outbox, which both processes load.
 *
 * Side effects: `enqueue` inserts one `outbox_events` row.
 *
 * Kept until the contract release; new code uses `AccountMailOutbox`.
 */
@Injectable()
export class MerchantMailOutbox {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Writes the event of one mail in the caller's transaction.
   *
   * @param work the caller's transaction
   * @param mail the kind, the merchant (an account id) and the `auth_tokens` row of the link (the placeholder the mail job rotates)
   * @returns once the event is written
   */
  async enqueue(
    work: Pick<TransactionContext, 'tx'>,
    mail: { readonly kind: MerchantMailKind; readonly clientId: number; readonly tokenId: number },
  ): Promise<void> {
    await this.outbox.add(work.tx, {
      type: MERCHANT_MAIL_EVENTS[mail.kind],
      aggregateType: 'clients',
      aggregateId: mail.clientId,
      payload: { accountId: mail.clientId, tokenId: mail.tokenId },
    });
  }
}
