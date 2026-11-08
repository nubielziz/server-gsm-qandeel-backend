// TicketMailOutbox: writes the outbox event of a ticket's email or Telegram message (ids only) in the caller's transaction, and registers
// its queue route. The job that sends it is TicketMailJobs.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TransactionContext } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';
import type { SupportTicket, TicketMessage } from '../db/schema';
import type { ReplyChannel } from '../domain/reply-channels';

/** The outbox event type, and the name of the job on the `notifications` queue, of every message a ticket causes. */
export const TICKET_MAIL_EVENT = 'support.ticket_mail';

/** The three messages a ticket causes: the receipt, a staff reply, the satisfaction survey. */
export type TicketMailKind = 'received' | 'reply' | 'survey';

/** The values of {@link TicketMailKind}, to check an event's payload. */
export const TICKET_MAIL_KINDS: readonly TicketMailKind[] = ['received', 'reply', 'survey'];

/**
 * Registers the queue route of {@link TICKET_MAIL_EVENT}.
 *
 * Why: the relay of the worker only knows the routes registered in its own process, so this class is loaded by the API (the outbox refuses
 * an unregistered type) and by the worker (`SupportEventsModule`). It needs no database.
 *
 * Side effects: registers one route with the `notifications` queue at boot.
 */
@Injectable()
export class TicketMailRoutes implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the route. */
  onModuleInit(): void {
    this.routes.register({ type: TICKET_MAIL_EVENT, queue: 'notifications' });
  }
}

/**
 * Writes the events of a ticket's messages.
 *
 * Why: decision 020 and feature 12a: a message with a link is not made in the API. The ticket link holds the ticket token (a credential), and
 * what a notification stores in its `variables` is shown in the console's notification log, so the use case writes only ids here (`ticket`,
 * the message, the channel) and the job that sends the message builds the link and passes it as a secret that is never stored or logged
 * (`NotificationService.sendNow`). The event commits with the ticket change, so a message exists if and only if the change did.
 *
 * Side effects: inserts one `outbox_events` row per call (type `support.ticket_mail`).
 */
@Injectable()
export class TicketMailOutbox {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Queues the receipt of a new ticket.
   *
   * @param work the caller's transaction
   * @param ticket the new ticket
   * @returns when the event is written
   */
  received(work: Pick<TransactionContext, 'tx'>, ticket: Pick<SupportTicket, 'id'>): Promise<void> {
    return this.add(work, ticket.id, { kind: 'received' });
  }

  /**
   * Queues a staff reply for delivery.
   *
   * @param work the caller's transaction
   * @param ticket the ticket
   * @param message the staff message just written
   * @param channel `email`, or `telegram` for a merchant with a linked chat
   * @returns when the event is written
   */
  reply(
    work: Pick<TransactionContext, 'tx'>,
    ticket: Pick<SupportTicket, 'id'>,
    message: Pick<TicketMessage, 'id'>,
    channel: ReplyChannel,
  ): Promise<void> {
    return this.add(work, ticket.id, { kind: 'reply', messageId: message.id, channel });
  }

  /**
   * Queues the satisfaction survey of a resolved ticket.
   *
   * @param work the caller's transaction
   * @param ticket the ticket just resolved
   * @returns when the event is written
   */
  survey(work: Pick<TransactionContext, 'tx'>, ticket: Pick<SupportTicket, 'id'>): Promise<void> {
    return this.add(work, ticket.id, { kind: 'survey' });
  }

  private async add(
    work: Pick<TransactionContext, 'tx'>,
    ticketId: number,
    payload: { kind: TicketMailKind; messageId?: number; channel?: ReplyChannel },
  ): Promise<void> {
    await this.outbox.add(work.tx, {
      type: TICKET_MAIL_EVENT,
      aggregateType: 'support_tickets',
      aggregateId: ticketId,
      payload,
    });
  }
}
