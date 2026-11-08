// Route contracts of the support inbox (map domain J, routes /admin/support-tickets, stage 17): the list, one ticket with its thread, the
// change of priority, assignee or status, a staff reply and an internal note. Shapes match the console's SupportTicket and
// SupportTicketDetail (docs/contract/endpoints/support.md, RESOLUTIONS b2c-2).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { REPLY_CHANNELS } from '../domain/reply-channels';
import { WIRE_TICKET_STATUSES } from '../domain/ticket-status';
import {
  RequesterTypeSchema,
  TicketCategorySchema,
  TicketChannelSchema,
  TicketMessageSchema,
  TicketPrioritySchema,
  WireStatusSchema,
  messageText,
} from './shared';

/** A ticket as the inbox lists it. */
export const TicketRowSchema = z.object({
  id: zId,
  number: z.string().describe("Server-made, 'T-1042' style."),
  subject: z.string(),
  channel: TicketChannelSchema,
  requesterType: RequesterTypeSchema.describe('`client` is a merchant.'),
  requesterId: zId,
  requester: z.object({
    name: z.string().describe("'Deleted customer' after an anonymize; the address when a guest gave no name."),
    email: z.string().nullable(),
  }),
  orderId: zId.nullable(),
  category: TicketCategorySchema,
  priority: TicketPrioritySchema,
  status: WireStatusSchema.describe('The stored `pending_customer` is sent as `pending`; `closed` does not exist.'),
  assigneeId: zId.nullable(),
  assignee: z.object({ id: zId, name: z.string() }).nullable(),
  slaDueAt: zIsoDateTime.nullable().describe('When the next reply is due; null when nobody is waiting for one.'),
  firstResponseAt: zIsoDateTime.nullable(),
  resolvedAt: zIsoDateTime.nullable(),
  csatScore: z.number().int().min(1).max(5).nullable(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime.describe('The last activity.'),
  lastPublicAt: zIsoDateTime.nullable().describe('The time of the latest message the customer could see.'),
  late: z.boolean().describe('A reply is awaited and `slaDueAt` has passed; never true for a resolved ticket.'),
});

const TICKET_EXAMPLE = {
  id: 1042,
  number: 'T-1042',
  subject: 'Where is my unlock? (SF-20431)',
  channel: 'web',
  requesterType: 'customer',
  requesterId: 28,
  requester: { name: 'Victor Hale', email: 'victor@mail.example' },
  orderId: 20431,
  category: 'delay',
  priority: 'normal',
  status: 'open',
  assigneeId: 2,
  assignee: { id: 2, name: 'Lina S.' },
  slaDueAt: '2026-11-08T18:00:00.000Z',
  firstResponseAt: '2026-11-08T10:12:00.000Z',
  resolvedAt: null,
  csatScore: null,
  createdAt: '2026-11-08T09:30:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
  lastPublicAt: '2026-11-08T10:00:00.000Z',
  late: false,
} as const;

const MESSAGE_EXAMPLE = {
  id: 9001,
  ticketId: 1042,
  authorType: 'staff',
  authorId: 2,
  authorName: 'Lina S.',
  body: 'Hi Victor, your order is with the carrier and should finish within the hour.',
  isInternal: false,
  fileIds: [],
  createdAt: '2026-11-08T10:12:00.000Z',
} as const;

const ID_PARAMS = z.object({ id: zIdParam });

/** `GET /admin/support-tickets`. */
export const listSupportTickets = defineRoute({
  key: 'GET /admin/support-tickets',
  summary: 'Support inbox',
  description:
    'Tickets with their requester, assignee and reply timers. Filters: `status` (repeat the key for several; `pending` is the stored ' +
    '`pending_customer`), `late=true` (a reply is awaited and overdue), `assigneeId`, `requesterType` (`customer` or `client`) and ' +
    '`requesterId` (with a type: the tickets of one customer). `q` is a case-insensitive contains over the number, the subject, the ' +
    "requester's name and the requester's email address. Default order: late tickets first, then the latest activity. The console asks again every 30 seconds, and for the " +
    'tab counts with `_start=0&_end=1`.',
  tags: ['support-tickets'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:read',
  query: listQuery({
    sorts: ['late', 'updatedAt', 'createdAt', 'id'],
    defaultSort: [
      { field: 'late', order: 'desc' },
      { field: 'updatedAt', order: 'desc' },
    ],
    filters: {
      status: { type: 'enum', values: [...WIRE_TICKET_STATUSES], ops: ['eq'] },
      late: { type: 'boolean', ops: ['eq'] },
      assigneeId: { type: 'id', ops: ['eq'] },
      requesterType: { type: 'enum', values: ['customer', 'client'], ops: ['eq'] },
      requesterId: { type: 'id', ops: ['eq'] },
    },
    search: ['number', 'subject', 'requester.name', 'requester.email'],
  }),
  success: { status: 200, schema: TicketRowSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [TICKET_EXAMPLE] },
});

/** The detail of a ticket: the row, the thread and the channels a reply may use. */
export const TicketDetailSchema = TicketRowSchema.extend({
  messages: z.array(TicketMessageSchema).describe('Oldest first, internal notes and system messages included.'),
  replyChannels: z
    .array(z.enum(REPLY_CHANNELS))
    .describe("`['email']`, plus `'telegram'` when the requester is a merchant with a linked chat."),
});

/** `GET /admin/support-tickets/:id`. */
export const showSupportTicket = defineRoute({
  key: 'GET /admin/support-tickets/:id',
  summary: 'One support ticket',
  description:
    'The ticket with its whole thread (oldest first, internal notes included, each message with its author’s name) and `replyChannels`. ' +
    'The console reads it by id and asks again every 30 seconds while the pane is open.',
  tags: ['support-tickets'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:read',
  params: ID_PARAMS,
  success: { status: 200, schema: TicketDetailSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: { ...TICKET_EXAMPLE, messages: [MESSAGE_EXAMPLE], replyChannels: ['email'] } },
});

/** `PATCH /admin/support-tickets/:id`. */
export const updateSupportTicket = defineRoute({
  key: 'PATCH /admin/support-tickets/:id',
  summary: 'Change a support ticket',
  description:
    'Only the keys sent change; a value equal to the current one is ignored (and a body with no change answers the row as it is). ' +
    '`status` takes `new`, `open`, `pending` or `resolved`: `resolved` stamps `resolvedAt`, writes the internal system message and ' +
    'emails the satisfaction survey; `open` reopens a resolved ticket (clears `resolvedAt`) or takes a new or waiting one; `pending` ' +
    'marks it as waiting on the customer; a resolved ticket can only be reopened and nothing goes back to `new`. `assigneeId: null` ' +
    'unassigns; otherwise it must be an active staff member. A priority change moves `slaDueAt` to the new target. Every change is ' +
    'one audit entry.',
  tags: ['support-tickets'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:update',
  params: ID_PARAMS,
  body: z
    .object({
      priority: TicketPrioritySchema.optional(),
      assigneeId: zId.nullable().optional(),
      status: z.enum(WIRE_TICKET_STATUSES, 'A ticket can be resolved or reopened.').optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: TicketRowSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { status: 'resolved' }, response: { ...TICKET_EXAMPLE, status: 'resolved' } },
});

/** `POST /admin/support-tickets/:id/reply`. */
export const replyToSupportTicket = defineRoute({
  key: 'POST /admin/support-tickets/:id/reply',
  summary: 'Reply to the customer',
  description:
    'Adds a public staff message and sends it on `channel` (`email` always; `telegram` only when `replyChannels` lists it; without a ' +
    "channel the ticket's own channel when allowed, else email; a channel the ticket cannot use is `422` on `channel`). The text is " +
    'stored and sent as given: the console fills the template variables. The first public reply sets `firstResponseAt`; a new or open ' +
    'ticket becomes `pending` and `slaDueAt` becomes null; an unassigned ticket is assigned to the sender. A resolved ticket is ' +
    '`409 TICKET_RESOLVED`: reopen it first. The email goes through the notification templates (event `support.reply`).',
  tags: ['support-tickets'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:reply',
  params: ID_PARAMS,
  body: z.object({
    body: messageText('Write a reply first.'),
    channel: z.enum(REPLY_CHANNELS, 'This ticket cannot be answered on that channel.').optional(),
  }),
  success: { status: 201, schema: TicketMessageSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'TICKET_RESOLVED'],
  examples: {
    request: { body: 'Hi Victor, your order is with the carrier and should finish within the hour.', channel: 'email' },
    response: MESSAGE_EXAMPLE,
  },
});

/** `POST /admin/support-tickets/:id/note`. */
export const addSupportTicketNote = defineRoute({
  key: 'POST /admin/support-tickets/:id/note',
  summary: 'Add an internal note',
  description:
    'Adds a note the customer never sees (`isInternal: true`). The status stays; as in the demo an unassigned ticket is assigned to the ' +
    'author and `updatedAt` moves. Allowed on a resolved ticket.',
  tags: ['support-tickets'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:reply',
  params: ID_PARAMS,
  body: z.object({ body: messageText('Write the note first.') }),
  success: { status: 201, schema: TicketMessageSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { body: 'Supplier says the carrier is slow today.' },
    response: { ...MESSAGE_EXAMPLE, body: 'Supplier says the carrier is slow today.', isInternal: true },
  },
});
