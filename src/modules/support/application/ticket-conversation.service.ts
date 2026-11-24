// TicketConversationService: what staff write on a ticket (feature 17): a public reply, delivered to the requester on a channel, and an
// internal note. Both add a message to the thread; only the reply changes the ticket's status and sends something. Feature 28: both carry
// attachments and ring the live doorbell; an email reply waits for the requester to see it before it is mailed.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService, SUPPORT_SETTINGS, SettingsReader } from '../../platform';
import type { SupportTicket } from '../db/schema';
import { type ReplyChannel, pickReplyChannel, replyChannelsOf } from '../domain/reply-channels';
import { replyMailDueAt } from '../domain/reply-mail';
import { findRequester, findStaffName } from '../infra/support-foreign-reads';
import { insertMessage, lockTicket, updateTicket } from '../infra/ticket.repository';
import { TicketAttachmentService } from './ticket-attachment.service';
import { TicketEvents } from './ticket-events';
import { TicketMailOutbox } from './ticket-mail-outbox';
import { type TicketMessageView, toMessageView } from './ticket-views';

const notFound = () => new AppError('NOT_FOUND', { detail: 'No ticket has this id.' });
const labelOf = (ticket: Pick<SupportTicket, 'number' | 'subject'>) => `${ticket.number}, ${ticket.subject}`;

/**
 * Writes replies and notes on a ticket.
 *
 * Why: RULES support 3 to 6 and scenario b2c-ticket steps 4 and 5. A reply adds a public staff message, sends it by email
 * (the one channel a requester can be reached on), stamps `first_response_at` the first time,
 * moves a new or open ticket to `pending_customer` (sent as `pending`), clears the reply target and gives an unassigned ticket to the
 * sender. A reply on a resolved ticket is `409 TICKET_RESOLVED`. A note is internal, changes no status, and also takes an unassigned
 * ticket (the demo's `ticketReply`); it is allowed on a resolved ticket. The ticket is locked while the message is written. The text is
 * stored and sent as given: the console fills the template variables.
 *
 * Feature 28: both carry the sender's own attachments (`fileIds`, a body may then be empty) and ring the doorbell after the commit (the
 * requester sees a reply at once; a note reaches staff only). A reply records `last_staff_message_id` (the requester's `hasUnread`) and its
 * channel on the message (`notify_channel`). An email reply is not sent at once: the ticket waits
 * `support.replyEmailDelayMinutes` (default 5) from its first unseen reply (`reply_mail_due_at`), and the reply-mail
 * sweep mails what the requester has not seen by then in one email. A delay of `0` writes the mail event at once, as before.
 *
 * Side effects: inserts a `ticket_messages` row, updates `support_tickets`, inserts a `support.ticket_mail` `outbox_events` row (an
 * email reply with no delay: the job sends it) and an `audit_logs` row, in one transaction; rings `ticket message`.
 */
@Injectable()
export class TicketConversationService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: TicketMailOutbox,
    private readonly attachments: TicketAttachmentService,
    private readonly events: TicketEvents,
    private readonly settings: SettingsReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Replies to the requester.
   *
   * @param ticketId the ticket id
   * @param input the text, optionally the channel, and the ids of the files it carries
   * @param staffId the staff member writing
   * @returns the new message
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `channel` when the ticket cannot be answered on it, on `fileIds` for a
   *   file that is not the sender's PDF, JPEG or PNG of 5 MiB); `TICKET_RESOLVED` (409) for a resolved ticket
   */
  async reply(
    ticketId: number,
    input: {
      readonly body: string;
      readonly channel?: ReplyChannel | undefined;
      readonly fileIds?: readonly number[] | undefined;
    },
    staffId: number,
  ): Promise<TicketMessageView> {
    const setting = SUPPORT_SETTINGS.replyEmailDelayMinutes;
    const delayMinutes = await this.settings.integer(setting.key, setting.fallback, setting);
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const ticket = await lockTicket(tx, ticketId);
      if (!ticket) throw notFound();
      const requester = await findRequester(tx, ticket.requesterId);
      const allowed = replyChannelsOf({ reachable: requester?.reachable ?? false });
      const channel = pickReplyChannel(input.channel, allowed);
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
      const { ids, files } = await this.attachments.attach(tx, { type: 'staff', id: staffId }, input.fileIds);
      const message = await insertMessage(tx, {
        ticketId,
        authorType: 'staff',
        authorId: staffId,
        body: input.body,
        isInternal: false,
        fileIds: ids,
        notifyChannel: channel,
        createdAt: now,
      });
      // Email goes at once only with no delay (rule 9).
      const mailNow = delayMinutes === 0;
      const waiting = ticket.status === 'new' || ticket.status === 'open';
      await updateTicket(tx, ticketId, {
        ...(waiting ? { status: 'pending_customer' as const } : {}),
        firstResponseAt: ticket.firstResponseAt ?? now,
        assigneeId: ticket.assigneeId ?? staffId,
        slaDueAt: null,
        lastStaffMessageId: message.id,
        ...(mailNow
          ? // Mailed now: a later sweep must not mail it again.
            { replyMailedMessageId: message.id }
          : { replyMailDueAt: replyMailDueAt(ticket.replyMailDueAt, now, delayMinutes) }),
        updatedAt: now,
      });
      if (mailNow) await this.mail.reply(work, ticket, message, channel);
      await this.audit.record(tx, {
        action: 'replied to ticket',
        entityType: 'ticket',
        entityId: ticketId,
        entityLabel: labelOf(ticket),
        after: { messageId: message.id, channel, fileIds: ids },
      });
      this.events.message(ticketId, message.id);
      return toMessageView({ message, authorName: staffName }, files);
    });
  }

  /**
   * Adds an internal note.
   *
   * @param ticketId the ticket id
   * @param input the text and the ids of the files it carries
   * @param staffId the staff member writing
   * @returns the new message
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `fileIds`)
   */
  async note(
    ticketId: number,
    input: { readonly body: string; readonly fileIds?: readonly number[] | undefined },
    staffId: number,
  ): Promise<TicketMessageView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const ticket = await lockTicket(tx, ticketId);
      if (!ticket) throw notFound();
      const now = this.clock.now();
      const staffName = (await findStaffName(tx, staffId)) ?? 'Staff';
      const { ids, files } = await this.attachments.attach(tx, { type: 'staff', id: staffId }, input.fileIds);
      const message = await insertMessage(tx, {
        ticketId,
        authorType: 'staff',
        authorId: staffId,
        body: input.body,
        isInternal: true,
        fileIds: ids,
        createdAt: now,
      });
      await updateTicket(tx, ticketId, { assigneeId: ticket.assigneeId ?? staffId, updatedAt: now });
      await this.audit.record(tx, {
        action: 'added note to ticket',
        entityType: 'ticket',
        entityId: ticketId,
        entityLabel: labelOf(ticket),
        after: { messageId: message.id, fileIds: ids },
      });
      // The source renders a note for staff only: no requester stream ever gets it.
      this.events.message(ticketId, message.id);
      return toMessageView({ message, authorName: staffName }, files);
    });
  }
}
