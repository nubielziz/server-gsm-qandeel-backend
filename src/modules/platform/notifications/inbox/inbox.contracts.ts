// Route contracts of the inbox (feature 23, plan section 10.4; routes beyond the map, scripts/map-additions/23.mjs): four routes on each of
// the three surfaces, with one shape. The staff console (`/admin/inbox`), the merchant portal (`/client/notifications`) and the storefront
// account (`/store/v1/me/notifications`) read the same table for different people.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../../common/contract';
import { NOTIFICATION_INBOX_CATEGORIES } from '../../db/schema';

/** The wire shape of one item. */
const zInboxItem = z.object({
  id: zId,
  category: z.enum(NOTIFICATION_INBOX_CATEGORIES),
  title: z.string().describe('Plain text: render it as text, never as HTML.'),
  body: z.string().describe('Plain text with line breaks: render it as text, never as HTML.'),
  link: z
    .string()
    .nullable()
    .describe('A site path without the language prefix (for example `/account/orders`), or `null`.'),
  locale: z.enum(['en', 'ar']).describe('The language `title` and `body` are in.'),
  readAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  campaignId: zId.nullable().describe('Set for an item that came from a broadcast.'),
  event: z.string().nullable().describe('Set for an item that came from an event (an order result, a low balance).'),
});

const zUnread = z.object({
  unread: z.number().int().min(0).max(100).describe('Capped at 100: show "99+" when it is 100.'),
});
const zReadAllBody = z.strictObject({
  upToId: zId
    .optional()
    .describe('The newest item id the screen showed: an item that arrived after it stays unread. Omit for every item.'),
});
/** The body is optional: no body marks every unread item. */
const zReadAllInput = zReadAllBody.default({});
const zReadAllResult = z.object({ updated: z.number().int().min(0) });

const ITEM_EXAMPLE = {
  id: 41,
  category: 'announcement',
  title: 'Scheduled maintenance on Friday',
  body: 'Hello Daniel,\nThe portal will be read-only on Friday from 02:00 to 03:00 UTC.',
  link: null,
  locale: 'en',
  readAt: null,
  createdAt: '2026-11-10T09:06:00.000Z',
  campaignId: 1,
  event: null,
} as const;

const listQueryOf = () =>
  listQuery({
    sorts: ['createdAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { category: { type: 'enum', values: [...NOTIFICATION_INBOX_CATEGORIES], ops: ['eq'] } },
    maxPage: 100,
    extra: {
      unread: z.enum(['true', 'false']).optional().describe('`true` for unread items only, `false` for read ones.'),
      locale: z
        .enum(['en', 'ar'])
        .optional()
        .describe('The reader’s page language; default: a customer’s saved language, English for the others.'),
    },
  });

const LIST_DESCRIPTION =
  'The signed-in person’s own notifications, newest first (`_start`, `_end` up to 100 per page, `x-total-count`). `category` filters, ' +
  '`unread=true` shows only the unread ones, `locale` picks the language of the text. Items of a cancelled broadcast are hidden. ' +
  'Personal data: never cached, and clients must not cache it.';
const UNREAD_DESCRIPTION =
  'How many notifications the signed-in person has not read, capped at 100 (show "99+"). Personal data: never cached.';
const READ_DESCRIPTION =
  'Marks one of the signed-in person’s notifications read. Repeating it is fine (`204` again). Another person’s id, or an id that does ' +
  'not exist, is `404` (never `403`, so ids cannot be probed).';
const READ_ALL_DESCRIPTION =
  'Marks the signed-in person’s unread notifications read, up to `upToId` when given (the newest id on screen, so an item that arrives ' +
  'during the click stays unread). Answers how many it marked.';
const STAFF_OWN_STATE =
  ' A staff member’s own read state; not an admin write, so no audit row is written (the reason of `audit: false`).';

const ADMIN = { tags: ['notifications'], surface: 'admin', access: 'staff-session' } as const;
const CLIENT = {
  tags: ['notifications'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
} as const;
const STORE = { tags: ['account'], surface: 'store', access: 'customer-session' } as const;
const ID = z.object({ id: zIdParam });

const ADMIN_ERRORS = ['UNAUTHORIZED', 'VALIDATION_FAILED'] as const;
const CLIENT_ERRORS = ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'VALIDATION_FAILED'] as const;
const STORE_ERRORS = ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'] as const;

/** `GET /admin/inbox`: the staff member's own notifications. */
export const listStaffInbox = defineRoute({
  ...ADMIN,
  key: 'GET /admin/inbox',
  summary: 'My notifications',
  description: LIST_DESCRIPTION,
  query: listQueryOf(),
  success: { status: 200, schema: zInboxItem },
  errors: [...ADMIN_ERRORS],
  examples: { response: [ITEM_EXAMPLE] },
});

/** `GET /admin/inbox/unread-count`. */
export const staffUnreadCount = defineRoute({
  ...ADMIN,
  key: 'GET /admin/inbox/unread-count',
  summary: 'How many notifications are unread',
  description: UNREAD_DESCRIPTION,
  success: { status: 200, schema: zUnread },
  errors: ['UNAUTHORIZED'],
  examples: { response: { unread: 3 } },
});

/** `POST /admin/inbox/:id/read`. */
export const markStaffInboxRead = defineRoute({
  ...ADMIN,
  key: 'POST /admin/inbox/:id/read',
  summary: 'Mark a notification read',
  description: READ_DESCRIPTION + STAFF_OWN_STATE,
  audit: false,
  params: ID,
  success: { status: 204 },
  errors: [...ADMIN_ERRORS, 'NOT_FOUND', 'CSRF_FAILED'],
});

/** `POST /admin/inbox/read-all`. */
export const markAllStaffInboxRead = defineRoute({
  ...ADMIN,
  key: 'POST /admin/inbox/read-all',
  summary: 'Mark all notifications read',
  description: READ_ALL_DESCRIPTION + STAFF_OWN_STATE,
  audit: false,
  body: zReadAllInput,
  success: { status: 200, schema: zReadAllResult },
  errors: [...ADMIN_ERRORS, 'CSRF_FAILED'],
  examples: { request: { upToId: 41 }, response: { updated: 3 } },
});

/** `GET /client/notifications`: the merchant's own notifications. */
export const listMerchantInbox = defineRoute({
  ...CLIENT,
  key: 'GET /client/notifications',
  summary: 'My notifications',
  description: `${LIST_DESCRIPTION} Open to a merchant waiting for approval.`,
  query: listQueryOf(),
  success: { status: 200, schema: zInboxItem },
  errors: [...CLIENT_ERRORS],
  examples: { response: [{ ...ITEM_EXAMPLE, category: 'wallet', title: 'Low wallet balance', campaignId: null }] },
});

/** `GET /client/notifications/unread-count`. */
export const merchantUnreadCount = defineRoute({
  ...CLIENT,
  key: 'GET /client/notifications/unread-count',
  summary: 'How many notifications are unread',
  description: UNREAD_DESCRIPTION,
  success: { status: 200, schema: zUnread },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED'],
  examples: { response: { unread: 3 } },
});

/** `POST /client/notifications/:id/read`. */
export const markMerchantInboxRead = defineRoute({
  ...CLIENT,
  key: 'POST /client/notifications/:id/read',
  summary: 'Mark a notification read',
  description: READ_DESCRIPTION,
  params: ID,
  success: { status: 204 },
  errors: [...CLIENT_ERRORS, 'NOT_FOUND', 'CSRF_FAILED'],
});

/** `POST /client/notifications/read-all`. */
export const markAllMerchantInboxRead = defineRoute({
  ...CLIENT,
  key: 'POST /client/notifications/read-all',
  summary: 'Mark all notifications read',
  description: READ_ALL_DESCRIPTION,
  body: zReadAllInput,
  success: { status: 200, schema: zReadAllResult },
  errors: [...CLIENT_ERRORS, 'CSRF_FAILED'],
  examples: { request: { upToId: 41 }, response: { updated: 3 } },
});

/** `GET /store/v1/me/notifications`: the customer's own notifications. */
export const listCustomerInbox = defineRoute({
  ...STORE,
  key: 'GET /store/v1/me/notifications',
  summary: 'My notifications',
  description: LIST_DESCRIPTION,
  query: listQueryOf(),
  success: { status: 200, schema: zInboxItem },
  errors: [...STORE_ERRORS],
  examples: {
    response: [
      {
        ...ITEM_EXAMPLE,
        category: 'order',
        title: 'Order 4021 completed',
        body: 'Your order for Vodafone UK iPhone Unlock is complete.',
        link: '/account/orders',
        campaignId: null,
        event: 'order.completed',
      },
    ],
  },
});

/** `GET /store/v1/me/notifications/unread-count`. */
export const customerUnreadCount = defineRoute({
  ...STORE,
  key: 'GET /store/v1/me/notifications/unread-count',
  summary: 'How many notifications are unread',
  description: UNREAD_DESCRIPTION,
  success: { status: 200, schema: zUnread },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'],
  examples: { response: { unread: 3 } },
});

/** `POST /store/v1/me/notifications/:id/read`. */
export const markCustomerInboxRead = defineRoute({
  ...STORE,
  key: 'POST /store/v1/me/notifications/:id/read',
  summary: 'Mark a notification read',
  description: READ_DESCRIPTION,
  params: ID,
  success: { status: 204 },
  errors: [...STORE_ERRORS, 'NOT_FOUND', 'CSRF_FAILED'],
});

/** `POST /store/v1/me/notifications/read-all`. */
export const markAllCustomerInboxRead = defineRoute({
  ...STORE,
  key: 'POST /store/v1/me/notifications/read-all',
  summary: 'Mark all notifications read',
  description: READ_ALL_DESCRIPTION,
  body: zReadAllInput,
  success: { status: 200, schema: zReadAllResult },
  errors: [...STORE_ERRORS, 'CSRF_FAILED'],
  examples: { request: { upToId: 41 }, response: { updated: 3 } },
});
