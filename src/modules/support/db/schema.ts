// Support tables (map domain J): tickets from customers and merchants, their messages and reply templates.
// Conventions: decision 027; schema additions: MISMATCHES B116, the ticket token (feature 17), the seen marks, the reply-mail columns and
// the notify channel (feature 28), the token's hash and copy (decision 054); ownership: scripts/module-map.mjs.
import { type SQL, isNotNull, sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { bigId, bigintList, createdAt, fk, inList, lower, pk, timestampTz, updatedAt } from '../../../infra/db/columns';
import { staffUsers } from '../../identity/db/schema';
import { orders } from '../../orders/db/schema';

/**
 * Where a ticket came from.
 *
 * Why: the console's ticket wire enum (GET /admin/support-tickets).
 */
export const TICKET_CHANNELS = ['email', 'telegram', 'web', 'chat'] as const;

/** One value of {@link TICKET_CHANNELS}. */
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

/**
 * Who opened a ticket: a merchant or a storefront customer.
 *
 * Why: the console's ticket wire enum.
 */
export const TICKET_REQUESTER_TYPES = ['client', 'customer'] as const;

/** One value of {@link TICKET_REQUESTER_TYPES}. */
export type TicketRequesterType = (typeof TICKET_REQUESTER_TYPES)[number];

/**
 * Ticket and reply-template categories; the category sets the default priority.
 *
 * Why: the console's ticket and reply-template wire enum (B62).
 */
export const TICKET_CATEGORIES = [
  'refund',
  'delay',
  'failed_unlock',
  'billing',
  'wrong_imei',
  'howto',
  'presale',
  'other',
] as const;

/** One value of {@link TICKET_CATEGORIES}. */
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/**
 * Ticket priority, which sets the SLA target.
 *
 * Why: the console's ticket wire enum (B62).
 */
export const TICKET_PRIORITIES = ['low', 'normal', 'high'] as const;

/** One value of {@link TICKET_PRIORITIES}. */
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/**
 * Ticket life as the map writes it; the console receives `pending_customer` as `pending`. `resolved` is the last state.
 *
 * Why: scenario b2c-ticket, MISMATCHES B112 and RESOLUTIONS b2c-2 (the map's `closed` is dropped: it was never used).
 */
export const TICKET_STATUSES = ['new', 'open', 'pending_customer', 'resolved'] as const;

/** One value of {@link TICKET_STATUSES}. */
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Who wrote a ticket message.
 *
 * Why: the console's ticket message wire enum.
 */
export const TICKET_AUTHOR_TYPES = ['staff', 'client', 'customer', 'system'] as const;

/** One value of {@link TICKET_AUTHOR_TYPES}. */
export type TicketAuthorType = (typeof TICKET_AUTHOR_TYPES)[number];

/**
 * How a public staff message was delivered: by email (the reply-mail sweep may batch it) or by Telegram (sent at once).
 *
 * Why: feature 28, rule 9: only email replies wait for the requester to see them; a Telegram reply is never repeated by email.
 */
export const TICKET_NOTIFY_CHANNELS = ['email', 'telegram'] as const;

/** One value of {@link TICKET_NOTIFY_CHANNELS}. */
export type TicketNotifyChannel = (typeof TICKET_NOTIFY_CHANNELS)[number];

/**
 * Support tickets from storefront customers and merchants, linked to an order, with an SLA deadline.
 *
 * Why: Support tickets from storefront customers and merchants, linked to an order, with an SLA deadline (scenario
 * b2c-ticket).
 */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: pk(),
    /** the ticket number shown to people; unique */
    number: text().notNull(),
    subject: text().notNull(),
    channel: text().$type<TicketChannel>().notNull().default('web'),
    requesterType: text().$type<TicketRequesterType>().notNull(),
    /** polymorphic: customers or clients by requester_type */
    requesterId: bigId().notNull(),
    orderId: fk((): AnyPgColumn => orders.id),
    category: text().$type<TicketCategory>().notNull().default('other'),
    priority: text().$type<TicketPriority>().notNull().default('normal'),
    status: text().$type<TicketStatus>().notNull().default('new'),
    assigneeId: fk((): AnyPgColumn => staffUsers.id),
    /** null after a public staff reply (B62) */
    slaDueAt: timestampTz(),
    firstResponseAt: timestampTz(),
    resolvedAt: timestampTz(),
    /** 1 to 5, set by the requester after resolution */
    csatScore: integer(),
    /** the ticket link token as issued: only tickets opened before decision 054, until the seal pass empties it; null for a ticket nobody opens by link */
    token: text(),
    /** the lookup hash of the ticket link token (CapabilityTokenVault.hashOf('ticket', …), decision 054); unique */
    tokenHash: text(),
    /** the ticket link token as AES-GCM text, AAD support_tickets.token_enc (decisions 019, 054) */
    tokenEnc: text(),
    /** when the requester's address was proven (decision 053): when the ticket was made, except a ticket of the public form opened with a typed email, which is null until its link is first used; while null the ticket stays off the customer's account */
    requesterProvenAt: timestampTz().defaultNow(),
    /** when the satisfaction survey was queued; set once, in the resolve transaction, and never cleared (one survey per ticket) */
    surveySentAt: timestampTz(),
    /** the newest public staff message the requester has seen (feature 28: one seen mark per side, it only moves forward) */
    requesterSeenMessageId: bigId(),
    requesterSeenAt: timestampTz(),
    /** the newest requester message staff have seen (staff are one party: the requester learns that support saw it, never who) */
    staffSeenMessageId: bigId(),
    staffSeenAt: timestampTz(),
    /** the newest message of the requester; with `staff_seen_message_id` it decides the staff side's `hasUnread` */
    lastRequesterMessageId: bigId(),
    /** the newest public staff message; with `requester_seen_message_id` it decides the requester's `hasUnread` */
    lastStaffMessageId: bigId(),
    /** when the unseen email replies are mailed (the reply-mail sweep); null when nothing waits */
    replyMailDueAt: timestampTz(),
    /** the newest staff reply an email already carried, so a sweep never mails a reply twice */
    replyMailedMessageId: bigId(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('support_tickets_number_uq').on(t.number),
    uniqueIndex('support_tickets_token_uq')
      .on(t.token)
      .where(sql`${t.token} is not null`),
    uniqueIndex('support_tickets_token_hash_uq')
      .on(t.tokenHash)
      .where(sql`${t.tokenHash} is not null`),
    // Decision 054: a ticket never keeps both forms of its link token, and a hash always comes with its encrypted copy.
    check('support_tickets_token_form_check', sql`${t.token} is null or ${t.tokenHash} is null`),
    check('support_tickets_token_enc_check', sql`(${t.tokenHash} is null) = (${t.tokenEnc} is null)`),
    check('support_tickets_channel_check', inList(t.channel, TICKET_CHANNELS)),
    check('support_tickets_requester_type_check', inList(t.requesterType, TICKET_REQUESTER_TYPES)),
    check('support_tickets_category_check', inList(t.category, TICKET_CATEGORIES)),
    check('support_tickets_priority_check', inList(t.priority, TICKET_PRIORITIES)),
    check('support_tickets_status_check', inList(t.status, TICKET_STATUSES)),
    index('support_tickets_requester_idx').on(t.requesterType, t.requesterId),
    index('support_tickets_status_created_idx').on(t.status, t.createdAt.desc()),
    index('support_tickets_updated_idx').on(t.updatedAt.desc()),
    index('support_tickets_sla_idx')
      .on(t.slaDueAt)
      .where(sql`${t.status} <> 'resolved'`),
    index('support_tickets_order_id_idx').on(t.orderId),
    check('support_tickets_csat_check', sql`${t.csatScore} is null or ${t.csatScore} between 1 and 5`),
    index('support_tickets_assignee_id_idx').on(t.assigneeId),
    index('support_tickets_reply_mail_due_idx')
      .on(t.replyMailDueAt)
      .where(sql`${t.replyMailDueAt} is not null`),
  ],
);

/** A row read from `support_tickets`. */
export type SupportTicket = typeof supportTickets.$inferSelect;

/** A row to insert into `support_tickets`. */
export type NewSupportTicket = typeof supportTickets.$inferInsert;

/**
 * The condition "the requester's address of the ticket is proven", for a query on `support_tickets`.
 *
 * Why: decision 053. A ticket opened on the public form with a typed email address is not the address owner's until the mailed link is
 * used, so it is left out of everything that lists a customer's own tickets: the account list, the replay of the live account stream, the
 * customer's data export and the evidence of their orders. The one expression, here beside the column, is shared by those reads (the
 * reads of other modules reach this table through the schema barrel, so none of them copies the test); the in-memory twin for a row
 * already read is `isRequesterProven` (`domain/requester-proof.ts`).
 *
 * @returns the SQL condition `requester_proven_at is not null`
 */
export function requesterProven(): SQL {
  return isNotNull(supportTickets.requesterProvenAt);
}

/**
 * Ticket messages from the customer, a staff member or the system, plus internal notes.
 *
 * Why: The conversation of a ticket: customer, staff and system messages plus internal notes (routes
 * /admin/support-tickets/:id).
 *
 * Immutable: messages are never edited, so the table has no `updated_at`.
 */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: pk(),
    ticketId: fk((): AnyPgColumn => supportTickets.id, 'cascade').notNull(),
    authorType: text().$type<TicketAuthorType>().notNull(),
    /** customers, clients or staff_users by author_type; null for the system */
    authorId: bigId(),
    body: text().notNull(),
    /** an internal note: never shown to the requester */
    isInternal: boolean().notNull().default(false),
    /** attachments (files.id): PDF, JPEG or PNG, at most 5 (feature 28) */
    fileIds: bigintList(),
    /** how a public staff message reaches the requester (`email`, `telegram`); null for every other message (feature 28) */
    notifyChannel: text().$type<TicketNotifyChannel>(),
    createdAt: createdAt(),
  },
  (t) => [
    check('ticket_messages_author_type_check', inList(t.authorType, TICKET_AUTHOR_TYPES)),
    check('ticket_messages_notify_channel_check', inList(t.notifyChannel, TICKET_NOTIFY_CHANNELS)),
    index('ticket_messages_ticket_idx').on(t.ticketId, t.id),
    check('ticket_messages_author_check', sql`(${t.authorType} = 'system') = (${t.authorId} is null)`),
  ],
);

/** A row read from `ticket_messages`. */
export type TicketMessage = typeof ticketMessages.$inferSelect;

/** A row to insert into `ticket_messages`. */
export type NewTicketMessage = typeof ticketMessages.$inferInsert;

/**
 * Ready-made reply templates for staff, by category.
 *
 * Why: Ready-made replies for staff by category, with a shortcut (routes /admin/reply-templates).
 */
export const replyTemplates = pgTable(
  'reply_templates',
  {
    id: pk(),
    title: text().notNull(),
    category: text().$type<TicketCategory>().notNull().default('other'),
    body: text().notNull(),
    /** unique case-insensitively when set (SHORTCUT_TAKEN) */
    shortcut: text(),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reply_templates_shortcut_uq')
      .on(lower(t.shortcut))
      .where(sql`${t.shortcut} is not null`),
    check('reply_templates_category_check', inList(t.category, TICKET_CATEGORIES)),
    index('reply_templates_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `reply_templates`. */
export type ReplyTemplate = typeof replyTemplates.$inferSelect;

/** A row to insert into `reply_templates`. */
export type NewReplyTemplate = typeof replyTemplates.$inferInsert;
