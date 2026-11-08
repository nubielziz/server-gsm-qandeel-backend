// Route contracts of the notification log (map domain G, stage 12, routes /admin/notifications): the list and one notification. Read-only.
// Shapes match the console's `NotificationLogEntry` (docs/contract/endpoints/platform.md, MISMATCHES B72, B73).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zJsonObject } from '../../../common/contract';
import { NOTIFICATION_CHANNELS, NOTIFICATION_RECIPIENT_TYPES, NOTIFICATION_STATUSES } from '../db/schema';

/** One logged notification; the detail adds `payload`. */
const LogRow = z.object({
  id: zId,
  recipientType: z.enum(NOTIFICATION_RECIPIENT_TYPES),
  recipientId: z
    .number()
    .int()
    .min(0)
    .describe(
      'The recipient row id; `0` with `recipientType` `staff` names the ops address or chat that alert messages go to (feature 12b).',
    ),
  channel: z.enum(NOTIFICATION_CHANNELS),
  event: z.string().describe('The event key, such as `wallet.low_balance`.'),
  status: z.enum(NOTIFICATION_STATUSES),
  recipient: z.string().describe('The address or chat the server masked: `r***@example.com`, `@1***`.'),
  attempts: z.number().int().optional().describe('How many sends were tried; always sent.'),
  sentAt: zIsoDateTime.nullable().describe('Null until sent.'),
  error: z.string().nullable().describe('Why it failed; null unless the status is `failed`.'),
  payload: zJsonObject
    .optional()
    .describe('The data the message was built from (never a secret). Only on the single read.'),
  createdAt: zIsoDateTime,
  // Optional like the console's own type; the server always sends it.
  updatedAt: zIsoDateTime.optional().describe('When the row last changed; always sent.'),
});

const ROW_EXAMPLE = {
  id: 311,
  recipientType: 'client',
  recipientId: 1,
  channel: 'email',
  event: 'wallet.low_balance',
  status: 'sent',
  recipient: 'o***@zainmobilehub.example',
  attempts: 1,
  sentAt: '2026-11-01T10:00:04.000Z',
  error: null,
  createdAt: '2026-11-01T10:00:01.000Z',
  updatedAt: '2026-11-01T10:00:04.000Z',
} as const;

/** `GET /admin/notifications`: the log of notifications, newest first. */
export const listNotificationLog = defineRoute({
  key: 'GET /admin/notifications',
  summary: 'Notification log',
  description:
    'Every message the system sent or tried to send, newest first. `recipient` is masked by the server. `status` is `queued`, `sent` or `failed`; ' +
    '`error` says why a message failed. `recipientType` is `staff`, `client` (a merchant) or `customer`. The list leaves out `payload`. `q` is a ' +
    'case-insensitive contains over the event; it matches the recipient’s address only when it equals the whole address (any letter case).',
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'notifications:read',
  query: listQuery({
    sorts: ['createdAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: [...NOTIFICATION_STATUSES], ops: ['eq', 'ne'] },
      channel: { type: 'enum', values: [...NOTIFICATION_CHANNELS], ops: ['eq'] },
      event: { type: 'string', ops: ['eq'] },
      recipientType: { type: 'enum', values: [...NOTIFICATION_RECIPIENT_TYPES], ops: ['eq'] },
    },
    search: ['event', 'recipient'],
  }),
  success: { status: 200, schema: LogRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ROW_EXAMPLE] },
});

/** `GET /admin/notifications/:id`: one notification with its data. */
export const showNotificationLog = defineRoute({
  key: 'GET /admin/notifications/:id',
  summary: 'One notification',
  description:
    'The same row as the list plus `payload`, the data the message was built from. A Telegram `chatId` anywhere in the payload is masked like `recipient`.',
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'notifications:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: LogRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: {
    response: {
      ...ROW_EXAMPLE,
      payload: {
        variables: { merchantName: 'Zain Mobile Hub', available: '42.50', threshold: '50.00', currency: 'USD' },
      },
    },
  },
});
