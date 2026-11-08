// StoreTicketService: what a storefront visitor does with a support ticket (feature 17, scenario b2c-ticket): open one from the order or
// contact page, read it by its token, write on it and rate it once it is resolved. The ticket token is the credential of the last three.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { CustomerDirectory } from '../../customers';
import type { SupportTicket, TicketCategory } from '../db/schema';
import { PRIORITY_TARGET_MS, defaultPriority } from '../domain/ticket-sla';
import { findOrderByTrackingToken } from '../infra/support-foreign-reads';
import {
  findTicket,
  insertMessage,
  insertTicket,
  listMessageRows,
  lockTicket,
  updateTicket,
} from '../infra/ticket.repository';
import { TicketMailOutbox } from './ticket-mail-outbox';
import { type StoreMessageView, type StoreTicketView, toStoreMessage, toStoreTicket } from './ticket-views';

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
 * Why: scenario b2c-ticket steps 1, 2, 6 and 8 and ANSWERS support Q8. A visitor with no account opens a ticket from the tracking page
 * (the order's tracking token links it to the order and to the order's customer) or the contact page (an email, which makes a guest
 * customer the first time); it starts `new` with the priority of its category and a reply target, and the customer gets a receipt. The
 * ticket token (128 random bits, decision 010) is the only credential of the ticket page: it reaches the visitor in the receipt email, and in
 * the answer to the open call only when the visitor proved who they are with the order's tracking token (an email anyone can type is not
 * a proof, so that path answers without it). A message on a resolved ticket reopens it, a
 * message on a ticket that waited on the customer makes it `open` again, and either one restarts the reply target from that message.
 * The rating is one answer, 1 to 5, only once the ticket is resolved, and the ticket stays resolved (no `closed` status).
 *
 * The receipt email repeats the visitor's subject to the address they typed, so the form could relay spam to a stranger: besides Turnstile
 * and the per-IP limit, one email address opens at most 3 tickets an hour (case-insensitive, `429 RATE_LIMITED` with `Retry-After`,
 * limiter `ticket-email` of decision 021). The order-token path writes to the order's own customer, who the visitor proved to be, and is
 * not counted here.
 *
 * Side effects: counts a point of the `ticket-email` limiter on the cache Redis (a hashed key, one hour); may insert a guest `customers`
 * row through the customers module; inserts `support_tickets` and `ticket_messages` rows, and for a new ticket the
 * `support.ticket_mail` outbox event of its receipt, in one transaction. Time comes from the injected clock (decision 031).
 */
@Injectable()
export class StoreTicketService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly mail: TicketMailOutbox,
    private readonly customers: CustomerDirectory,
    private readonly limits: RateLimitService,
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
        const order = await findOrderByTrackingToken(tx, input.orderToken);
        if (!order || !this.tokens.equals(order.token, input.orderToken))
          throw refuse('orderToken', 'unknown_order', 'This order link is not valid.');
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
      const token = this.tokens.random(16);
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
        token,
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
      // The receipt is sent by the job, which re-reads the customer: an anonymized one (reached through an old order link) gets nothing.
      await this.mail.received(work, ticket);
      const view = toStoreTicket(ticket, [{ message, authorName: '' }]);
      return provedByOrder ? { ...view, token } : view;
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
    return toStoreTicket(ticket, await listMessageRows(this.db.db, id, true));
  }

  /**
   * Adds the customer's message.
   *
   * @param id the ticket id the token resolved to
   * @param body the text
   * @returns the new message
   * @throws {AppError} `NOT_FOUND` when the ticket no longer exists
   */
  async write(id: number, body: string): Promise<StoreMessageView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const ticket = await lockTicket(tx, id);
      if (!ticket) throw notFound();
      const now = this.clock.now();
      const message = await insertMessage(tx, {
        ticketId: id,
        authorType: ticket.requesterType,
        authorId: ticket.requesterId,
        body,
        isInternal: false,
        createdAt: now,
      });
      // `new` stays new (nobody has picked it up); a resolved or waiting ticket is open again (ANSWERS support Q8).
      const reopened = ticket.status === 'resolved' || ticket.status === 'pending_customer';
      await updateTicket(tx, id, {
        ...(reopened ? { status: 'open' as const } : {}),
        ...(ticket.status === 'resolved' ? { resolvedAt: null } : {}),
        slaDueAt: new Date(now.getTime() + PRIORITY_TARGET_MS[ticket.priority]),
        updatedAt: now,
      });
      return toStoreMessage(message);
    });
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
      return updateTicket(tx, id, { csatScore: score, updatedAt: locked.updatedAt });
    });
    return toStoreTicket(ticket, await listMessageRows(this.db.db, id, true));
  }
}
