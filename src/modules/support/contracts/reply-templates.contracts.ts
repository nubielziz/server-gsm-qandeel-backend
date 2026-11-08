// Route contracts of the reply templates (map domain J, routes /admin/reply-templates, stage 17): list, show, create, change and delete.
// Shapes match the console's ReplyTemplate (docs/contract/endpoints/support.md, RESOLUTIONS b2c-9).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { TICKET_CATEGORIES } from '../db/schema';
import { TEMPLATE_LOCALES, isValidShortcut } from '../domain/template-rules';
import { MAX_MESSAGE_LENGTH, TicketCategorySchema } from './shared';

/** A template as the console reads it. */
export const ReplyTemplateSchema = z.object({
  id: zId,
  title: z.string(),
  category: TicketCategorySchema,
  locale: z.string().describe('`en` or `ar`.'),
  body: z.string().describe('The raw text with `{{name}}`, `{{order}}` and `{{eta}}`: the console fills them in.'),
  shortcut: z.string().describe("'' when the template has none; otherwise a slash word such as `/refund`."),
  createdBy: zId.nullable(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});

const TEMPLATE_EXAMPLE = {
  id: 3,
  title: 'Order is in progress',
  category: 'delay',
  locale: 'en',
  body: 'Hi {{name}}, thanks for your patience. Your order {{order}} is with the carrier and the usual time for this service is {{eta}}.',
  shortcut: '/progress',
  createdBy: 1,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
} as const;

const Title = z.string().trim().min(1, 'Give the template a title.').max(120, 'Use at most 120 characters.');
const Body = z
  .string()
  .trim()
  .min(1, 'Write the reply text.')
  .max(MAX_MESSAGE_LENGTH, `Use at most ${MAX_MESSAGE_LENGTH} characters.`);
const Locale = z
  .string()
  .trim()
  .refine((value) => (TEMPLATE_LOCALES as readonly string[]).includes(value), 'Choose a language.')
  .describe('`en` or `ar`.');
const Shortcut = z
  .string()
  .trim()
  .refine(isValidShortcut, 'A shortcut starts with a slash, like /refund.')
  .describe("'' for none, otherwise `/` and up to 39 characters with no space; unique ignoring case.");

const ID_PARAMS = z.object({ id: zIdParam });
const CREATE_BODY = z.object({
  title: Title,
  category: TicketCategorySchema,
  locale: Locale,
  body: Body,
  shortcut: Shortcut,
});

/** `GET /admin/reply-templates`. */
export const listReplyTemplates = defineRoute({
  key: 'GET /admin/reply-templates',
  summary: 'Reply templates',
  description:
    'The canned replies, A to Z by title by default. The console loads them whole (`_end=200`). Filters: `category`, `locale`. `q` is a ' +
    'case-insensitive contains over the title, the text and the shortcut.',
  tags: ['reply-templates'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:read',
  query: listQuery({
    sorts: ['title', 'category', 'createdAt', 'updatedAt', 'id'],
    defaultSort: { field: 'title', order: 'asc' },
    filters: {
      category: { type: 'enum', values: [...TICKET_CATEGORIES], ops: ['eq'] },
      locale: { type: 'string', ops: ['eq'] },
    },
    search: ['title', 'body', 'shortcut'],
  }),
  success: { status: 200, schema: ReplyTemplateSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [TEMPLATE_EXAMPLE] },
});

/** `GET /admin/reply-templates/:id`. */
export const showReplyTemplate = defineRoute({
  key: 'GET /admin/reply-templates/:id',
  summary: 'One reply template',
  tags: ['reply-templates'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:read',
  params: ID_PARAMS,
  success: { status: 200, schema: ReplyTemplateSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: TEMPLATE_EXAMPLE },
});

/** `POST /admin/reply-templates`. */
export const createReplyTemplate = defineRoute({
  key: 'POST /admin/reply-templates',
  summary: 'Create a reply template',
  description:
    'All five fields are trimmed. `shortcut` may be `""`; otherwise it starts with `/` and is unique ignoring case: another template ' +
    'with it is `409 SHORTCUT_TAKEN` (the detail names it; no `errors[]`). An empty shortcut is stored as null, so any number of templates ' +
    'may have none. The text is stored raw: the server renders no variables. `createdBy` is the caller.',
  tags: ['reply-templates'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:create',
  body: CREATE_BODY,
  success: { status: 201, schema: ReplyTemplateSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'SHORTCUT_TAKEN'],
  examples: {
    request: {
      title: 'Order is in progress',
      category: 'delay',
      locale: 'en',
      body: TEMPLATE_EXAMPLE.body,
      shortcut: '/progress',
    },
    response: TEMPLATE_EXAMPLE,
  },
});

/** `PATCH /admin/reply-templates/:id`. */
export const updateReplyTemplate = defineRoute({
  key: 'PATCH /admin/reply-templates/:id',
  summary: 'Change a reply template',
  description:
    'Only the keys sent change; each follows the rules of create. A shortcut another template has is `409 SHORTCUT_TAKEN`. `updatedAt` ' +
    'moves forward.',
  tags: ['reply-templates'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:update',
  params: ID_PARAMS,
  body: CREATE_BODY.partial().refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    'Send at least one field to change.',
  ),
  success: { status: 200, schema: ReplyTemplateSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'SHORTCUT_TAKEN'],
  examples: { request: { shortcut: '/progress' }, response: TEMPLATE_EXAMPLE },
});

/** `DELETE /admin/reply-templates/:id`. */
export const deleteReplyTemplate = defineRoute({
  key: 'DELETE /admin/reply-templates/:id',
  summary: 'Delete a reply template',
  description: 'A hard delete. Replies already sent keep their text.',
  tags: ['reply-templates'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:delete',
  params: ID_PARAMS,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
