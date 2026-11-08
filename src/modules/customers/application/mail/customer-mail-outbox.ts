// CustomerMailOutbox: writes the outbox events of the customer mails (ids only) and registers their queue routes.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TransactionContext } from '../../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../../platform';

/** The four mails of the storefront account. */
export type CustomerMailKind = 'magic_link' | 'password_reset' | 'invited' | 'email_verification';

/**
 * The outbox event types of the customer mails.
 *
 * Why: decision 020: one event per mail, one owner per type (feature 14b). The queue is `notifications` (docs/queues.md); the job
 * that handles them sends the mail through the platform's notification delivery (decision 033).
 */
export const CUSTOMER_MAIL_EVENTS = {
  magic_link: 'customer.magic_link',
  password_reset: 'customer.password_reset',
  invited: 'customer.invited',
  email_verification: 'customer.email_verification',
} as const satisfies Record<CustomerMailKind, string>;

/**
 * Writes the outbox row of a customer mail.
 *
 * Why: decision 020: an email is async work, so the use case writes `outbox_events` in its own transaction and the worker's relay
 * turns it into a `notifications` job. The row carries the customer id and the `auth_tokens` id, never the token: the job that sends
 * the mail issues the clear token itself (`CustomerMailJobs`), so no clear token is ever stored or logged.
 *
 * Side effects: registers the four event types with the `notifications` queue at boot (the API and the worker both load this
 * class); `enqueue` inserts one `outbox_events` row.
 */
@Injectable()
export class CustomerMailOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers the four event types with their queue. */
  onModuleInit(): void {
    for (const type of Object.values(CUSTOMER_MAIL_EVENTS)) this.routes.register({ type, queue: 'notifications' });
  }

  /**
   * Writes the event of one mail in the caller's transaction.
   *
   * @param work the caller's transaction
   * @param mail the kind, the customer and the `auth_tokens` row of the link (the placeholder the mail job rotates)
   */
  async enqueue(
    work: Pick<TransactionContext, 'tx'>,
    mail: { readonly kind: CustomerMailKind; readonly customerId: number; readonly tokenId: number },
  ): Promise<void> {
    await this.outbox.add(work.tx, {
      type: CUSTOMER_MAIL_EVENTS[mail.kind],
      aggregateType: 'customers',
      aggregateId: mail.customerId,
      payload: { tokenId: mail.tokenId },
    });
  }
}
