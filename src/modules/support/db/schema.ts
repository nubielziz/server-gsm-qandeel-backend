// Support tables (map domain J): tickets from customers and merchants, their messages and reply templates.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
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
 * Ticket life as the map writes it; the console receives `pending_customer` as `pending` and `closed` is not used.
 *
 * Why: scenario b2c-ticket and MISMATCHES B112.
 */
export const TICKET_STATUSES = ['new', 'open', 'pending_customer', 'resolved', 'closed'] as const;

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('support_tickets_number_uq').on(t.number),
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
      .where(sql`${t.status} not in ('resolved', 'closed')`),
    index('support_tickets_order_id_idx').on(t.orderId),
    check('support_tickets_csat_check', sql`${t.csatScore} is null or ${t.csatScore} between 1 and 5`),
    index('support_tickets_assignee_id_idx').on(t.assigneeId),
  ],
);

/** A row read from `support_tickets`. */
export type SupportTicket = typeof supportTickets.$inferSelect;

/** A row to insert into `support_tickets`. */
export type NewSupportTicket = typeof supportTickets.$inferInsert;

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
    /** attachments (files.id) */
    fileIds: bigintList(),
    createdAt: createdAt(),
  },
  (t) => [
    check('ticket_messages_author_type_check', inList(t.authorType, TICKET_AUTHOR_TYPES)),
    index('ticket_messages_ticket_idx').on(t.ticketId, t.id),
    check('ticket_messages_author_check', sql`(${t.authorType} = 'system') = (${t.authorId} is null)`),
  ],
);

/** A row read from `ticket_messages`. */
export type TicketMessage = typeof ticketMessages.$inferSelect;

/** A row to insert into `ticket_messages`. */
export type NewTicketMessage = typeof ticketMessages.$inferInsert;

/**
 * Ready-made reply templates for staff, by category and language.
 *
 * Why: Ready-made replies for staff by category and language, with a shortcut (routes /admin/reply-templates).
 */
export const replyTemplates = pgTable(
  'reply_templates',
  {
    id: pk(),
    title: text().notNull(),
    category: text().$type<TicketCategory>().notNull().default('other'),
    locale: text().notNull().default('en'),
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
