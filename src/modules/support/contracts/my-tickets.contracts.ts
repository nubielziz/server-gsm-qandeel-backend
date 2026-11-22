// Route contracts of a signed-in customer's own tickets (feature 28, slice B2, routes beyond the map: scripts/map-additions/28b.mjs; plan
// docs/briefs/28-support-live-chat.md § 3.2 routes 6 and 7): the list of my tickets, each with the link token of its page, and opening a
// ticket from the account without Turnstile. The ticket page and its chat routes stay the token routes of store-tickets.contracts.ts.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIsoDateTime } from '../../../common/contract';
import { WIRE_TICKET_STATUSES } from '../domain/ticket-status';
import { StoreTicketSchema } from './store-tickets.contracts';
import { FileIdsSchema, MessageBodyText, TicketCategorySchema, WireStatusSchema } from './shared';

/** The most rows one page of the account ticket lists holds. */
export const ACCOUNT_TICKET_MAX_PAGE = 50;

/**
 * The query of both account ticket lists: newest activity first; `status` is the only filter and there is no search.
 *
 * @returns the list query schema (at most {@link ACCOUNT_TICKET_MAX_PAGE} rows a page)
 */
export const accountTicketListQuery = () =>
  listQuery({
    sorts: ['updatedAt', 'createdAt'],
    defaultSort: { field: 'updatedAt', order: 'desc' },
    filters: { status: { type: 'enum', values: [...WIRE_TICKET_STATUSES], ops: ['eq'] } },
    maxPage: ACCOUNT_TICKET_MAX_PAGE,
  });

/**
 * The body of the two routes that open a ticket from an account (`POST /store/v1/me/tickets`, `POST /client/tickets`).
 *
 * Why: the texts and limits of the public form (store-tickets.contracts.ts) without `email`, `name` and `orderToken`: the session names the
 * requester, and `orderId` must be an order of the caller (`422` on `orderId`, `unknown_order`). The first message may be files only.
 */
export const OpenAccountTicketBody = z
  .object({
    subject: z.string().trim().min(1, 'Enter a subject.').max(150, 'Use at most 150 characters.'),
    message: MessageBodyText.describe("The first message. May be `''` when `fileIds` has an entry."),
    category: TicketCategorySchema.optional().describe('Default `other`; the category sets the reply target.'),
    orderId: zId.optional().describe("One of the caller's own orders, when the ticket is about one."),
    fileIds: FileIdsSchema,
  })
  .superRefine((value, ctx) => {
    if (value.message === '' && (value.fileIds ?? []).length === 0) {
      ctx.addIssue({
        code: 'too_small',
        origin: 'string',
        minimum: 1,
        inclusive: true,
        path: ['message'],
        message: 'Write your message.',
      });
    }
  });

/** The ticket link token: the credential of the ticket page and of the `/store/v1/tickets/:token…` routes. */
const TicketLinkTokenSchema = z
  .string()
  .describe(
    'The ticket link token: the page is `/support/tickets/<token>` and every `/store/v1/tickets/:token…` route takes it. A credential: never log or cache it.',
  );

/** One ticket of the list of my tickets. */
export const MyTicketRowSchema = z.object({
  number: z.string().describe("The ticket number to quote, 'T-1042' style."),
  subject: z.string(),
  category: TicketCategorySchema,
  status: WireStatusSchema.describe('`pending` means the team waits for the customer.'),
  orderId: zId.nullable().describe('The order the ticket is about, when it has one.'),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
  lastMessageAt: zIsoDateTime.nullable().describe('When the newest message of the conversation was written, or null.'),
  lastMessageFrom: z
    .enum(['you', 'support'])
    .nullable()
    .describe('Who wrote it: `you` or `support`; null for a ticket without a message. Notes never count.'),
  hasUnread: z.boolean().describe('True while support wrote a message the page has not marked as seen yet.'),
  token: TicketLinkTokenSchema,
});

const ROW_EXAMPLE = {
  number: 'T-1042',
  subject: 'Where is my unlock? (SF-20431)',
  category: 'delay',
  status: 'pending',
  orderId: 20431,
  createdAt: '2026-11-08T09:30:00.000Z',
  updatedAt: '2026-11-08T10:12:00.000Z',
  lastMessageAt: '2026-11-08T10:12:00.000Z',
  lastMessageFrom: 'support',
  hasUnread: true,
  token: 'Zk3b0jY8mQe1xVn7hT2cLw',
} as const;

const ACCOUNT_ERRORS = ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'] as const;

/** `GET /store/v1/me/tickets`. */
export const listMyTickets = defineRoute({
  key: 'GET /store/v1/me/tickets',
  summary: 'My support tickets',
  description:
    'The signed-in customer’s own tickets: every ticket whose requester is the customer, those filed as a guest with the same address ' +
    'included. Newest activity first (`updatedAt` descending); sort by `updatedAt` or `createdAt`; filter by `status` (repeat the key ' +
    'for IN; `pending` means the team waits for the customer); at most 50 a page; there is no search. Each row carries the ticket ' +
    '`token`: open the conversation with the token routes (`GET /store/v1/tickets/:token`, `…/stream`, `…/messages`). A row is ' +
    '`hasUnread` while support wrote a message the page has not marked as seen (`POST …/read`). A ticket that has no link any more ' +
    '(its token was cleared by an erasure) is not listed. Never cached (`Cache-Control: no-store`): the rows hold credentials. ' +
    'The link of a ticket resolved more than 180 days ago no longer opens it (`404` on the token routes).',
  tags: ['support-tickets'],
  surface: 'store',
  access: 'customer-session',
  query: accountTicketListQuery(),
  success: { status: 200, schema: MyTicketRowSchema },
  errors: ['VALIDATION_FAILED', ...ACCOUNT_ERRORS],
  examples: { response: [ROW_EXAMPLE] },
});

/** `POST /store/v1/me/tickets`. */
export const openMyTicket = defineRoute({
  key: 'POST /store/v1/me/tickets',
  summary: 'Open a support ticket when signed in',
  description:
    'Opens a ticket for the signed-in customer: no email, no anti-bot token (the session proves who they are). `orderId` must be one of ' +
    'the customer’s own orders (`422` on `orderId`, `unknown_order`, for any other, an unknown one included). `fileIds` attaches ' +
    'files uploaded with `POST /store/v1/files` (at most 5, the customer’s own PDF, JPEG or PNG of 5 MiB); the first `message` may be ' +
    '`""` when a file is attached. The ticket starts `new` with the priority of its category and a reply target, and the customer gets ' +
    'the receipt email. The answer is the ticket with its link `token` at once. A customer opens 5 tickets an hour (`429 RATE_LIMITED` ' +
    'with `Retry-After`). Never cached.',
  tags: ['support-tickets'],
  surface: 'store',
  access: 'customer-session',
  body: OpenAccountTicketBody,
  success: { status: 201, schema: StoreTicketSchema.extend({ token: TicketLinkTokenSchema }) },
  errors: ['VALIDATION_FAILED', 'CSRF_FAILED', 'RATE_LIMITED', ...ACCOUNT_ERRORS],
  examples: {
    request: {
      subject: 'Where is my unlock?',
      message: 'I paid yesterday and still have no code.',
      category: 'delay',
      orderId: 20431,
      fileIds: [7001],
    },
    response: {
      number: 'T-1042',
      subject: 'Where is my unlock?',
      category: 'delay',
      status: 'new',
      orderId: 20431,
      createdAt: '2026-11-08T09:30:00.000Z',
      updatedAt: '2026-11-08T09:30:00.000Z',
      resolvedAt: null,
      csatScore: null,
      canRate: false,
      messages: [
        {
          id: 9000,
          from: 'you',
          body: 'I paid yesterday and still have no code.',
          createdAt: '2026-11-08T09:30:00.000Z',
          attachments: [{ id: 7001, filename: 'payment.png', mime: 'image/png', size: 48213 }],
        },
      ],
      seenByYou: null,
      seenBySupport: null,
      seenBySupportAt: null,
      token: 'Zk3b0jY8mQe1xVn7hT2cLw',
    },
  },
});
