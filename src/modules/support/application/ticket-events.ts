// TicketEvents: the doorbells of the support chat (feature 28, plan § 3.4). Every use case that changes a ticket rings one after its commit;
// the API process that holds the streams re-reads the ticket with each viewer's rights (TicketRealtimeSource). Ids only.
import { Injectable } from '@nestjs/common';
import { RealtimePublisher } from '../../../infra/realtime';

/** The doorbell topic of the support chat, and of its source. */
export const TICKET_TOPIC = 'ticket';

/** What a ticket doorbell says happened. */
export type TicketDoorbellOp = 'message' | 'updated' | 'read' | 'revoked';

/**
 * Rings the ticket doorbells.
 *
 * Why: owner request (2026-11-15) and decision 037: a message appears at once on the other side, without a reload. The doorbell carries
 * ids only (never a text, a name or the ticket token), so a lost or forged one loses or leaks nothing; the source decides who may see
 * what. Every change rings after its commit (`publishOnCommit`), so a reader finds the row and a rolled-back change rings nothing.
 *
 * Side effects: `PUBLISH` on the cache Redis (through `RealtimePublisher`, which never throws to the caller).
 *
 * @see docs/contract/realtime-events.md
 */
@Injectable()
export class TicketEvents {
  constructor(private readonly publisher: RealtimePublisher) {}

  /**
   * A message was written (a requester's message, a reply, a note, the system message of a resolve).
   *
   * @param ticketId the ticket
   * @param messageId the new message
   */
  message(ticketId: number, messageId: number): void {
    this.publisher.publishOnCommit(TICKET_TOPIC, 'message', { ticketId, messageId });
  }

  /**
   * The ticket changed without a new message the requester sees (a new ticket, a status, assignee or priority change).
   *
   * @param ticketId the ticket
   */
  updated(ticketId: number): void {
    this.publisher.publishOnCommit(TICKET_TOPIC, 'updated', { ticketId });
  }

  /**
   * A side's seen mark moved.
   *
   * @param ticketId the ticket
   * @param by the side that marked
   */
  read(ticketId: number, by: 'requester' | 'staff'): void {
    this.publisher.publishOnCommit(TICKET_TOPIC, 'read', { ticketId, by });
  }

  /**
   * The ticket link no longer opens the ticket (its customer was anonymized): its open ticket streams end.
   *
   * @param ticketId the ticket
   */
  revoked(ticketId: number): void {
    this.publisher.publishOnCommit(TICKET_TOPIC, 'revoked', { ticketId });
  }
}
