// HTTP controller of the support inbox (map domain J, /admin/support-tickets, stage 17). Thin: the rules live in TicketAdminService and
// TicketConversationService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { TicketAdminService } from '../application/ticket-admin.service';
import { TicketConversationService } from '../application/ticket-conversation.service';
import {
  addSupportTicketNote,
  listSupportTickets,
  replyToSupportTicket,
  showSupportTicket,
  updateSupportTicket,
} from '../contracts/tickets.contracts';

/**
 * The support inbox routes.
 *
 * Why: the console's Support page lists tickets, opens one with its thread, changes it and answers the customer (scenario b2c-ticket
 * steps 3 to 5 and 7).
 *
 * @route GET /admin/support-tickets
 * @route GET /admin/support-tickets/:id
 * @route PATCH /admin/support-tickets/:id
 * @route POST /admin/support-tickets/:id/reply
 * @route POST /admin/support-tickets/:id/note
 */
@Controller()
export class SupportTicketsController {
  constructor(
    private readonly tickets: TicketAdminService,
    private readonly conversation: TicketConversationService,
  ) {}

  /**
   * Lists tickets.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/support-tickets
   */
  @Route(listSupportTickets)
  list(@Query() query: QueryOf<typeof listSupportTickets>): Promise<ResultOf<typeof listSupportTickets>> {
    return this.tickets.list(query);
  }

  /**
   * Shows a ticket with its thread.
   *
   * @param params the ticket id
   * @returns the ticket
   * @route GET /admin/support-tickets/:id
   */
  @Route(showSupportTicket)
  show(@Param() params: ParamsOf<typeof showSupportTicket>): Promise<ResultOf<typeof showSupportTicket>> {
    return this.tickets.show(params.id);
  }

  /**
   * Changes a ticket.
   *
   * @param params the ticket id
   * @param body the keys to change
   * @param staff the signed-in staff member
   * @returns the updated row
   * @route PATCH /admin/support-tickets/:id
   */
  @Route(updateSupportTicket)
  update(
    @Param() params: ParamsOf<typeof updateSupportTicket>,
    @Body() body: BodyOf<typeof updateSupportTicket>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof updateSupportTicket>> {
    return this.tickets.update(params.id, body, staff.staffId);
  }

  /**
   * Replies to the customer.
   *
   * @param params the ticket id
   * @param body the text and channel
   * @param staff the signed-in staff member
   * @returns the new message
   * @route POST /admin/support-tickets/:id/reply
   */
  @Route(replyToSupportTicket)
  reply(
    @Param() params: ParamsOf<typeof replyToSupportTicket>,
    @Body() body: BodyOf<typeof replyToSupportTicket>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof replyToSupportTicket>> {
    return this.conversation.reply(params.id, body, staff.staffId);
  }

  /**
   * Adds an internal note.
   *
   * @param params the ticket id
   * @param body the text
   * @param staff the signed-in staff member
   * @returns the new message
   * @route POST /admin/support-tickets/:id/note
   */
  @Route(addSupportTicketNote)
  note(
    @Param() params: ParamsOf<typeof addSupportTicketNote>,
    @Body() body: BodyOf<typeof addSupportTicketNote>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof addSupportTicketNote>> {
    return this.conversation.note(params.id, body, staff.staffId);
  }
}
