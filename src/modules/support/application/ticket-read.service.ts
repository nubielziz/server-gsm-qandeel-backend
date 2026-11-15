// TicketReadService: the seen marks of the support chat (feature 28, rule 3): one mark per side on the ticket, moved forward only by one
// guarded statement, and a doorbell when it moved.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { type TicketSide, canMarkSeen } from '../domain/seen';
import { findMessage, findTicket, markSeen } from '../infra/ticket.repository';
import { TicketEvents } from './ticket-events';

/**
 * Marks a ticket's messages seen by one side.
 *
 * Why: rule 3 (both ways, plan § 9): the requester's mark is the newest public staff message they have seen, staff's the newest
 * requester message any staff member has seen (staff are one party: the requester learns that support saw it, never who). The message
 * must be one the other side wrote on this ticket and the caller may see (a note, a system message, the caller's own message or one of
 * another ticket is `422 unknown_message`, so a mark never reveals that a message exists). The database moves the mark only forward
 * (`coalesce(mark, 0) < upTo`), so two tabs never race; a repeat is a success without a doorbell. A read never touches `updated_at`.
 *
 * Side effects: writes the side's two columns of `support_tickets`; rings `ticket read` when the mark moved.
 */
@Injectable()
export class TicketReadService {
  constructor(
    private readonly db: DbService,
    private readonly events: TicketEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Moves a side's mark to a message.
   *
   * @param ticketId the ticket (the one the link opened, or the id of the route; the caller checked who owns it)
   * @param side `requester` or `staff`
   * @param upToMessageId the newest message of the other side the caller has seen
   * @returns true when the mark moved (a doorbell rings), false for a repeat or an older id
   * @throws {AppError} `NOT_FOUND` for an unknown ticket; `VALIDATION_FAILED` (422 on `upToMessageId`, `unknown_message`)
   */
  async mark(ticketId: number, side: TicketSide, upToMessageId: number): Promise<boolean> {
    if (!(await findTicket(this.db.db, ticketId)))
      throw new AppError('NOT_FOUND', { detail: 'No ticket has this id.' });
    const message = await findMessage(this.db.db, upToMessageId);
    if (!canMarkSeen(side, ticketId, message)) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'upToMessageId', code: 'unknown_message', message: 'This message is not on this ticket.' }],
      });
    }
    const moved = await markSeen(this.db.db, ticketId, side, upToMessageId, this.clock.now());
    // Outside a transaction the doorbell rings at once: the statement has committed.
    if (moved) this.events.read(ticketId, side);
    return moved;
  }
}
