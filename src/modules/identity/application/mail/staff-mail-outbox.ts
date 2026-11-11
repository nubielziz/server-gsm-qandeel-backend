// StaffMailOutbox: writes the outbox events of the staff link mails (ids only) and registers their queue routes (feature 20, slice C).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TransactionContext } from '../../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../../platform';

/** The two mails staff get: the invitation to the console and a link to choose a new password. */
export type StaffMailKind = 'invited' | 'password_reset';

/**
 * The outbox event types of the staff mails.
 *
 * Why: LEAD-DECISIONS section 6 (merchant management): staff invitation and reset links are sent by email. One event per mail, on the
 * `notifications` queue (docs/queues.md), the same design as the merchant mails.
 */
export const STAFF_MAIL_EVENTS = {
  invited: 'staff.invited',
  password_reset: 'staff.password_reset',
} as const satisfies Record<StaffMailKind, string>;

/**
 * Writes the outbox row of a staff mail.
 *
 * Why: decision 020 and feature 12a: the request only writes ids. The row carries the staff id and the `auth_tokens` id, never the token:
 * the job that sends the mail rotates the token and puts the clear link into the mail, so no clear token is stored or logged.
 *
 * Side effects: registers the two event types with the `notifications` queue at boot (the API and the worker both load this class);
 * `enqueue` inserts one `outbox_events` row.
 */
@Injectable()
export class StaffMailOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers the two event types with their queue. */
  onModuleInit(): void {
    for (const type of Object.values(STAFF_MAIL_EVENTS)) this.routes.register({ type, queue: 'notifications' });
  }

  /**
   * Writes the event of one mail in the caller's transaction.
   *
   * @param work the caller's transaction
   * @param mail the kind, the staff member and the `auth_tokens` row of the link (the placeholder the mail job rotates)
   */
  async enqueue(
    work: Pick<TransactionContext, 'tx'>,
    mail: { readonly kind: StaffMailKind; readonly staffId: number; readonly tokenId: number },
  ): Promise<void> {
    await this.outbox.add(work.tx, {
      type: STAFF_MAIL_EVENTS[mail.kind],
      aggregateType: 'staff_users',
      aggregateId: mail.staffId,
      payload: { tokenId: mail.tokenId },
    });
  }
}
