// HTTP controller of a merchant's support tickets in the portal (feature 28, slice B2, routes beyond the map: scripts/map-additions/28b.mjs):
// list, open, the conversation, reply, read mark, typing and the attachment download. Thin: the rules live in ClientTicketService. The
// merchant id comes from the session only.
import { Body, Controller, Header, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentMerchant, type MerchantPrincipal } from '../../identity';
import { ClientTicketService } from '../application/client-ticket.service';
import {
  clientTicketTyping,
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
 * Why: B217 and rule 7: merchants had no ticket route. A ticket of another merchant and an unknown id are `404`. A merchant waiting for
 * approval may call all of them (`pendingMerchant: 'allow'`, B153); a suspended one is refused by the session guard.
 *
 * @route GET /client/tickets
 * @route POST /client/tickets
 * @route GET /client/tickets/:id
 * @route POST /client/tickets/:id/messages
 * @route POST /client/tickets/:id/read
 * @route POST /client/tickets/:id/typing
 * @route GET /client/tickets/:id/files/:fileId
 */
@Controller()
export class ClientTicketsController {
  constructor(private readonly tickets: ClientTicketService) {}

  /**
   * Lists the merchant's tickets.
   *
   * @param merchant the signed-in merchant
   * @param query the parsed list request
   * @returns the rows and their total
   * @route GET /client/tickets
   */
  @Route(listClientTickets)
  @Header('Cache-Control', NO_STORE)
  list(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Query() query: QueryOf<typeof listClientTickets>,
  ): Promise<ResultOf<typeof listClientTickets>> {
    return this.tickets.list(merchant.clientId, query);
  }

  /**
   * Opens a ticket.
   *
   * @param merchant the signed-in merchant
   * @param body the subject, the first message, the category, the order and the files
   * @returns the new ticket with its conversation
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) from the 6th ticket in an hour
   * @route POST /client/tickets
   */
  @Route(openClientTicket)
  @Header('Cache-Control', NO_STORE)
  open(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof openClientTicket>,
  ): Promise<ResultOf<typeof openClientTicket>> {
    return this.tickets.open(merchant.clientId, body);
  }

  /**
   * Reads a ticket with its public conversation.
   *
   * @param merchant the signed-in merchant
   * @param params the ticket id
   * @returns the ticket and its public messages
   * @throws {AppError} `NOT_FOUND` for another merchant's ticket
   * @route GET /client/tickets/:id
   */
  @Route(showClientTicket)
  @Header('Cache-Control', NO_STORE)
  show(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof showClientTicket>,
  ): Promise<ResultOf<typeof showClientTicket>> {
    return this.tickets.show(merchant.clientId, params.id);
  }

  /**
   * Writes on a ticket.
   *
   * @param merchant the signed-in merchant
   * @param params the ticket id
   * @param body the text and the ids of the files it carries
   * @returns the new message
   * @throws {AppError} `NOT_FOUND`; `RATE_LIMITED` (the 21st message of a ticket in a minute)
   * @route POST /client/tickets/:id/messages
   */
  @Route(writeOnClientTicket)
  @Header('Cache-Control', NO_STORE)
  write(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof writeOnClientTicket>,
    @Body() body: BodyOf<typeof writeOnClientTicket>,
  ): Promise<ResultOf<typeof writeOnClientTicket>> {
    return this.tickets.write(merchant.clientId, params.id, body);
  }

  /**
   * Moves the merchant's seen mark.
   *
   * @param merchant the signed-in merchant
   * @param params the ticket id
   * @param body the newest support message the thread shows
   * @returns nothing (204)
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `upToMessageId`)
   * @route POST /client/tickets/:id/read
   */
  @Route(markClientTicketRead)
  @Header('Cache-Control', NO_STORE)
  async read(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof markClientTicketRead>,
    @Body() body: BodyOf<typeof markClientTicketRead>,
  ): Promise<void> {
    await this.tickets.read(merchant.clientId, params.id, body.upToMessageId);
  }

  /**
   * Records that the merchant is typing.
   *
   * @param merchant the signed-in merchant
   * @param params the ticket id
   * @returns nothing (204), whatever happened to the ping
   * @throws {AppError} `NOT_FOUND` for another merchant's ticket
   * @route POST /client/tickets/:id/typing
   */
  @Route(clientTicketTyping)
  @Header('Cache-Control', NO_STORE)
  async typing(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof clientTicketTyping>,
  ): Promise<void> {
    await this.tickets.ping(merchant.clientId, params.id);
  }

  /**
   * Redirects the merchant to an attachment of a public message of its ticket.
   *
   * @param merchant the signed-in merchant
   * @param params the ticket and the file id
   * @param reply the reply, to set `Location`
   * @throws {AppError} `NOT_FOUND` for another merchant's ticket or a file that is in no public message of it
   * @route GET /client/tickets/:id/files/:fileId
   */
  @Route(openClientTicketFile)
  async download(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof openClientTicketFile>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const url = await this.tickets.fileLink(merchant.clientId, params.id, params.fileId);
    reply.header('location', url).header('cache-control', NO_STORE);
  }
}
