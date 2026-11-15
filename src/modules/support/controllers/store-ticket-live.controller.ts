// HTTP controller of the ticket page's chat routes (feature 28, routes beyond the map: scripts/map-additions/28.mjs): typing, the read
// mark, the attachment upload and its download. Thin: the rules live in the support services. The token routes read the ticket id the
// capability guard resolved.
import { Body, Controller, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, type CapabilityGrant, type Principal } from '../../identity';
import { TicketAttachmentService } from '../application/ticket-attachment.service';
import { TicketReadService } from '../application/ticket-read.service';
import { TicketTypingService } from '../application/ticket-typing.service';
import {
  openStoreTicketFile,
  storeTicketRead,
  storeTicketTyping,
  uploadStoreTicketFile,
} from '../contracts/ticket-live.contracts';

/** The ticket id the capability guard found; a handler behind a `ticket-token` route always has one. */
function ticketIdOf(principal: Principal | undefined): CapabilityGrant['id'] {
  if (principal?.kind !== 'capability' || principal.access !== 'ticket-token') throw new AppError('NOT_FOUND');
  return principal.resourceId;
}

/** The answers sit behind the ticket token: nothing may keep a copy (ALIGNMENT § 6). */
const NO_STORE = 'no-store';

/**
 * The chat routes of a ticket page.
 *
 * Why: feature 28 (rules 2, 3 and 8): the customer's typing reaches staff, the page marks what it showed as seen, and files go both
 * ways. Typing and read marks count against `ticket-chat`, not the token limit (fact 7 of the plan); the upload against `upload`.
 *
 * @route POST /store/v1/tickets/:token/typing
 * @route POST /store/v1/tickets/:token/read
 * @route POST /store/v1/tickets/:token/files
 * @route GET /store/v1/tickets/:token/files/:fileId
 */
@Controller()
export class StoreTicketLiveController {
  constructor(
    private readonly typing: TicketTypingService,
    private readonly reads: TicketReadService,
    private readonly attachments: TicketAttachmentService,
  ) {}

  /**
   * Records that the customer is typing.
   *
   * @param principal the holder of the ticket token
   * @param reply the reply, for the cache header
   * @returns nothing (204), whatever happened to the ping
   * @route POST /store/v1/tickets/:token/typing
   */
  @Route(storeTicketTyping)
  async typingPing(
    @CurrentPrincipal() principal: Principal | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    reply.header('cache-control', NO_STORE);
    await this.typing.ping(ticketIdOf(principal), { by: 'requester' });
  }

  /**
   * Moves the customer's seen mark.
   *
   * @param principal the holder of the ticket token
   * @param body the newest support message the page shows
   * @param reply the reply, for the cache header
   * @returns nothing (204)
   * @route POST /store/v1/tickets/:token/read
   */
  @Route(storeTicketRead)
  async read(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof storeTicketRead>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    reply.header('cache-control', NO_STORE);
    await this.reads.mark(ticketIdOf(principal), 'requester', body.upToMessageId);
  }

  /**
   * Stores an attachment of the ticket's customer.
   *
   * @param principal the holder of the ticket token
   * @param body the multipart body with the file part
   * @param reply the reply, for the cache header
   * @returns the stored file
   * @route POST /store/v1/tickets/:token/files
   */
  @Route(uploadStoreTicketFile)
  upload(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof uploadStoreTicketFile>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof uploadStoreTicketFile>> {
    reply.header('cache-control', NO_STORE);
    return this.attachments.upload(
      ticketIdOf(principal),
      { side: 'requester' },
      { filename: body.file.filename, mime: body.file.mime, data: body.file.data },
    );
  }

  /**
   * Redirects the customer to an attachment of a public message of the ticket.
   *
   * @param principal the holder of the ticket token
   * @param params the token and the file id
   * @param reply the reply, to set `Location`
   * @route GET /store/v1/tickets/:token/files/:fileId
   */
  @Route(openStoreTicketFile)
  async open(
    @CurrentPrincipal() principal: Principal | undefined,
    @Param() params: ParamsOf<typeof openStoreTicketFile>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const url = await this.attachments.linkFor(ticketIdOf(principal), 'requester', params.fileId);
    reply.header('location', url).header('cache-control', NO_STORE);
  }
}
