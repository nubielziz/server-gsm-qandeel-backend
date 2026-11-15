// HTTP controller of the console's chat routes on a ticket (feature 28, routes beyond the map: scripts/map-additions/28.mjs): the staff
// side's read mark, typing, the attachment upload and its download. Thin: the rules live in the support services.
import { Body, Controller, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { TicketAttachmentService } from '../application/ticket-attachment.service';
import { TicketReadService } from '../application/ticket-read.service';
import { TicketTypingService } from '../application/ticket-typing.service';
import {
  markSupportTicketRead,
  openSupportTicketFile,
  supportTicketTyping,
  uploadSupportTicketFile,
} from '../contracts/ticket-live.contracts';

/**
 * The console's chat routes of a ticket.
 *
 * Why: feature 28 (rules 2 to 4 and 8): the thread marks the requester's messages seen, a colleague's draft shows as "<name> is
 * replying…" (and a reply's as "Support is typing…" to the requester), and staff attach files to replies and notes and open every file
 * of the ticket.
 *
 * @route POST /admin/support-tickets/:id/read
 * @route POST /admin/support-tickets/:id/typing
 * @route POST /admin/support-tickets/:id/files
 * @route GET /admin/support-tickets/:id/files/:fileId
 */
@Controller()
export class SupportTicketLiveController {
  constructor(
    private readonly reads: TicketReadService,
    private readonly typing: TicketTypingService,
    private readonly attachments: TicketAttachmentService,
  ) {}

  /**
   * Moves the staff side's seen mark.
   *
   * @param params the ticket id
   * @param body the newest requester message the thread shows
   * @returns nothing (204)
   * @route POST /admin/support-tickets/:id/read
   */
  @Route(markSupportTicketRead)
  async read(
    @Param() params: ParamsOf<typeof markSupportTicketRead>,
    @Body() body: BodyOf<typeof markSupportTicketRead>,
  ): Promise<void> {
    await this.reads.mark(params.id, 'staff', body.upToMessageId);
  }

  /**
   * Records that the staff member is typing a reply or a note.
   *
   * @param params the ticket id
   * @param body `reply` or `note`
   * @param staff the signed-in staff member
   * @returns nothing (204)
   * @throws {AppError} `NOT_FOUND` for an unknown ticket
   * @route POST /admin/support-tickets/:id/typing
   */
  @Route(supportTicketTyping)
  async typingPing(
    @Param() params: ParamsOf<typeof supportTicketTyping>,
    @Body() body: BodyOf<typeof supportTicketTyping>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<void> {
    await this.typing.ping(params.id, { by: 'staff', staffId: staff.staffId, mode: body.mode });
  }

  /**
   * Stores an attachment of the staff member for a reply or a note on the ticket.
   *
   * @param params the ticket id
   * @param body the multipart body with the file part
   * @param staff the signed-in staff member
   * @returns the stored file
   * @route POST /admin/support-tickets/:id/files
   */
  @Route(uploadSupportTicketFile)
  upload(
    @Param() params: ParamsOf<typeof uploadSupportTicketFile>,
    @Body() body: BodyOf<typeof uploadSupportTicketFile>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof uploadSupportTicketFile>> {
    return this.attachments.upload(
      params.id,
      { side: 'staff', staffId: staff.staffId },
      { filename: body.file.filename, mime: body.file.mime, data: body.file.data },
    );
  }

  /**
   * Redirects the staff member to an attachment of the ticket.
   *
   * @param params the ticket id and the file id
   * @param reply the reply, to set `Location`
   * @route GET /admin/support-tickets/:id/files/:fileId
   */
  @Route(openSupportTicketFile)
  async open(
    @Param() params: ParamsOf<typeof openSupportTicketFile>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const url = await this.attachments.linkFor(params.id, 'staff', params.fileId);
    reply.header('location', url).header('cache-control', 'no-store');
  }
}
