// MyTicketsService: what a signed-in storefront customer does with their own support tickets (feature 28, slice B2, rule 6): list them and
// open one without Turnstile. The ticket page and its chat stay the token routes (StoreTicketService, TicketThreadService).
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { DbService } from '../../../infra/db';
import { type AccountSortField, listAccountTickets } from '../infra/account-ticket.repository';
import { AccountTicketOpener, type OpenAccountTicketInput } from './account-ticket-opener';
import { type MyTicketRowView, toMyTicketRow } from './account-ticket-views';
import { type StoreTicketView, toStoreTicket } from './ticket-views';

/**
 * Lists and opens a signed-in customer's tickets.
 *
 * Why: B217 and rule 6: a customer's tickets are those whose requester is that customer (tickets they filed as a guest with the same
 * address included, because the address belongs to the customer who owns it); each row hands out the ticket's link token and the page stays
 * the token page, so no new credential exists. A signed-in customer opens a ticket without Turnstile and gets the token at once (5 an hour).
 * Every id comes from the session: a customer reads and opens only their own.
 *
 * Side effects: reads `support_tickets` and `ticket_messages`; opening writes through {@link AccountTicketOpener}.
 *
 * @see GET /store/v1/me/tickets, POST /store/v1/me/tickets
 */
@Injectable()
export class MyTicketsService {
  constructor(
    private readonly db: DbService,
    private readonly opener: AccountTicketOpener,
  ) {}

  /**
   * Lists the customer's tickets.
   *
   * @param customerId the signed-in customer
   * @param query the parsed list request (`updatedAt` or `createdAt` sort, `status` filter, at most 50 a page)
   * @returns the rows, each with its link token, and the exact total
   */
  async list(
    customerId: number,
    query: ParsedListQuery<AccountSortField>,
  ): Promise<{ rows: MyTicketRowView[]; total: number }> {
    const { rows, total } = await listAccountTickets(this.db.db, { type: 'customer', id: customerId }, query);
    // The query leaves out tickets without a token (an erasure cleared it); the check narrows the type.
    return {
      rows: rows.flatMap((row) => (row.ticket.token === null ? [] : [toMyTicketRow(row, row.ticket.token)])),
      total,
    };
  }

  /**
   * Opens a ticket for the customer.
   *
   * @param customerId the signed-in customer
   * @param input the subject, the first message, the category, the order and the files
   * @returns the new ticket as the customer reads it, with its link token
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) from the 6th ticket in an hour; `VALIDATION_FAILED` (422 on `orderId`:
   *   `unknown_order`; on `fileIds`)
   */
  async open(customerId: number, input: OpenAccountTicketInput): Promise<StoreTicketView & { token: string }> {
    const { ticket, message, files } = await this.opener.open({ type: 'customer', id: customerId }, input);
    // A customer's ticket always gets a token in the opener; the check is the invariant, not a branch.
    if (ticket.token === null) throw new Error('A customer ticket was opened without a link token.');
    return { ...toStoreTicket(ticket, [{ message, authorName: '' }], files), token: ticket.token };
  }
}
