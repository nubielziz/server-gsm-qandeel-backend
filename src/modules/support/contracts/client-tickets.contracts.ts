// Route contracts of a merchant's support tickets in the portal (feature 28, slice B2, routes beyond the map: scripts/map-additions/28b.mjs;
// plan docs/briefs/28-support-live-chat.md § 3.2 routes 8 to 14): list, open, the conversation, reply, read mark and the
// download of an attachment. A merchant's ticket has no link token: the session is the credential and the routes take the ticket id (a
// ticket of another merchant is `404`). A merchant waiting for approval may use all of them (B153); a suspended one may not.
import { z } from 'zod';
import { defineRoute, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import {
  ACCOUNT_TICKET_MAX_PAGE,
  MyTicketRowSchema,
  OpenAccountTicketBody,
  accountTicketListQuery,
} from './my-tickets.contracts';
import { StoreMessageSchema, StoreTicketSchema } from './store-tickets.contracts';
import { messageBody } from './shared';

/** One ticket of the merchant's list: the customer's row without the link token, with the ticket id. */
export const ClientTicketRowSchema = MyTicketRowSchema.omit({ token: true }).extend({
  id: zId.describe('What the ticket routes of the portal take.'),
});

/**
 * A merchant's ticket with its conversation: the storefront's ticket with the ticket id.
 *
 * Why: the seen marks are always sent here (the route is new, so they need not be optional as on the storefront's existing answers).
 */
export const ClientTicketSchema = StoreTicketSchema.omit({
  seenByYou: true,
  seenBySupport: true,
  seenBySupportAt: true,
}).extend({
  id: zId.describe('What the ticket routes of the portal take.'),
  seenByYou: zId.nullable().describe('The newest support message the merchant has seen (its own mark), or null.'),
  seenBySupport: zId
    .nullable()
    .describe(
      'The newest message of the merchant that support has seen, or null: show `Seen` under it and the older ones.',
    ),
  seenBySupportAt: zIsoDateTime.nullable().describe('When support saw it, or null.'),
});

const ID_PARAMS = z.object({ id: zIdParam.describe('The ticket.') });
const ID_FILE_PARAMS = ID_PARAMS.extend({ fileId: zIdParam.describe('The attachment.') });

const CLIENT_ERRORS = ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'] as const;

const ROW_EXAMPLE = {
  id: 1043,
  number: 'T-1043',
  subject: 'Invoice question',
  category: 'billing',
  status: 'pending',
  orderId: null,
  createdAt: '2026-11-08T09:30:00.000Z',
  updatedAt: '2026-11-08T10:12:00.000Z',
  lastMessageAt: '2026-11-08T10:12:00.000Z',
  lastMessageFrom: 'support',
  hasUnread: true,
} as const;

const TICKET_EXAMPLE = {
  id: 1043,
  number: 'T-1043',
  subject: 'Invoice question',
  category: 'billing',
  status: 'pending',
  orderId: null,
  createdAt: '2026-11-08T09:30:00.000Z',
  updatedAt: '2026-11-08T10:12:00.000Z',
  resolvedAt: null,
  messages: [
    {
      id: 9000,
      from: 'you',
      body: 'Can you re-issue the October invoice in USD?',
      createdAt: '2026-11-08T09:30:00.000Z',
      attachments: [],
    },
    {
      id: 9001,
      from: 'support',
      body: 'Done: the new invoice is in your billing page.',
      createdAt: '2026-11-08T10:12:00.000Z',
      attachments: [{ id: 7001, filename: 'invoice.pdf', mime: 'application/pdf', size: 48213 }],
    },
  ],
  seenByYou: 9001,
  seenBySupport: 9000,
  seenBySupportAt: '2026-11-08T10:05:00.000Z',
} as const;

/** `GET /client/tickets`. */
export const listClientTickets = defineRoute({
  key: 'GET /client/tickets',
  summary: 'My support tickets',
  description:
    'The signed-in merchant’s own tickets, newest activity first (`updatedAt` descending); sort by `updatedAt` or `createdAt`; filter by ' +
    '`status` (repeat the key for IN; `pending` means the team waits for the merchant); at most ' +
    `${ACCOUNT_TICKET_MAX_PAGE} a page; there is no search. A merchant's ticket has no link token: the rows carry the \`id\` the other ` +
    'routes take. A row is `hasUnread` while support wrote a message the portal has not marked as seen (`POST /client/tickets/:id/read`). ' +
    'A merchant waiting for approval may call it (B153). Never cached.',
  tags: ['support-tickets'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  query: accountTicketListQuery(),
  success: { status: 200, schema: ClientTicketRowSchema },
  errors: ['VALIDATION_FAILED', ...CLIENT_ERRORS],
  examples: { response: [ROW_EXAMPLE] },
});

/** `POST /client/tickets`. */
export const openClientTicket = defineRoute({
  key: 'POST /client/tickets',
  summary: 'Open a support ticket',
  description:
    'Opens a ticket for the signed-in merchant. `orderId` must be one of the merchant’s own orders (`422` on `orderId`, `unknown_order`, ' +
    'for any other, an unknown one included). `fileIds` attaches files the merchant uploaded with `POST /client/files` (at most 5; ' +
    'the portal accepts any file there, so the type and size are checked again: only a PDF, JPEG or PNG of at most 5 MiB, else `422` on ' +
    '`fileIds` with `type` or `too_large`); the first `message` may be `""` when a file is attached. The ticket starts `new` with the ' +
    'priority of its category and a reply target; a merchant gets no receipt email (staff replies are mailed). A merchant opens 5 tickets an hour (`429 RATE_LIMITED` with `Retry-After`). A merchant waiting for approval may ' +
    'open tickets (B153). The answer is the new ticket with its conversation.',
  tags: ['support-tickets'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  body: OpenAccountTicketBody,
  success: { status: 201, schema: ClientTicketSchema },
  errors: ['VALIDATION_FAILED', 'CSRF_FAILED', 'RATE_LIMITED', ...CLIENT_ERRORS],
  examples: {
    request: {
      subject: 'Invoice question',
      message: 'Can you re-issue the October invoice in USD?',
      category: 'billing',
    },
    response: {
      ...TICKET_EXAMPLE,
      status: 'new',
      updatedAt: '2026-11-08T09:30:00.000Z',
      messages: [TICKET_EXAMPLE.messages[0]],
      seenByYou: null,
      seenBySupport: null,
      seenBySupportAt: null,
    },
  },
});

/** `GET /client/tickets/:id`. */
export const showClientTicket = defineRoute({
  key: 'GET /client/tickets/:id',
  summary: 'A support ticket with its conversation',
  description:
    'The merchant’s ticket and its public messages, oldest first, each with its attachments (download them with ' +
    '`GET /client/tickets/:id/files/:fileId`); internal notes and system messages never appear. Another merchant’s ticket and an ' +
    'unknown id are `404`. Never cached.',
  tags: ['support-tickets'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  params: ID_PARAMS,
  success: { status: 200, schema: ClientTicketSchema },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED', ...CLIENT_ERRORS],
  examples: { response: TICKET_EXAMPLE },
});

/** `POST /client/tickets/:id/messages`. */
export const writeOnClientTicket = defineRoute({
  key: 'POST /client/tickets/:id/messages',
  summary: 'Write on a support ticket',
  description:
    'The merchant’s message. A ticket that waited on the merchant goes back to `open`; the reply target restarts from this message. A ' +
    'resolved ticket is closed for the merchant: `409 TICKET_RESOLVED` ("This ticket is closed. Open a new ticket if you still need help."), ' +
    'nothing is written, and staff must reopen it before the merchant can write again. `fileIds` attaches files uploaded with `POST /client/files` (at most 5, ' +
    'only a PDF, JPEG or PNG of at most 5 MiB); `body` may be `""` when a file is attached. One ticket takes 20 messages a minute ' +
    '(`429 RATE_LIMITED` with `Retry-After`). The answer is the new message; staff see it at once on their live stream. Another ' +
    'merchant’s ticket and an unknown id are `404`.',
  tags: ['support-tickets'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  params: ID_PARAMS,
  body: messageBody('Write your message.'),
  success: { status: 201, schema: StoreMessageSchema },
  errors: ['NOT_FOUND', 'TICKET_RESOLVED', 'VALIDATION_FAILED', 'CSRF_FAILED', 'RATE_LIMITED', ...CLIENT_ERRORS],
  examples: {
    request: { body: 'Thank you, that is the right amount.', fileIds: [7002] },
    response: {
      id: 9002,
      from: 'you',
      body: 'Thank you, that is the right amount.',
      createdAt: '2026-11-08T11:00:00.000Z',
      attachments: [{ id: 7002, filename: 'screen.png', mime: 'image/png', size: 182044 }],
    },
  },
});

/** `POST /client/tickets/:id/read`. */
export const markClientTicketRead = defineRoute({
  key: 'POST /client/tickets/:id/read',
  summary: 'Mark support’s messages as seen',
  description:
    'Moves the merchant’s seen mark to `upToMessageId`, a support message of this ticket (send it when the thread is visible and shows ' +
    'it). The mark only moves forward: an older or the same id is a `204` that changes nothing. Support then sees `Seen` under its ' +
    'reply, and an unseen email reply is not mailed. Any other id (a note, the merchant’s own message, a message of another ticket, ' +
    'one that does not exist) is `422` on `upToMessageId` (`unknown_message`). Another merchant’s ticket and an unknown id are `404`.',
  tags: ['support-tickets'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  params: ID_PARAMS,
  body: z.object({ upToMessageId: zId.describe('The newest support message the thread shows.') }),
  success: { status: 204 },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'CSRF_FAILED', ...CLIENT_ERRORS],
  examples: { request: { upToMessageId: 9001 } },
});

/** `GET /client/tickets/:id/files/:fileId`. */
export const openClientTicketFile = defineRoute({
  key: 'GET /client/tickets/:id/files/:fileId',
  summary: 'Download an attachment of a support ticket',
  description:
    'Redirects (`302`) to a presigned object-storage link that expires after 5 minutes (`Content-Disposition: attachment` with the ' +
    'stored file name, `Cache-Control: no-store`). Open it in a new tab; never show the file inline. The file must be an attachment of a ' +
    'public message of one of the merchant’s own tickets: a file of an internal note, of another ticket, in no message, and a ticket ' +
    'of another merchant are `404`, like an unknown id.',
  tags: ['support-tickets'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  params: ID_FILE_PARAMS,
  success: { status: 302 },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'UNAVAILABLE', ...CLIENT_ERRORS],
});
