// Route contracts of the storefront support routes (map domain J, stage 17): open a ticket, read it, write on it and rate it. The console
// has no screen for them (the storefront is another frontend): the shapes follow ALIGNMENT § 7 and are written up in the module README.
// The ticket token is the whole credential of the three token routes (decision 010, 018).
import { z } from 'zod';
import { defineRoute, zId, zIsoDateTime } from '../../../common/contract';
import { TicketCategorySchema, WireStatusSchema, messageText } from './shared';

/** One message of the thread as the customer reads it: theirs or support's; notes and system messages never appear. */
export const StoreMessageSchema = z.object({
  id: zId,
  from: z.enum(['you', 'support']).describe('`you` is the requester, `support` is the team.'),
  body: z.string(),
  createdAt: zIsoDateTime,
});

/** A ticket as the customer reads it. */
export const StoreTicketSchema = z.object({
  number: z.string().describe("The ticket number to quote, 'T-1042' style."),
  subject: z.string(),
  category: TicketCategorySchema,
  status: WireStatusSchema.describe('`pending` means the team waits for the customer.'),
  orderId: zId.nullable().describe('The order the ticket is about, when it has one.'),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
  resolvedAt: zIsoDateTime.nullable(),
  csatScore: z.number().int().min(1).max(5).nullable().describe('The rating the customer gave, once.'),
  canRate: z.boolean().describe('True while the ticket is resolved and not yet rated.'),
  messages: z.array(StoreMessageSchema).describe('Oldest first, without internal notes.'),
});

const TICKET_EXAMPLE = {
  number: 'T-1042',
  subject: 'Where is my unlock? (SF-20431)',
  category: 'delay',
  status: 'pending',
  orderId: 20431,
  createdAt: '2026-11-08T09:30:00.000Z',
  updatedAt: '2026-11-08T10:12:00.000Z',
  resolvedAt: null,
  csatScore: null,
  canRate: false,
  messages: [
    { id: 9000, from: 'you', body: 'I paid yesterday and still have no code.', createdAt: '2026-11-08T09:30:00.000Z' },
    {
      id: 9001,
      from: 'support',
      body: 'Hi, your order is with the carrier and should finish within the hour.',
      createdAt: '2026-11-08T10:12:00.000Z',
    },
  ],
} as const;

const TOKEN_PARAMS = z.object({ token: z.string().min(16).max(128).describe('The ticket token.') });
const NO_STORE = 'Never cached: the answer holds a credential or sits behind it.';

const OpenBody = z
  .object({
    email: z
      .string()
      .trim()
      .max(254, 'Too long.')
      .pipe(z.email('Enter a valid email address.'))
      .transform((value) => value.toLowerCase())
      .optional()
      .describe('Where the answers go. Needed unless `orderToken` names the order of a customer who already gave one.'),
    name: z
      .string()
      .trim()
      .max(100, 'Use at most 100 characters.')
      .optional()
      .describe('Used for a first-time visitor.'),
    subject: z.string().trim().min(1, 'Enter a subject.').max(150, 'Use at most 150 characters.'),
    message: messageText('Write your message.'),
    category: TicketCategorySchema.optional().describe('Default `other`; the category sets the reply target.'),
    orderToken: z
      .string()
      .trim()
      .min(16, 'This order link is not valid.')
      .max(128, 'This order link is not valid.')
      .optional()
      .describe(
        'The tracking token of the order the ticket is about; the ticket links to it and belongs to its customer.',
      ),
  })
  .refine((body) => body.email !== undefined || body.orderToken !== undefined, {
    message: 'Enter your email address.',
    path: ['email'],
  });

/** `POST /store/v1/tickets`. */
export const openStoreTicket = defineRoute({
  key: 'POST /store/v1/tickets',
  summary: 'Open a support ticket',
  description:
    'Opens a ticket from the order page or the contact page, with no account. `orderToken` (the tracking token of the order) links the ' +
    'ticket to the order and to its customer; without it `email` is needed, and a first-time address becomes a guest customer. An ' +
    'unknown or non-storefront `orderToken` is `422` on `orderToken`. The ticket starts `new` with the priority of its category and a ' +
    'reply target; the customer gets a receipt email whose link holds the ticket token, the whole credential of the next three routes. ' +
    'The answer carries `token` only when `orderToken` was given (the caller already holds the order link); with `email` alone it has no ' +
    'token, because anyone can type an address and the ticket is filed under the customer who owns it: the receipt link is the only way in. ' +
    'An address may open 3 new tickets an hour (case-insensitive), so the receipt email cannot relay spam: the fourth is `429 RATE_LIMITED` ' +
    `with \`Retry-After\`. Needs the anti-bot token (\`X-Turnstile-Token\`). ${NO_STORE}`,
  tags: ['support-tickets'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  body: OpenBody,
  success: {
    status: 201,
    schema: StoreTicketSchema.extend({
      token: z
        .string()
        .optional()
        .describe('The ticket token. Present only when `orderToken` was given; with `email` alone it is left out.'),
    }),
  },
  errors: ['VALIDATION_FAILED', 'RATE_LIMITED'],
  examples: {
    request: {
      email: 'victor@mail.example',
      subject: 'Where is my unlock?',
      message: 'I paid yesterday and still have no code.',
      category: 'delay',
      orderToken: 'T7kq2Zp9Xw4Ld1Hn6Rb3Yc',
    },
    response: { ...TICKET_EXAMPLE, token: 'Zk3b0jY8mQe1xVn7hT2cLw' },
  },
});

/** `GET /store/v1/tickets/:token`. */
export const showStoreTicket = defineRoute({
  key: 'GET /store/v1/tickets/:token',
  summary: 'Show a support ticket',
  description:
    'The conversation of the ticket the token names, without internal notes or system messages. An unknown, malformed or wrong token is ' +
    `\`404\`. Lookups are limited to 30 a minute per address. ${NO_STORE}`,
  tags: ['support-tickets'],
  surface: 'store',
  access: 'ticket-token',
  params: TOKEN_PARAMS,
  success: { status: 200, schema: StoreTicketSchema },
  errors: ['NOT_FOUND'],
  examples: { response: TICKET_EXAMPLE },
});

/** `POST /store/v1/tickets/:token/messages`. */
export const writeOnStoreTicket = defineRoute({
  key: 'POST /store/v1/tickets/:token/messages',
  summary: 'Write on a support ticket',
  description:
    "The customer's reply. A resolved ticket is reopened (`open`, `resolvedAt` cleared) and a ticket that waited on the customer goes back " +
    'to `open`; the reply target restarts from this message. The answer is the new message.',
  tags: ['support-tickets'],
  surface: 'store',
  access: 'ticket-token',
  params: TOKEN_PARAMS,
  body: z.object({ body: messageText('Write your message.') }),
  success: { status: 201, schema: StoreMessageSchema },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { body: 'Here is the photo. Same message after restart.' },
    response: {
      id: 9002,
      from: 'you',
      body: 'Here is the photo. Same message after restart.',
      createdAt: '2026-11-08T11:00:00.000Z',
    },
  },
});

/** `POST /store/v1/tickets/:token/csat`. */
export const rateStoreTicket = defineRoute({
  key: 'POST /store/v1/tickets/:token/csat',
  summary: 'Rate a resolved support ticket',
  description:
    'The satisfaction rating, 1 to 5, once, after the ticket is resolved (the survey email links to it). A ticket that is not resolved, or ' +
    'was already rated, is `422` on `score`. The ticket stays resolved: the rating only sets `csatScore`. The answer is the ticket.',
  tags: ['support-tickets'],
  surface: 'store',
  access: 'ticket-token',
  params: TOKEN_PARAMS,
  body: z.object({
    score: z
      .number('Choose a rating from 1 to 5.')
      .int('Choose a rating from 1 to 5.')
      .min(1, 'Choose a rating from 1 to 5.')
      .max(5, 'Choose a rating from 1 to 5.'),
  }),
  success: { status: 200, schema: StoreTicketSchema },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { score: 5 },
    response: {
      ...TICKET_EXAMPLE,
      status: 'resolved',
      resolvedAt: '2026-11-08T12:00:00.000Z',
      csatScore: 5,
      canRate: false,
    },
  },
});
