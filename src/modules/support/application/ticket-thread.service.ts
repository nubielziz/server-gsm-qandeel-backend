// TicketThreadService: the one place a requester's message is written (feature 28, plan § 3.3): from the ticket page (the link's holder)
// and, in slice B2, from the merchant portal and the signed-in customer. The status and reply-target rules of feature 17 are unchanged.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { ticketUploadArea } from '../domain/attachment-rules';
import { PRIORITY_TARGET_MS } from '../domain/ticket-sla';
import { findTicket, insertMessage, lockTicket, updateTicket } from '../infra/ticket.repository';
import { isLockedForRequester, requesterLockedError } from './requester-lock';
import { TicketAttachmentService, requesterOwner } from './ticket-attachment.service';
import { TicketEvents } from './ticket-events';
import { type StoreMessageView, toStoreMessage } from './ticket-views';

/**
 * Who writes on a ticket: the holder of its link (whoever requested it), or a signed-in requester who must own it.
 *
 * Why: a ticket link is the whole credential of the ticket page (decision 010); a merchant and a signed-in customer address their tickets
 * by id, and a ticket of someone else is `404` (plan § 2, rule 7).
 */
export type ThreadWriter =
  { readonly via: 'link' } | { readonly via: 'account'; readonly type: 'customer' | 'client'; readonly id: number };

/** A requester's message: the text (may be `''` with a file) and the ids of the files it carries. */
export interface ThreadMessageInput {
  readonly body: string;
  readonly fileIds?: readonly number[] | undefined;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'This link is not valid.' });

/**
 * Writes a requester's message on a ticket.
 *
 * Why: scenario b2c-ticket step 6 (feature 17), moved here so every surface of a requester shares one path (feature 28). A message on a
 * ticket that waited on the customer makes it `open`, on a `new` or `open` ticket leaves the status as it is; the reply target restarts
 * from it. A resolved ticket is closed for its requester (B220, owner decision 2026-11-15, replacing ANSWERS support Q8): the message is
 * refused with `409 TICKET_RESOLVED` and nothing is written, rung or mailed; staff reopen the ticket (`PATCH` resolved to open) and the
 * requester can write again. It records `last_requester_message_id` (staff's `hasUnread`), attaches the
 * requester's own files (checked in the same transaction; through the link only the files uploaded on this ticket) and rings the
 * doorbell after the commit, so staff see it at once. One ticket takes at most 20 requester messages a minute (limiter
 * `ticket-message`), so one open page cannot flood the inbox.
 *
 * Side effects: counts a point of `ticket-message` on the cache Redis (not for a resolved ticket); inserts a `ticket_messages` row and
 * updates `support_tickets` in one transaction (the ticket row locked); rings `ticket message` after the commit.
 *
 * @see POST /store/v1/tickets/:token/messages, POST /client/tickets/:id/messages
 */
@Injectable()
export class TicketThreadService {
  constructor(
    private readonly db: DbService,
    private readonly attachments: TicketAttachmentService,
    private readonly events: TicketEvents,
    private readonly limits: RateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Adds the requester's message.
   *
   * @param ticketId the ticket (the one the link opened, or the id of the route)
   * @param writer the link's holder, or the signed-in requester who must own the ticket
   * @param input the text and the file ids
   * @returns the new message as the requester reads it
   * @throws {AppError} `NOT_FOUND` (no such ticket, or not the writer's); `TICKET_RESOLVED` (409: the ticket is resolved, so it is
   *   closed for its requester); `RATE_LIMITED` (429, `Retry-After`) from the 21st message of a ticket in a minute;
   *   `VALIDATION_FAILED` (422 on `fileIds`)
   */
  async write(ticketId: number, writer: ThreadWriter, input: ThreadMessageInput): Promise<StoreMessageView> {
    const found = await findTicket(this.db.db, ticketId);
    if (!found || !owns(found, writer)) throw notFound();
    // Refused before the limiter, so a closed ticket costs nobody a point; the locked read below is the one that decides.
    if (isLockedForRequester(found)) throw requesterLockedError();
    // Counted after the ownership check, so nobody can use up the budget of a ticket that is not theirs.
    await this.limits.enforce('ticket-message', String(ticketId));
    return this.db.runInTransaction(async ({ tx }) => {
      const ticket = await lockTicket(tx, ticketId);
      if (!ticket || !owns(ticket, writer)) throw notFound();
      // Staff may have resolved the ticket since the first read: the status is judged on the locked row (B220).
      if (isLockedForRequester(ticket)) throw requesterLockedError();
      // A link's holder attaches only the uploads of this ticket (the link must not reach the customer's other files); a signed-in
      // requester any upload of their own.
      const onlyArea = writer.via === 'link' ? ticketUploadArea(ticketId) : undefined;
      const { ids, files } = await this.attachments.attach(tx, requesterOwner(ticket), input.fileIds, onlyArea);
      const now = this.clock.now();
      const message = await insertMessage(tx, {
        ticketId,
        authorType: ticket.requesterType,
        authorId: ticket.requesterId,
        body: input.body,
        isInternal: false,
        fileIds: ids,
        createdAt: now,
      });
      // `new` stays new (nobody has picked it up); a waiting ticket is open again. A resolved one never gets here (B220).
      await updateTicket(tx, ticketId, {
        ...(ticket.status === 'pending_customer' ? { status: 'open' as const } : {}),
        slaDueAt: new Date(now.getTime() + PRIORITY_TARGET_MS[ticket.priority]),
        lastRequesterMessageId: message.id,
        updatedAt: now,
      });
      this.events.message(ticketId, message.id);
      return toStoreMessage(message, files);
    });
  }
}

/** Whether the writer may write on the ticket: the link's holder always (the token is the credential), an account only on its own. */
function owns(ticket: { readonly requesterType: string; readonly requesterId: number }, writer: ThreadWriter): boolean {
  return writer.via === 'link' || (ticket.requesterType === writer.type && ticket.requesterId === writer.id);
}
