// HTTP controller of the storefront support routes (map domain J, stage 17): open a ticket, read it, write on it, rate it. Thin: the rules
// live in StoreTicketService. The token routes read the ticket id the capability guard resolved.
import { Body, Controller, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, type CapabilityGrant, type Principal } from '../../identity';
import { StoreTicketService } from '../application/store-ticket.service';
import {
  openStoreTicket,
  rateStoreTicket,
  showStoreTicket,
  writeOnStoreTicket,
} from '../contracts/store-tickets.contracts';

/** The ticket id the capability guard found; a handler behind a `ticket-token` route always has one. */
function ticketIdOf(principal: Principal | undefined): CapabilityGrant['id'] {
  if (principal?.kind !== 'capability' || principal.access !== 'ticket-token') throw new AppError('NOT_FOUND');
  return principal.resourceId;
}

/** The answers hold the ticket token or sit behind it: nothing may keep a copy (ALIGNMENT § 6). */
const NO_STORE = 'no-store';

/**
 * The storefront support routes.
 *
 * Why: a visitor with no account opens a ticket from the order or contact page and follows it by the link in the receipt email
 * (scenario b2c-ticket steps 1, 6 and 8). The anti-bot check, the per-IP limit and the token lookup limit run before these.
 *
 * @route POST /store/v1/tickets
 * @route GET /store/v1/tickets/:token
 * @route POST /store/v1/tickets/:token/messages
 * @route POST /store/v1/tickets/:token/csat
 */
@Controller()
export class StoreTicketsController {
  constructor(private readonly tickets: StoreTicketService) {}

  /**
   * Opens a ticket.
   *
   * @param body the subject, message and who writes
   * @param reply the reply, for the cache header
   * @returns the new ticket; its token is in the answer only when the order's tracking token was given (the email path gets the token in
   *   the receipt email instead)
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) when the email address already opened 3 tickets in the last hour
   * @route POST /store/v1/tickets
   */
  @Route(openStoreTicket)
  open(
    @Body() body: BodyOf<typeof openStoreTicket>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof openStoreTicket>> {
    reply.header('cache-control', NO_STORE);
    return this.tickets.open(body);
  }

  /**
   * Reads a ticket.
   *
   * @param principal the holder of the ticket token
   * @param reply the reply, for the cache header
   * @returns the ticket and its public messages
   * @route GET /store/v1/tickets/:token
   */
  @Route(showStoreTicket)
  show(
    @CurrentPrincipal() principal: Principal | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof showStoreTicket>> {
    reply.header('cache-control', NO_STORE);
    return this.tickets.show(ticketIdOf(principal));
  }

  /**
   * Writes on a ticket.
   *
   * @param principal the holder of the ticket token
   * @param body the text
   * @param reply the reply, for the cache header
   * @returns the new message
   * @route POST /store/v1/tickets/:token/messages
   */
  @Route(writeOnStoreTicket)
  write(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof writeOnStoreTicket>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof writeOnStoreTicket>> {
    reply.header('cache-control', NO_STORE);
    return this.tickets.write(ticketIdOf(principal), body.body);
  }

  /**
   * Rates a resolved ticket.
   *
   * @param principal the holder of the ticket token
   * @param body the rating
   * @param reply the reply, for the cache header
   * @returns the ticket after the rating
   * @route POST /store/v1/tickets/:token/csat
   */
  @Route(rateStoreTicket)
  rate(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof rateStoreTicket>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof rateStoreTicket>> {
    reply.header('cache-control', NO_STORE);
    return this.tickets.rate(ticketIdOf(principal), body.score);
  }
}
