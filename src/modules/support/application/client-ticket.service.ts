// ClientTicketService: what a signed-in merchant does with their support tickets in the portal (feature 28, slice B2, rule 7): list, open,
// read the conversation, write, mark read, and download an attachment. Every route starts by checking that the ticket is theirs.
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { type AccountSortField, findOwnedTicket, listAccountTickets } from '../infra/account-ticket.repository';
import { listMessageRows } from '../infra/ticket.repository';
import { AccountTicketOpener, type OpenAccountTicketInput } from './account-ticket-opener';
import {
  type ClientTicketRowView,
  type ClientTicketView,
  toClientTicket,
  toClientTicketRow,
} from './account-ticket-views';
import { TicketAttachmentService } from './ticket-attachment.service';
import { TicketReadService } from './ticket-read.service';
import { TicketThreadService, type ThreadMessageInput } from './ticket-thread.service';
import { type StoreMessageView } from './ticket-views';

/**
 * The merchant's side of the support chat.
 *
 * Why: B217 and rule 7: merchants had no ticket route at all. A merchant's ticket has no link token: the session is the credential and the
 * routes take the ticket id, and a ticket of another merchant (or an unknown id) is `404`, never `403`, so ids cannot be probed. A merchant
 * waiting for approval may use all of it (B153; the route contracts say `pendingMerchant: 'allow'`), a suspended one never gets here (the
 * session guard refuses it). The merchant reads the public thread (no note, no system message, no staff name); its messages, read marks
 * and downloads go through the chat engine's services, which the ticket page of a customer uses too, so both requesters behave alike.
 *
 * Side effects: reads `support_tickets`, `ticket_messages` and `files`; the writes are the engine's (a message, a seen mark, the
 * doorbells) and {@link AccountTicketOpener}'s.
 *
 * @see GET/POST /client/tickets, GET /client/tickets/:id, POST /client/tickets/:id/messages|read, GET /client/tickets/:id/files/:fileId
 */
@Injectable()
export class ClientTicketService {
  constructor(
    private readonly db: DbService,
    private readonly opener: AccountTicketOpener,
    private readonly thread: TicketThreadService,
    private readonly reads: TicketReadService,
    private readonly attachments: TicketAttachmentService,
  ) {}

  /**
   * Lists the merchant's tickets.
   *
   * @param clientId the signed-in merchant
   * @param query the parsed list request (`updatedAt` or `createdAt` sort, `status` filter, at most 50 a page)
   * @returns the rows (with the ticket id and no link token) and the exact total
   */
  async list(
    clientId: number,
    query: ParsedListQuery<AccountSortField>,
  ): Promise<{ rows: ClientTicketRowView[]; total: number }> {
    const { rows, total } = await listAccountTickets(this.db.db, { type: 'client', id: clientId }, query);
    return { rows: rows.map(toClientTicketRow), total };
  }

  /**
   * Opens a ticket for the merchant.
   *
   * @param clientId the signed-in merchant
   * @param input the subject, the first message, the category, the order and the files
   * @returns the new ticket with its conversation
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) from the 6th ticket in an hour; `VALIDATION_FAILED` (422 on `orderId`:
   *   `unknown_order`; on `fileIds`)
   */
  async open(clientId: number, input: OpenAccountTicketInput): Promise<ClientTicketView> {
    const { ticket, message, files } = await this.opener.open({ type: 'client', id: clientId }, input);
    return toClientTicket(ticket, [{ message, authorName: '' }], files);
  }

  /**
   * Reads one of the merchant's tickets with its public conversation.
   *
   * @param clientId the signed-in merchant
   * @param ticketId the ticket of the route
   * @returns the ticket, its public messages and their attachments
   * @throws {AppError} `NOT_FOUND` for an unknown ticket or another merchant's
   */
  async show(clientId: number, ticketId: number): Promise<ClientTicketView> {
    const ticket = await this.owned(clientId, ticketId);
    const messages = await listMessageRows(this.db.db, ticketId, true);
    const files = await this.attachments.filesOf(
      this.db.db,
      messages.map((row) => row.message),
    );
    return toClientTicket(ticket, messages, files);
  }

  /**
   * Adds the merchant's message.
   *
   * @param clientId the signed-in merchant
   * @param ticketId the ticket of the route
   * @param input the text (may be `''` with a file) and the ids of the files it carries
   * @returns the new message
   * @throws {AppError} `NOT_FOUND`; `TICKET_RESOLVED` (409: the ticket is resolved, nothing is written); `RATE_LIMITED` (the 21st message of
   *   a ticket in a minute); `VALIDATION_FAILED` (422 on `fileIds`)
   */
  async write(clientId: number, ticketId: number, input: ThreadMessageInput): Promise<StoreMessageView> {
    await this.owned(clientId, ticketId);
    return this.thread.write(ticketId, { via: 'account', type: 'client', id: clientId }, input);
  }

  /**
   * Moves the merchant's seen mark.
   *
   * @param clientId the signed-in merchant
   * @param ticketId the ticket of the route
   * @param upToMessageId the newest support message the thread shows
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `upToMessageId`, `unknown_message`)
   */
  async read(clientId: number, ticketId: number, upToMessageId: number): Promise<void> {
    await this.owned(clientId, ticketId);
    await this.reads.mark(ticketId, 'requester', upToMessageId);
  }

  /**
   * Makes the download link of an attachment of the merchant's ticket.
   *
   * @param clientId the signed-in merchant
   * @param ticketId the ticket of the route
   * @param fileId the attachment
   * @returns the presigned link (5 minutes, attachment disposition)
   * @throws {AppError} `NOT_FOUND` for a ticket that is not the merchant's, or a file that is in no public message of it
   */
  async fileLink(clientId: number, ticketId: number, fileId: number): Promise<string> {
    await this.owned(clientId, ticketId);
    return this.attachments.linkFor(ticketId, 'requester', fileId);
  }

  /** The merchant's ticket; any other id reads as unknown. */
  private async owned(clientId: number, ticketId: number) {
    const ticket = await findOwnedTicket(this.db.db, { type: 'client', id: clientId }, ticketId);
    if (!ticket) throw new AppError('NOT_FOUND', { detail: 'No ticket has this id.' });
    return ticket;
  }
}
