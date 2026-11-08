// Route contracts of the notification templates (map domain G, stage 12, routes /admin/notification-templates): the list, one template,
// create, change, delete and the preview. Shapes match the console's `NotificationTemplate` (docs/contract/endpoints/platform.md).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { NOTIFICATION_AUDIENCES, NOTIFICATION_CHANNELS } from '../db/schema';

/** One template with the count the console shows as "Sent, 30 days". */
const TemplateRow = z.object({
  id: zId,
  event: z.string().describe('The event key, such as `order.completed`.'),
  channel: z.enum(NOTIFICATION_CHANNELS),
  audience: z.enum(NOTIFICATION_AUDIENCES),
  locale: z.string().describe('A language code such as `en` or `en-GB`.'),
  subject: z.string().describe("The email subject; '' for a Telegram template."),
  body: z.string().describe('The message with `{{placeholders}}`; HTML when it has markup.'),
  isActive: z.boolean().describe('Off means the message is not sent.'),
  sentLast30Days: z
    .number()
    .int()
    .describe('Messages of the same event, channel and audience sent in the last 30 days, across all languages.'),
  createdAt: zIsoDateTime,
  // Optional like the console's own type; the server always sends it.
  updatedAt: zIsoDateTime.optional().describe('When the template last changed; always sent.'),
});

const TEMPLATE_EXAMPLE = {
  id: 7,
  event: 'wallet.low_balance',
  channel: 'email',
  audience: 'merchant',
  locale: 'en',
  subject: 'Your wallet balance is low',
  body: 'Hi {{merchantName}},\n\nYour available balance is {{available}} {{currency}}, below your alert level of {{threshold}} {{currency}}.',
  isActive: true,
  sentLast30Days: 12,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
} as const;

const RULES =
  'The event must be registered for the audience (`event` is 422 otherwise) and offer the channel; the placeholders of the subject and body ' +
  'come only from the event’s variables (422 on `subject` or `body`); an email needs a subject; the language is `en` or `en-GB` style. ' +
  'One template per event, channel, audience and language: a second one is 422 on `event`.';

/** `GET /admin/notification-templates`. */
export const listNotificationTemplates = defineRoute({
  key: 'GET /admin/notification-templates',
  summary: 'Notification templates',
  description:
    'The email and Telegram templates for each event, `event` A to Z by default. `sentLast30Days` counts the notifications sent with the ' +
    'same event and channel to the same kind of recipient (a merchant, a customer, staff) since 30 days ago, whatever their language. ' +
    '`q` is a case-insensitive contains over the event and the subject.',
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'notifications:read',
  query: listQuery({
    sorts: ['event', 'channel', 'audience', 'createdAt', 'id'],
    defaultSort: { field: 'event', order: 'asc' },
    filters: {
      audience: { type: 'enum', values: [...NOTIFICATION_AUDIENCES], ops: ['eq'] },
      channel: { type: 'enum', values: [...NOTIFICATION_CHANNELS], ops: ['eq'] },
      isActive: { type: 'boolean', ops: ['eq'] },
      event: { type: 'string', ops: ['eq'] },
      locale: { type: 'string', ops: ['eq'] },
    },
    search: ['event', 'subject'],
  }),
  success: { status: 200, schema: TemplateRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [TEMPLATE_EXAMPLE] },
});

/** `GET /admin/notification-templates/:id`. */
export const showNotificationTemplate = defineRoute({
  key: 'GET /admin/notification-templates/:id',
  summary: 'One notification template',
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'notifications:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: TemplateRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: TEMPLATE_EXAMPLE },
});

/** `POST /admin/notification-templates`. */
export const createNotificationTemplate = defineRoute({
  key: 'POST /admin/notification-templates',
  summary: 'Add a notification template',
  description: `Adds a template for an event, channel, audience and language. ${RULES} Writes the audit entry \`created notification template\`.`,
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'notifications:create',
  body: z.object({
    event: z.string().trim(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    audience: z.enum(NOTIFICATION_AUDIENCES),
    locale: z.string().trim().default('en'),
    subject: z.string().trim().default(''),
    body: z.string(),
    isActive: z.boolean().default(true),
  }),
  success: { status: 201, schema: TemplateRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      event: 'wallet.low_balance',
      channel: 'email',
      audience: 'merchant',
      locale: 'en',
      subject: 'Your wallet balance is low',
      body: 'Hi {{merchantName}},\n\nYour available balance is {{available}} {{currency}}, below your alert level of {{threshold}} {{currency}}.',
      isActive: true,
    },
    response: { ...TEMPLATE_EXAMPLE, sentLast30Days: 0 },
  },
});

/** `PATCH /admin/notification-templates/:id`. */
export const updateNotificationTemplate = defineRoute({
  key: 'PATCH /admin/notification-templates/:id',
  summary: 'Change a notification template',
  description:
    'Changes `subject`, `body` and `isActive` (the Send switch sends only `{ isActive }`). `event`, `channel`, `audience` and `locale` are fixed after ' +
    `create: sending one with another value is 422 on that field; the same value is accepted. ${RULES} Writes the audit entry ` +
    '`edited notification template`, or `turned on notification` / `turned off notification` (the demo’s phrases) when the request carries only the switch. A request that changes nothing still writes its entry (every staff write is audited).',
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'notifications:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    event: z.string().trim().optional(),
    channel: z.enum(NOTIFICATION_CHANNELS).optional(),
    audience: z.enum(NOTIFICATION_AUDIENCES).optional(),
    locale: z.string().trim().optional(),
    subject: z.string().trim().optional(),
    body: z.string().optional(),
    isActive: z.boolean().optional(),
  }),
  success: { status: 200, schema: TemplateRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { isActive: false }, response: { ...TEMPLATE_EXAMPLE, isActive: false } },
});

/** `DELETE /admin/notification-templates/:id`. */
export const deleteNotificationTemplate = defineRoute({
  key: 'DELETE /admin/notification-templates/:id',
  summary: 'Delete a notification template',
  description:
    'Deletes the template: that event, channel, audience and language send nothing until a template is added again. Writes the audit entry `deleted notification template`.',
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'notifications:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});

/** `POST /admin/notification-templates/:id/preview`. */
export const previewNotificationTemplate = defineRoute({
  key: 'POST /admin/notification-templates/:id/preview',
  summary: 'Preview a notification template',
  description:
    'Renders the template with sample data and sends nothing. An empty body previews the saved text; `{ subject, body }` previews unsaved text. ' +
    'An unknown placeholder is left as typed, so a typo shows. `format` says whether `body` is plain `text` or `html` (an HTML template: ' +
    'the values are escaped); the console shows HTML only in a sandboxed frame. A Telegram preview has an empty subject. `from` is the sender (the mail address or the bot). ' +
    'Changes nothing (a POST only because the unsaved text travels in the body), so it writes no audit row.',
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'notifications:read',
  audit: false,
  params: z.object({ id: zIdParam }),
  body: z.object({ subject: z.string().optional(), body: z.string().optional() }).default({}),
  success: {
    status: 200,
    schema: z.object({
      subject: z.string(),
      body: z.string(),
      format: z.enum(['text', 'html']),
      from: z.string(),
      note: z.string(),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
  examples: {
    request: {},
    response: {
      subject: 'Your wallet balance is low',
      body: 'Hi Zain Mobile Hub,\n\nYour available balance is 42.5000 USD, below your alert level of 50.0000 USD.',
      format: 'text',
      from: 'GSM <noreply@gsm.local>',
      note: 'A sample with made-up details.',
    },
  },
});
