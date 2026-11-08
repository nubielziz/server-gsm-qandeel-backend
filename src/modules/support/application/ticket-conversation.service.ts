// TicketConversationService: what staff write on a ticket (feature 17): a public reply, delivered to the requester on a channel, and an
// internal note. Both add a message to the thread; only the reply changes the ticket's status and sends something.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { SupportTicket } from '../db/schema';
import { type ReplyChannel, pickReplyChannel, replyChannelsOf } from '../domain/reply-channels';
import { findRequester, findStaffName } from '../infra/support-foreign-reads';
import { insertMessage, lockTicket, updateTicket } from '../infra/ticket.repository';
import { TicketMailOutbox } from './ticket-mail-outbox';
import { type TicketMessageView, toMessageView } from './ticket-views';

const notFound = () => new AppError('NOT_FOUND', { detail: 'No ticket has this id.' });
const labelOf = (ticket: Pick<SupportTicket, 'number' | 'subject'>) => `${ticket.number}, ${ticket.subject}`;

/**
 * Writes replies and notes on a ticket.
 *
 * Why: RULES support 3 to 6 and scenario b2c-ticket steps 4 and 5. A reply adds a public staff message, sends it on a channel the
 * requester can be reached on (email always, Telegram only to a merchant's linked chat), stamps `first_response_at` the first time,
 * moves a new or open ticket to `pending_customer` (sent as `pending`), clears the reply target and gives an unassigned ticket to the
 * sender. A reply on a resolved ticket is `409 TICKET_RESOLVED`. A note is internal, changes no status, and also takes an unassigned
 * ticket (the demo's `ticketReply`); it is allowed on a resolved ticket. The ticket is locked while the message is written. The text is
 * stored and sent as given: the console fills the template variables.
 *
 * Side effects: inserts a `ticket_messages` row, updates `support_tickets`, inserts a `support.ticket_mail` `outbox_events` row (a reply: the
 * job sends it) and an `audit_logs` row, in one transaction.
 */
@Injectable()
export class TicketConversationService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: TicketMailOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Replies to the requester.
   *
   * @param ticketId the ticket id
   * @param input the text and, optionally, the channel
   * @param staffId the staff member writing
   * @returns the new message
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `channel` when the ticket cannot be answered on it); `TICKET_RESOLVED`
   *   (409) for a resolved ticket
   */
  async reply(
    ticketId: number,
    input: { readonly body: string; readonly channel?: ReplyChannel | undefined },
    staffId: number,
  ): Promise<TicketMessageView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const ticket = await lockTicket(tx, ticketId);
      if (!ticket) throw notFound();
      const requester = await findRequester(tx, ticket.requesterType, ticket.requesterId);
      const allowed = replyChannelsOf({
        requesterType: ticket.requesterType,
        reachable: requester?.reachable ?? false,
        telegramChatId: requester?.telegramChatId ?? null,
      });
      const channel = pickReplyChannel(input.channel, ticket.channel, allowed);
      // The inbox of the mock answers a bad input before the resolved ticket (mocks/ticketHandlers.ts), so the channel is judged first.
      if (channel === undefined || requester === undefined) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            { field: 'channel', code: 'not_allowed', message: 'This ticket cannot be answered on that channel.' },
          ],
        });
      }
      if (ticket.status === 'resolved') {
        throw new AppError('TICKET_RESOLVED', { detail: 'Reopen the ticket before you reply.' });
      }

      const now = this.clock.now();
      const staffName = (await findStaffName(tx, staffId)) ?? 'Staff';
      const message = await insertMessage(tx, {
        ticketId,
        authorType: 'staff',
        authorId: staffId,
        body: input.body,
        isInternal: false,
        createdAt: now,
      });
      const waiting = ticket.status === 'new' || ticket.status === 'open';
      await updateTicket(tx, ticketId, {
        ...(waiting ? { status: 'pending_customer' as const } : {}),
        firstResponseAt: ticket.firstResponseAt ?? now,
        assigneeId: ticket.assigneeId ?? staffId,
        slaDueAt: null,
        updatedAt: now,
      });
      await this.mail.reply(work, ticket, message, channel);
      await this.audit.record(tx, {
        action: 'replied to ticket',
        entityType: 'ticket',
        entityId: ticketId,
        entityLabel: labelOf(ticket),
        after: { messageId: message.id, channel },
      });
      return toMessageView({ message, authorName: staffName });
    });
  }

  /**
   * Adds an internal note.
   *
   * @param ticketId the ticket id
   * @param input the text
   * @param staffId the staff member writing
   * @returns the new message
   * @throws {AppError} `NOT_FOUND`
   */
  async note(ticketId: number, input: { readonly body: string }, staffId: number): Promise<TicketMessageView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const ticket = await lockTicket(tx, ticketId);
      if (!ticket) throw notFound();
      const now = this.clock.now();
      const staffName = (await findStaffName(tx, staffId)) ?? 'Staff';
      const message = await insertMessage(tx, {
        ticketId,
        authorType: 'staff',
        authorId: staffId,
        body: input.body,
        isInternal: true,
        createdAt: now,
      });
      await updateTicket(tx, ticketId, { assigneeId: ticket.assigneeId ?? staffId, updatedAt: now });
      await this.audit.record(tx, {
        action: 'added note to ticket',
        entityType: 'ticket',
        entityId: ticketId,
        entityLabel: labelOf(ticket),
        after: { messageId: message.id },
      });
      return toMessageView({ message, authorName: staffName });
    });
  }
}
