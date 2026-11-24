// HTTP controller of a signed-in retail account's own tickets (feature 28, slice B2, routes beyond the map: scripts/map-additions/28b.mjs):
// the list and opening a ticket from the account. Thin: the rules live in MyTicketsService. The account id comes from the session only.
import { Body, Controller, Header, Query } from '@nestjs/common';
import { type BodyOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { type AccountPrincipal, CurrentAccount } from '../../identity';
import { MyTicketsService } from '../application/my-tickets.service';
import { listMyTickets, openMyTicket } from '../contracts/my-tickets.contracts';

/**
 * The signed-in retail account's ticket routes.
 *
 * Why: B217 and rule 6: a retail account sees the tickets it opened (each row hands out the token of its page) and opens one without
 * Turnstile; a merchant rank has the portal's routes instead (the rank gate answers 403 `RANK_NOT_ALLOWED`). Both answers hold ticket
 * tokens, so nothing may keep a copy (`Cache-Control: no-store`).
 *
 * @route GET /store/v1/me/tickets
 * @route POST /store/v1/me/tickets
 */
@Controller()
export class MyTicketsController {
  constructor(private readonly tickets: MyTicketsService) {}

  /**
   * Lists the account's tickets.
   *
   * @param account the signed-in account (a retail rank)
   * @param query the parsed list request
   * @returns the rows and their total
   * @route GET /store/v1/me/tickets
   */
  @Route(listMyTickets)
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof listMyTickets>,
  ): Promise<ResultOf<typeof listMyTickets>> {
    return this.tickets.list(account.accountId, query);
  }

  /**
   * Opens a ticket.
   *
   * @param account the signed-in account (a retail rank)
   * @param body the subject, the first message, the category, the order and the files
   * @returns the new ticket with its link token
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) from the 6th ticket in an hour
   * @route POST /store/v1/me/tickets
   */
  @Route(openMyTicket)
  @Header('Cache-Control', 'no-store')
  open(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof openMyTicket>,
  ): Promise<ResultOf<typeof openMyTicket>> {
    return this.tickets.open(account.accountId, body);
  }
}
