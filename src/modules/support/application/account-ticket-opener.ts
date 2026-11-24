// AccountTicketOpener: the one way a signed-in account opens a ticket (feature 28, slice B2, routes 7 and 9; decision 064). MyTicketsService
// (the shop's retail rank) and ClientTicketService (the portal's merchant rank) call it; the visitor's public form (no session, Turnstile,
// an email or an order link) stays StoreTicketService.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { CapabilityTokenVault } from '../../../infra/crypto';
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
 * Opens a ticket for a signed-in account.
 *
 * Why: feature 28, rules 6 and 7 (B217) and decision 064: a signed-in retail account opens a ticket without Turnstile and gets the link
 * token at once (the session already proves who they are, unlike the email path of the public form); an account of a merchant rank gets a
 * ticket without a token (the session is the credential). The rank kind comes from the session's principal. The ticket starts `new` with
 * the priority of its category and a reply target, the first message is the requester's newest (staff's `hasUnread`), and staff see it
 * at once through `ticket updated`. `orderId` must be an order of the caller (`orders.account_id`, an authorization check).
 * Without Turnstile the route could be used to flood the inbox, so an account opens 5 tickets an hour (limiter `ticket-open`, decision 021),
 * counted before anything is read or written so probing order ids is limited too.
 *
 * Side effects: counts a point of `ticket-open` on the cache Redis (`account:<id>`, one hour); inserts the `support_tickets` and
 * `ticket_messages` rows, and for a retail account the receipt's `support.ticket_mail` outbox event, in one transaction (a merchant rank
 * gets no receipt: its ticket has no page to link); rings `ticket updated` after the commit.
 *
 * @see POST /store/v1/me/tickets, POST /client/tickets
 */
@Injectable()
export class AccountTicketOpener {
  constructor(
    private readonly db: DbService,
    private readonly vault: CapabilityTokenVault,
    private readonly mail: TicketMailOutbox,
    private readonly limits: RateLimitService,
    private readonly attachments: TicketAttachmentService,
    private readonly events: TicketEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Opens the ticket.
   *
   * @param owner the signed-in account and its rank kind (from the session, never from the body)
   * @param input the subject, the first message and what it carries
   * @returns the stored ticket, its first message and the message's files
   * @throws {AppError} `RATE_LIMITED` (429 with `Retry-After`) from the 6th ticket of an account in an hour; `VALIDATION_FAILED` (422 on
   *   `orderId`: `unknown_order`; on `fileIds`: `unknown_file`, `not_yours`, `type`, `too_large`)
   */
  async open(owner: TicketOwner, input: OpenAccountTicketInput): Promise<OpenedAccountTicket> {
    await this.limits.enforce('ticket-open', `account:${owner.id}`);
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
      const { ids, files } = await this.attachments.attach(tx, { type: 'account', id: owner.id }, input.fileIds);
      const category = input.category ?? 'other';
      const priority = defaultPriority(category);
      // Only a retail account's ticket has a page; its 128-bit token (decision 010) is stored as a keyed hash and an encrypted copy (decision
      // 054). A merchant rank's ticket has neither.
      const issued = owner.rankKind === 'retail' ? this.vault.issue('ticket') : null;
      const ticket = await insertTicket(tx, {
        subject: input.subject,
        channel: 'web',
        requesterType: 'account',
        requesterId: owner.id,
        orderId: input.orderId ?? null,
        category,
        priority,
        status: 'new',
        // The requester's first message is the one a reply is awaited for.
        slaDueAt: new Date(now.getTime() + PRIORITY_TARGET_MS[priority]),
        token: null,
        tokenHash: issued?.hash ?? null,
        tokenEnc: issued?.enc ?? null,
        // Decision 053: a signed-in requester is proven (the session says who they are).
        requesterProvenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const message = await insertMessage(tx, {
        ticketId: ticket.id,
        authorType: 'account',
        authorId: owner.id,
        body: input.message,
        isInternal: false,
        fileIds: ids,
        createdAt: now,
      });
      const stored = await updateTicket(tx, ticket.id, { lastRequesterMessageId: message.id, updatedAt: now });
      // The receipt is sent by the job, which re-reads the account; a merchant rank's ticket has none.
      if (owner.rankKind === 'retail') await this.mail.received(work, ticket);
      this.events.updated(ticket.id);
      return { ticket: stored, message, files };
    });
  }
}
