// MyTicketsService: what a signed-in retail account does with its own support tickets (feature 28, slice B2, rule 6; decision 064): list them
// and open one without Turnstile. The ticket page and its chat stay the token routes (StoreTicketService, TicketThreadService).
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { CapabilityTokenVault } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { type AccountSortField, listAccountTickets } from '../infra/account-ticket.repository';
import { AccountTicketOpener, type OpenAccountTicketInput } from './account-ticket-opener';
import { type MyTicketRowView, toMyTicketRow } from './account-ticket-views';
import { type StoreTicketView, toStoreTicket } from './ticket-views';

/**
 * Lists and opens a signed-in retail account's tickets.
 *
 * Why: B217, rule 6 and decision 064: an account's tickets are those whose requester is that account (tickets filed as a guest with the same
 * address included once the address was proven, because the address belongs to the account that owns it, decision 053); each row hands out
 * the ticket's link token and the page stays the token page, so no new credential exists (the token is revealed from its encrypted copy,
 * decision 054). A signed-in account opens a ticket without Turnstile and gets the token at once (5 an hour). Every id comes from the
 * session: an account reads and opens only its own.
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
    private readonly vault: CapabilityTokenVault,
  ) {}

  /**
   * Lists the account's tickets.
   *
   * @param accountId the signed-in account (a retail rank)
   * @param query the parsed list request (`updatedAt` or `createdAt` sort, `status` filter, at most 50 a page)
   * @returns the rows, each with its link token, and the exact total
   */
  async list(
    accountId: number,
    query: ParsedListQuery<AccountSortField>,
  ): Promise<{ rows: MyTicketRowView[]; total: number }> {
    const { rows, total } = await listAccountTickets(this.db.db, { id: accountId, rankKind: 'retail' }, query);
    // The query leaves out tickets without a token (an erasure cleared it); the check narrows the type. Decision 054: the token is
    // revealed from its encrypted copy, or read as issued for a ticket opened before.
    return {
      rows: rows.flatMap((row) => {
        const token = this.vault.reveal('ticket', { enc: row.ticket.tokenEnc, plain: row.ticket.token });
        return token === null ? [] : [toMyTicketRow(row, token)];
      }),
      total,
    };
  }

  /**
   * Opens a ticket for the account.
   *
   * @param accountId the signed-in account (a retail rank)
   * @param input the subject, the first message, the category, the order and the files
   * @returns the new ticket as the account reads it, with its link token
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) from the 6th ticket in an hour; `VALIDATION_FAILED` (422 on `orderId`:
   *   `unknown_order`; on `fileIds`)
   */
  async open(accountId: number, input: OpenAccountTicketInput): Promise<StoreTicketView & { token: string }> {
    const { ticket, message, files } = await this.opener.open({ id: accountId, rankKind: 'retail' }, input);
    // A retail account's ticket always gets a token in the opener; the check is the invariant, not a branch.
    const token = this.vault.reveal('ticket', { enc: ticket.tokenEnc, plain: ticket.token });
    if (token === null) throw new Error('A retail ticket was opened without a link token.');
    return { ...toStoreTicket(ticket, [{ message, authorName: '' }], files), token };
  }
}
