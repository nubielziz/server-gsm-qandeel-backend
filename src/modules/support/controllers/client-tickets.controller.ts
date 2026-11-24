// HTTP controller of the support tickets of an account of a merchant rank, in the portal (feature 28, slice B2, routes beyond the map:
// scripts/map-additions/28b.mjs): list, open, the conversation, reply, read mark and the attachment download. Thin: the rules live in
// ClientTicketService. The account id comes from the session only.
import { Body, Controller, Header, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { type AccountPrincipal, CurrentAccount } from '../../identity';
import { ClientTicketService } from '../application/client-ticket.service';
import {
  listClientTickets,
  markClientTicketRead,
  openClientTicket,
  openClientTicketFile,
  showClientTicket,
  writeOnClientTicket,
} from '../contracts/client-tickets.contracts';

/** The answers sit behind the session and hold what only the merchant may read: nothing may keep a copy. */
const NO_STORE = 'no-store';

/**
 * The merchant portal's ticket routes.
 *
 * Why: B217 and rule 7: a merchant rank has its tickets in the portal (a retail rank uses the shop's routes). A ticket of another account
 * and an unknown id are `404`, and so is a ticket whose requester address is not proven yet; a suspended account is refused by the
 * session guard.
 *
 * @route GET /client/tickets
 * @route POST /client/tickets
 * @route GET /client/tickets/:id
 * @route POST /client/tickets/:id/messages
 * @route POST /client/tickets/:id/read
 * @route GET /client/tickets/:id/files/:fileId
 */
@Controller()
export class ClientTicketsController {
  constructor(private readonly tickets: ClientTicketService) {}

  /**
   * Lists the merchant's tickets.
   *
   * @param account the signed-in account (a merchant rank)
   * @param query the parsed list request
   * @returns the rows and their total
   * @route GET /client/tickets
   */
  @Route(listClientTickets)
  @Header('Cache-Control', NO_STORE)
  list(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof listClientTickets>,
  ): Promise<ResultOf<typeof listClientTickets>> {
    return this.tickets.list(account.accountId, query);
  }

  /**
   * Opens a ticket.
   *
   * @param account the signed-in account (a merchant rank)
   * @param body the subject, the first message, the category, the order and the files
   * @returns the new ticket with its conversation
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) from the 6th ticket in an hour
   * @route POST /client/tickets
   */
  @Route(openClientTicket)
  @Header('Cache-Control', NO_STORE)
  open(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof openClientTicket>,
  ): Promise<ResultOf<typeof openClientTicket>> {
    return this.tickets.open(account.accountId, body);
  }

  /**
   * Reads a ticket with its public conversation.
   *
   * @param account the signed-in account (a merchant rank)
   * @param params the ticket id
   * @returns the ticket and its public messages
   * @throws {AppError} `NOT_FOUND` for another merchant's ticket
   * @route GET /client/tickets/:id
   */
  @Route(showClientTicket)
  @Header('Cache-Control', NO_STORE)
  show(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof showClientTicket>,
  ): Promise<ResultOf<typeof showClientTicket>> {
    return this.tickets.show(account.accountId, params.id);
  }

  /**
   * Writes on a ticket.
   *
   * @param account the signed-in account (a merchant rank)
   * @param params the ticket id
   * @param body the text and the ids of the files it carries
   * @returns the new message
   * @throws {AppError} `NOT_FOUND`; `RATE_LIMITED` (the 21st message of a ticket in a minute)
   * @route POST /client/tickets/:id/messages
   */
  @Route(writeOnClientTicket)
  @Header('Cache-Control', NO_STORE)
  write(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof writeOnClientTicket>,
    @Body() body: BodyOf<typeof writeOnClientTicket>,
  ): Promise<ResultOf<typeof writeOnClientTicket>> {
    return this.tickets.write(account.accountId, params.id, body);
  }

  /**
   * Moves the merchant's seen mark.
   *
   * @param account the signed-in account (a merchant rank)
   * @param params the ticket id
   * @param body the newest support message the thread shows
   * @returns nothing (204)
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `upToMessageId`)
   * @route POST /client/tickets/:id/read
   */
  @Route(markClientTicketRead)
  @Header('Cache-Control', NO_STORE)
  async read(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof markClientTicketRead>,
    @Body() body: BodyOf<typeof markClientTicketRead>,
  ): Promise<void> {
    await this.tickets.read(account.accountId, params.id, body.upToMessageId);
  }

  /**
   * Redirects the merchant to an attachment of a public message of its ticket.
   *
   * @param account the signed-in account (a merchant rank)
   * @param params the ticket and the file id
   * @param reply the reply, to set `Location`
   * @throws {AppError} `NOT_FOUND` for another merchant's ticket or a file that is in no public message of it
   * @route GET /client/tickets/:id/files/:fileId
   */
  @Route(openClientTicketFile)
  async download(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof openClientTicketFile>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const url = await this.tickets.fileLink(account.accountId, params.id, params.fileId);
    reply.header('location', url).header('cache-control', NO_STORE);
  }
}
