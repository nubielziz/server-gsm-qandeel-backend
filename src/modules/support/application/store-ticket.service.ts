// StoreTicketService: what a storefront visitor does with a support ticket (feature 17, scenario b2c-ticket): open one from the order or
// contact page, read it by its token, write on it and rate it once it is resolved. The ticket token is the credential of the last three.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { CapabilityTokenVault, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { CustomerDirectory } from '../../customers';
import type { SupportTicket, TicketCategory } from '../db/schema';
import { PRIORITY_TARGET_MS, defaultPriority } from '../domain/ticket-sla';
import { findOrderByTrackingToken } from '../infra/support-foreign-reads';
import {
  type MessageRow,
  findTicket,
  insertMessage,
  insertTicket,
  listMessageRows,
  lockTicket,
  updateTicket,
} from '../infra/ticket.repository';
import { TicketAttachmentService } from './ticket-attachment.service';
import { TicketEvents } from './ticket-events';
import { TicketMailOutbox } from './ticket-mail-outbox';
import { TicketThreadService } from './ticket-thread.service';
import { NO_FILES, type StoreMessageView, type StoreTicketView, toStoreTicket } from './ticket-views';

/** What `POST /store/v1/tickets` hands in. */
export interface OpenStoreTicketInput {
  /** Already trimmed, valid and lower case; needed unless `orderToken` is given. */
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly subject: string;
  readonly message: string;
  readonly category?: TicketCategory | undefined;
  readonly orderToken?: string | undefined;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'This link is not valid.' });

const refuse = (field: string, code: string, message: string) =>
  new AppError('VALIDATION_FAILED', { errors: [{ field, code, message } satisfies FieldError] });

/**
 * Opens, reads, answers and rates support tickets for a storefront visitor.
 *
 * Why: scenario b2c-ticket steps 1, 2, 6 and 8. A visitor with no account opens a ticket from the tracking page
 * (the order's tracking token links it to the order and to the order's customer) or the contact page (an email, which makes a guest
 * customer the first time); it starts `new` with the priority of its category and a reply target, and the customer gets a receipt. The
 * ticket token (128 random bits, decision 010) is the only credential of the ticket page: it reaches the visitor in the receipt email, and in
 * the answer to the open call only when the visitor proved who they are with the order's tracking token (an email anyone can type is not
 * a proof, so that path answers without it). A message on a ticket that waited on the customer makes it `open` again and restarts the
 * reply target from that message. A resolved ticket is closed for the customer (B220, owner decision 2026-11-15, replacing ANSWERS support
 * Q8): a message is `409 TICKET_RESOLVED`, and staff reopen the ticket to continue. The rating is one answer, 1 to 5, only once the
 * ticket is resolved, and the ticket stays resolved (no `closed` status).
 *
 * The receipt email repeats the visitor's subject to the address they typed, so the form could relay spam to a stranger: besides Turnstile
 * and the per-IP limit, one email address opens at most 3 tickets an hour (case-insensitive, `429 RATE_LIMITED` with `Retry-After`,
 * limiter `ticket-email` of decision 021). The order-token path writes to the order's own customer, who the visitor proved to be, and is
 * not counted here.
 *
 * Feature 28: the customer's message is written by `TicketThreadService` (attachments, the `ticket-message` limit, the doorbell), the views
 * carry the attachments and the seen marks, and a new ticket and a rating ring `ticket updated` so the console sees them at once.
 *
 * Side effects: counts a point of the `ticket-email` limiter on the cache Redis (a hashed key, one hour); may insert a guest `customers`
 * row through the customers module; inserts `support_tickets` and `ticket_messages` rows, and for a new ticket the
 * `support.ticket_mail` outbox event of its receipt, in one transaction; rings the ticket doorbells after the commit. Time comes from
 * the injected clock (decision 031).
 */
@Injectable()
export class StoreTicketService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly vault: CapabilityTokenVault,
    private readonly mail: TicketMailOutbox,
    private readonly customers: CustomerDirectory,
    private readonly limits: RateLimitService,
    private readonly thread: TicketThreadService,
    private readonly attachments: TicketAttachmentService,
    private readonly events: TicketEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Opens a ticket.
   *
   * @param input the subject, the message and who writes
   * @returns the new ticket as the customer reads it; the ticket token is in it only when the order's tracking token was given (the
   *   caller already holds that credential). The email path gets no token: it files the ticket under whoever owns the address, so the
   *   token would let a stranger read that customer's thread. The receipt email carries the link.
   * @throws {AppError} `VALIDATION_FAILED` (422 on `orderToken` for a token that names no storefront order, on `email` when neither an
   *   email nor an order token was given); `RATE_LIMITED` (429 with `Retry-After`) from the fourth ticket of one email address in an hour
   */
  async open(input: OpenStoreTicketInput): Promise<StoreTicketView & { token?: string }> {
    // Counted before anything is written, so a refused call leaves no guest customer or ticket behind. `compositeKey` lower-cases and
    // hashes the address: Redis shows no email.
    if (input.orderToken === undefined && input.email !== undefined) {
      await this.limits.enforce('ticket-email', RateLimitService.compositeKey(input.email));
    }
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const now = this.clock.now();
      let orderId: number | null = null;
      let customerId: number;
      // True when the caller holds the order's tracking token, the only proof of identity this route can check.
      let provedByOrder = false;
      if (input.orderToken !== undefined) {
        // Decision 054: the order is found by the keyed hash of its tracking token (an order placed before by its plain token).
        const hash = this.vault.hashOf('tracking', input.orderToken);
        const order = await findOrderByTrackingToken(tx, { hash, token: input.orderToken });
        const valid =
          order !== undefined &&
          (order.tokenHash !== null
            ? this.tokens.equals(order.tokenHash, hash)
            : order.token !== null && this.tokens.equals(order.token, input.orderToken));
        if (!order || !valid) throw refuse('orderToken', 'unknown_order', 'This order link is not valid.');
        orderId = order.id;
        customerId = order.customerId;
        provedByOrder = true;
      } else if (input.email !== undefined) {
        customerId = (await this.customers.findOrCreateGuest(tx, { email: input.email, name: input.name ?? '' })).id;
      } else {
        throw refuse('email', 'required', 'Enter your email address.');
      }

      const category = input.category ?? 'other';
      const priority = defaultPriority(category);
      // Decision 054: the link token is stored only as its keyed hash and an encrypted copy.
      const issued = this.vault.issue('ticket');
      const ticket = await insertTicket(tx, {
        subject: input.subject,
        channel: 'web',
        requesterType: 'customer',
        requesterId: customerId,
        orderId,
        category,
        priority,
        status: 'new',
        // The customer's first message is the one a reply is awaited for.
        slaDueAt: new Date(now.getTime() + PRIORITY_TARGET_MS[priority]),
        token: null,
        tokenHash: issued.hash,
        tokenEnc: issued.enc,
        createdAt: now,
        updatedAt: now,
      });
      const message = await insertMessage(tx, {
        ticketId: ticket.id,
        authorType: 'customer',
        authorId: customerId,
        body: input.message,
        isInternal: false,
        createdAt: now,
      });
      // The first message is the requester's newest (staff's `hasUnread`, feature 28).
      const stored = await updateTicket(tx, ticket.id, { lastRequesterMessageId: message.id, updatedAt: now });
      // The receipt is sent by the job, which re-reads the customer: an anonymized one (reached through an old order link) gets nothing.
      await this.mail.received(work, ticket);
      this.events.updated(ticket.id);
      const view = toStoreTicket(stored, [{ message, authorName: '' }], NO_FILES);
      return provedByOrder ? { ...view, token: issued.token } : view;
    });
  }

  /**
   * Reads a ticket.
   *
   * @param id the ticket id the token resolved to
   * @returns the ticket and its public messages
   * @throws {AppError} `NOT_FOUND` when the ticket no longer exists
   */
  async show(id: number): Promise<StoreTicketView> {
    const ticket = await findTicket(this.db.db, id);
    if (!ticket) throw notFound();
    return this.view(ticket, await listMessageRows(this.db.db, id, true));
  }

  /**
   * Adds the customer's message.
   *
   * @param id the ticket id the token resolved to
   * @param input the text (may be `''` with a file) and the ids of the files it carries
   * @returns the new message
   * @throws {AppError} `NOT_FOUND` when the ticket no longer exists; `TICKET_RESOLVED` (409: the ticket is resolved, nothing is written);
   *   `RATE_LIMITED`; `VALIDATION_FAILED` (422 on `fileIds`)
   */
  write(
    id: number,
    input: { readonly body: string; readonly fileIds?: readonly number[] | undefined },
  ): Promise<StoreMessageView> {
    return this.thread.write(id, { via: 'link' }, input);
  }

  /**
   * Records the satisfaction rating.
   *
   * @param id the ticket id the token resolved to
   * @param score 1 to 5
   * @returns the ticket after the rating
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `score` for a ticket that is not resolved yet, or already rated)
   */
  async rate(id: number, score: number): Promise<StoreTicketView> {
    const ticket = await this.db.runInTransaction(async ({ tx }): Promise<SupportTicket> => {
      const locked = await lockTicket(tx, id);
      if (!locked) throw notFound();
      if (locked.status !== 'resolved') {
        throw refuse('score', 'not_resolved', 'You can rate a ticket once it is resolved.');
      }
      if (locked.csatScore !== null) throw refuse('score', 'already_rated', 'You already rated this ticket.');
      // Rating is not activity the team has to look at: the ticket keeps its `updated_at`.
      const rated = await updateTicket(tx, id, { csatScore: score, updatedAt: locked.updatedAt });
      this.events.updated(id);
      return rated;
    });
    return this.view(ticket, await listMessageRows(this.db.db, id, true));
  }

  /** The customer's view of a ticket with the attachments of its public messages. */
  private async view(ticket: SupportTicket, messages: readonly MessageRow[]): Promise<StoreTicketView> {
    const files = await this.attachments.filesOf(
      this.db.db,
      messages.map((row) => row.message),
    );
    return toStoreTicket(ticket, messages, files);
  }
}
