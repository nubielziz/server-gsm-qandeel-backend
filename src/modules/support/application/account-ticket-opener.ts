// AccountTicketOpener: the one way a signed-in customer or merchant opens a ticket (feature 28, slice B2, routes 7 and 9). MyTicketsService
// and ClientTicketService call it; the visitor's public form (no session, Turnstile, an email or an order link) stays StoreTicketService.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import type { SupportTicket, TicketCategory, TicketMessage } from '../db/schema';
import { PRIORITY_TARGET_MS, defaultPriority } from '../domain/ticket-sla';
import type { TicketOwner } from '../infra/account-ticket.repository';
import { orderBelongsTo } from '../infra/support-foreign-reads';
import { insertMessage, insertTicket, updateTicket } from '../infra/ticket.repository';
import { TicketAttachmentService } from './ticket-attachment.service';
import { TicketEvents } from './ticket-events';
import { TicketMailOutbox } from './ticket-mail-outbox';
import type { AttachmentFiles } from './ticket-views';

/** What an account route hands in to open a ticket. */
export interface OpenAccountTicketInput {
  readonly subject: string;
  /** The first message; `''` only with `fileIds`. */
  readonly message: string;
  readonly category?: TicketCategory | undefined;
  readonly orderId?: number | undefined;
  readonly fileIds?: readonly number[] | undefined;
}

/** A ticket just opened, with its first message and that message's files. */
export interface OpenedAccountTicket {
  readonly ticket: SupportTicket;
  readonly message: TicketMessage;
  readonly files: AttachmentFiles;
}

/**
 * Opens a ticket for a signed-in customer or merchant.
 *
 * Why: feature 28, rules 6 and 7 (B217): a signed-in customer opens a ticket without Turnstile and gets the link token at once (the
 * session already proves who they are, unlike the email path of the public form); a merchant gets a ticket without a token (the session
 * is the credential). The ticket starts `new` with the priority of its category and a reply target, the first message is the requester's
 * newest (staff's `hasUnread`), and staff see it at once through `ticket updated`. `orderId` must be an order of the caller. Without
 * Turnstile the route could be used to flood the inbox, so an account opens 5 tickets an hour (limiter `ticket-open`, decision 021),
 * counted before anything is read or written so probing order ids is limited too.
 *
 * Side effects: counts a point of `ticket-open` on the cache Redis (`customer:<id>` or `client:<id>`, one hour); inserts the
 * `support_tickets` and `ticket_messages` rows, and for a customer the receipt's `support.ticket_mail` outbox event, in one transaction
 * (a merchant gets no receipt: its ticket has no page to link); rings `ticket updated` after the commit.
 *
 * @see POST /store/v1/me/tickets, POST /client/tickets
 */
@Injectable()
export class AccountTicketOpener {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly mail: TicketMailOutbox,
    private readonly limits: RateLimitService,
    private readonly attachments: TicketAttachmentService,
    private readonly events: TicketEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Opens the ticket.
   *
   * @param owner the signed-in customer or merchant (from the session, never from the body)
   * @param input the subject, the first message and what it carries
   * @returns the stored ticket, its first message and the message's files
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) from the 6th ticket of an account in an hour; `VALIDATION_FAILED` (422 on
   *   `orderId`: `unknown_order`; on `fileIds`: `unknown_file`, `not_yours`, `type`, `too_large`)
   */
  async open(owner: TicketOwner, input: OpenAccountTicketInput): Promise<OpenedAccountTicket> {
    await this.limits.enforce('ticket-open', `${owner.type}:${owner.id}`);
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const now = this.clock.now();
      if (input.orderId !== undefined && !(await orderBelongsTo(tx, owner, input.orderId))) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            {
              field: 'orderId',
              code: 'unknown_order',
              message: 'Choose one of your own orders.',
            } satisfies FieldError,
          ],
        });
      }
      const { ids, files } = await this.attachments.attach(tx, owner, input.fileIds);
      const category = input.category ?? 'other';
      const priority = defaultPriority(category);
      const ticket = await insertTicket(tx, {
        subject: input.subject,
        channel: 'web',
        requesterType: owner.type,
        requesterId: owner.id,
        orderId: input.orderId ?? null,
        category,
        priority,
        status: 'new',
        // The requester's first message is the one a reply is awaited for.
        slaDueAt: new Date(now.getTime() + PRIORITY_TARGET_MS[priority]),
        // Only a customer's ticket has a page; the 128-bit token is stored as issued (decision 010).
        token: owner.type === 'customer' ? this.tokens.random(16) : null,
        createdAt: now,
        updatedAt: now,
      });
      const message = await insertMessage(tx, {
        ticketId: ticket.id,
        authorType: owner.type,
        authorId: owner.id,
        body: input.message,
        isInternal: false,
        fileIds: ids,
        createdAt: now,
      });
      const stored = await updateTicket(tx, ticket.id, { lastRequesterMessageId: message.id, updatedAt: now });
      // The receipt is sent by the job, which re-reads the customer; a merchant's ticket has none.
      if (owner.type === 'customer') await this.mail.received(work, ticket);
      this.events.updated(ticket.id);
      return { ticket: stored, message, files };
    });
  }
}
