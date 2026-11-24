// Route contracts of the notification campaigns (feature 23, plan section 10.2; routes beyond the map, scripts/map-additions/23.mjs):
// list, create, read, edit, delete, audience preview, render preview, test, send, schedule, cancel and the recipients of a campaign.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../../common/contract';
import { NOTIFICATION_CAMPAIGN_PURPOSES, NOTIFICATION_CAMPAIGN_STATUSES } from '../../db/schema';
import { zAudienceSpec } from './audience-spec';
import { CAMPAIGN_CHANNELS, MAX_CAMPAIGN_BODY_LENGTH, MAX_NAME_LENGTH, MAX_TITLE_LENGTH } from './campaign-rules';

const zChannel = z.enum(CAMPAIGN_CHANNELS);
const zChannels = z
  .array(zChannel)
  .min(1)
  .max(2)
  .refine((list) => new Set(list).size === list.length, 'A channel is listed twice.')
  .describe('`in_app` and `email`.');

const zContent = z.strictObject({
  title: z.string().min(1).max(MAX_TITLE_LENGTH).describe('Plain text; `{{name}}` is the only placeholder.'),
  body: z.string().min(1).max(MAX_CAMPAIGN_BODY_LENGTH).describe('Plain text with line breaks; `{{name}}` only.'),
});

const zPath = z.string().max(200);
const zLink = z
  .strictObject({ staff: zPath.optional(), merchant: zPath.optional(), customer: zPath.optional() })
  .describe('A site path per audience (one leading `/`, no host), such as `/account/orders`.');

/** The fields staff write. */
const inputShape = {
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  purpose: z
    .enum(NOTIFICATION_CAMPAIGN_PURPOSES)
    .describe(
      '`marketing` reaches only customers who agreed to marketing. A campaign of any purpose reaches only customers whose address is confirmed (a sign-in or verification link was used, or a checkout was paid); a marketing answer counts from then on (decision 053).',
    ),
  channels: zChannels,
  audience: zAudienceSpec,
  content: zContent,
  link: zLink.nullable().optional(),
};

const zStaffRef = z.object({ id: zId, name: z.string() });
const zCounters = z.object({ queued: z.number().int(), sent: z.number().int(), failed: z.number().int() });

const zCampaign = z.object({
  id: zId,
  name: z.string(),
  purpose: z.enum(NOTIFICATION_CAMPAIGN_PURPOSES),
  channels: z.array(zChannel),
  status: z.enum(NOTIFICATION_CAMPAIGN_STATUSES),
  scheduledAt: zIsoDateTime.nullable(),
  queuedAt: zIsoDateTime.nullable(),
  startedAt: zIsoDateTime.nullable(),
  finishedAt: zIsoDateTime.nullable(),
  cancelledAt: zIsoDateTime.nullable(),
  expectedRecipients: z.number().int().nullable().describe('The reachable count when it was sent or scheduled.'),
  recipients: z.number().int().describe('People the fan-out made at least one message for.'),
  planned: z.object({ inApp: z.number().int(), email: z.number().int() }),
  error: z.string().nullable(),
  createdBy: zStaffRef,
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});

const zCampaignDetail = zCampaign.extend({
  audience: zAudienceSpec,
  content: zContent,
  link: zLink.nullable(),
  skipped: z.object({
    optedOut: z.number().int(),
    noAccount: z.number().int(),
  }),
  delivery: z.object({
    inApp: z.object({ delivered: z.number().int(), read: z.number().int() }),
    email: zCounters,
  }),
  updatedBy: zStaffRef.nullable(),
  cancelledBy: zStaffRef.nullable(),
});

const zAudiencePreview = z.object({
  total: z.number().int().describe('Eligible people in the audience.'),
  reachable: z.number().int().describe('People at least one chosen channel reaches.'),
  byType: z.object({ staff: z.number().int(), client: z.number().int(), customer: z.number().int() }),
  byChannel: z.object({ inApp: z.number().int(), email: z.number().int() }),
  excluded: z.object({
    noConsent: z.number().int(),
    optedOut: z.number().int(),
    noAccount: z.number().int(),
  }),
});

const RECIPIENT_STATUSES = ['delivered', 'read', 'queued', 'sent', 'failed'] as const;

const zRecipient = z.object({
  id: zId,
  channel: zChannel,
  recipientType: z.enum(['staff', 'client', 'customer']),
  recipientId: zId,
  recipient: z.string().describe('The masked address or chat.'),
  status: z.enum(RECIPIENT_STATUSES),
  error: z.string().nullable(),
  attempts: z.number().int().nullable(),
  sentAt: zIsoDateTime.nullable(),
  readAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

const AUDIENCE_EXAMPLE = { staff: {}, merchants: {}, customers: { hasAccount: true } };
const CONTENT_EXAMPLE = {
  title: 'Scheduled maintenance on Friday',
  body: 'Hello {{name}},\nThe portal will be read-only on Friday from 02:00 to 03:00 UTC.',
};
const CAMPAIGN_EXAMPLE = {
  id: 1,
  name: 'Scheduled maintenance on Friday',
  purpose: 'service',
  channels: ['in_app', 'email'],
  status: 'draft',
  scheduledAt: null,
  queuedAt: null,
  startedAt: null,
  finishedAt: null,
  cancelledAt: null,
  expectedRecipients: null,
  recipients: 0,
  planned: { inApp: 0, email: 0 },
  error: null,
  createdBy: { id: 1, name: 'Rami K.' },
  createdAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T09:00:00.000Z',
} as const;
const DETAIL_EXAMPLE = {
  ...CAMPAIGN_EXAMPLE,
  audience: AUDIENCE_EXAMPLE,
  content: CONTENT_EXAMPLE,
  link: null,
  skipped: { optedOut: 0, noAccount: 0 },
  delivery: {
    inApp: { delivered: 0, read: 0 },
    email: { queued: 0, sent: 0, failed: 0 },
  },
  updatedBy: null,
  cancelledBy: null,
};
const INPUT_EXAMPLE = {
  name: 'Scheduled maintenance on Friday',
  purpose: 'service',
  channels: ['in_app', 'email'],
  audience: AUDIENCE_EXAMPLE,
  content: CONTENT_EXAMPLE,
  link: null,
};

const COMMON = {
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-permission',
} as const;
const ID = z.object({ id: zIdParam });

/** `GET /admin/notification-campaigns`: the campaigns, newest first. */
export const listCampaigns = defineRoute({
  ...COMMON,
  key: 'GET /admin/notification-campaigns',
  summary: 'Notification campaigns',
  description:
    'The campaigns staff wrote, newest first. `status` filters by state (repeat it for several, or use `status_ne`), `purpose` and ' +
    '`createdBy` (a staff id) narrow the list, `q` searches the name. The list has no delivery numbers: read one campaign for them.',
  permission: 'broadcasts:read',
  query: listQuery({
    sorts: ['createdAt', 'scheduledAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: [...NOTIFICATION_CAMPAIGN_STATUSES], ops: ['eq', 'ne'] },
      purpose: { type: 'enum', values: [...NOTIFICATION_CAMPAIGN_PURPOSES], ops: ['eq'] },
      createdBy: { type: 'id', ops: ['eq'] },
    },
    search: ['name'],
    maxPage: 100,
  }),
  success: { status: 200, schema: zCampaign },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [CAMPAIGN_EXAMPLE] },
});

/** `POST /admin/notification-campaigns`: a new draft. */
export const createCampaign = defineRoute({
  ...COMMON,
  key: 'POST /admin/notification-campaigns',
  summary: 'Create a campaign',
  description:
    'Saves a campaign as a draft: a name, a purpose, the channels, the audience, the message (a title and a body) and an ' +
    'optional site link per audience. Text is plain text with `{{name}}` as the only placeholder; HTML is refused. Nothing is sent.',
  permission: 'broadcasts:send',
  body: z.strictObject(inputShape),
  success: { status: 201, schema: zCampaignDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: { request: INPUT_EXAMPLE, response: DETAIL_EXAMPLE },
});

/** `GET /admin/notification-campaigns/:id`: one campaign with its delivery numbers. */
export const showCampaign = defineRoute({
  ...COMMON,
  key: 'GET /admin/notification-campaigns/:id',
  summary: 'One campaign',
  description:
    'The campaign with its audience, content, what the fan-out planned and skipped, and live delivery numbers: in-app items made ' +
    'and read, email messages queued, sent and failed.',
  permission: 'broadcasts:read',
  params: ID,
  success: { status: 200, schema: zCampaignDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: DETAIL_EXAMPLE },
});

/** `PATCH /admin/notification-campaigns/:id`: edit a draft or a scheduled campaign. */
export const updateCampaign = defineRoute({
  ...COMMON,
  key: 'PATCH /admin/notification-campaigns/:id',
  summary: 'Edit a campaign',
  description:
    'Changes any of the fields of a draft or scheduled campaign (at least one). A scheduled campaign keeps its time. A campaign ' +
    'that is queued, sending or over is `409 INVALID_TRANSITION`.',
  permission: 'broadcasts:send',
  params: ID,
  body: z
    .strictObject({
      name: inputShape.name.optional(),
      purpose: inputShape.purpose.optional(),
      channels: inputShape.channels.optional(),
      audience: inputShape.audience.optional(),
      content: inputShape.content.optional(),
      link: inputShape.link,
    })
    .refine((body) => Object.keys(body).length > 0, 'Send at least one field.'),
  success: { status: 200, schema: zCampaignDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'INVALID_TRANSITION'],
  examples: { request: { name: 'Maintenance on Friday night' }, response: DETAIL_EXAMPLE },
});

/** `DELETE /admin/notification-campaigns/:id`: delete a draft. */
export const deleteCampaign = defineRoute({
  ...COMMON,
  key: 'DELETE /admin/notification-campaigns/:id',
  summary: 'Delete a draft',
  description: 'Deletes a draft. A campaign that was scheduled or sent is kept for history: cancel it instead.',
  permission: 'broadcasts:send',
  params: ID,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'NOT_A_DRAFT'],
});

/** `POST /admin/notification-campaigns/audience-preview`: how many people an audience reaches. */
export const previewAudience = defineRoute({
  ...COMMON,
  key: 'POST /admin/notification-campaigns/audience-preview',
  summary: 'Count an audience',
  description:
    'Counts the people an audience reaches with the chosen channels and purpose: in total, by type and channel, and ' +
    'who is left out and why. Answers counts only, never names or addresses. Reads counts only; nothing is written.',
  permission: 'broadcasts:read',
  audit: false,
  body: z.strictObject({
    audience: zAudienceSpec,
    channels: zChannels,
    purpose: z.enum(NOTIFICATION_CAMPAIGN_PURPOSES),
  }),
  success: { status: 200, schema: zAudiencePreview },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { audience: AUDIENCE_EXAMPLE, channels: ['in_app', 'email'], purpose: 'service' },
    response: {
      total: 1208,
      reachable: 1208,
      byType: { staff: 6, client: 402, customer: 800 },
      byChannel: { inApp: 1208, email: 1190 },
      excluded: { noConsent: 0, optedOut: 18, noAccount: 0 },
    },
  },
});

/** `POST /admin/notification-campaigns/:id/preview`: the message in one channel. */
export const previewCampaign = defineRoute({
  ...COMMON,
  key: 'POST /admin/notification-campaigns/:id/preview',
  summary: 'Preview a campaign',
  description:
    'Renders the campaign for one channel and audience with a sample name. `body` is the HTML part for email and the ' +
    'text for in-app; `note` says the preview uses sample data. Nothing is sent or written.',
  permission: 'broadcasts:read',
  audit: false,
  params: ID,
  body: z.strictObject({
    channel: zChannel,
    audience: z.enum(['staff', 'merchant', 'customer']).optional().describe('Default `customer`.'),
  }),
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
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { channel: 'in_app' },
    response: {
      subject: 'Scheduled maintenance on Friday',
      body: 'Hello Daniel,\nThe portal will be read-only on Friday from 02:00 to 03:00 UTC.',
      format: 'text',
      from: 'In-app notification',
      note: 'A sample with made-up details.',
    },
  },
});

/** `POST /admin/notification-campaigns/:id/test`: a test to the caller. */
export const testCampaign = defineRoute({
  ...COMMON,
  key: 'POST /admin/notification-campaigns/:id/test',
  summary: 'Send a test to yourself',
  description:
    'Sends the campaign to the signed-in staff member only: an in-app item and an email (default both). Allowed for a ' +
    'draft or scheduled campaign; the campaign itself does not change.',
  permission: 'broadcasts:send',
  params: ID,
  body: z.strictObject({
    channels: z
      .array(z.enum(['in_app', 'email']))
      .min(1)
      .max(2)
      .refine((list) => new Set(list).size === list.length, 'A channel is listed twice.')
      .optional(),
  }),
  success: { status: 202, schema: z.object({ queued: z.array(z.enum(['in_app', 'email'])) }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'INVALID_TRANSITION'],
  examples: { request: { channels: ['in_app', 'email'] }, response: { queued: ['in_app', 'email'] } },
});

/** `POST /admin/notification-campaigns/:id/send`: send now. */
export const sendCampaign = defineRoute({
  ...COMMON,
  key: 'POST /admin/notification-campaigns/:id/send',
  summary: 'Send a campaign now',
  description:
    'Queues a draft or scheduled campaign for sending. `confirmRecipients` is the reachable number the staff member saw; when the ' +
    'audience now differs by more than max(5, 2%) the answer is `409 CONFLICT` with the new number in `recipients`. Nobody reachable ' +
    'is a 422 on `audience`. The worker does the sending: the detail shows its progress.',
  permission: 'broadcasts:send',
  params: ID,
  body: z.strictObject({ confirmRecipients: z.number().int().min(1) }),
  success: { status: 202, schema: zCampaignDetail },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'CONFLICT',
    'INVALID_TRANSITION',
  ],
  examples: {
    request: { confirmRecipients: 1208 },
    response: { ...DETAIL_EXAMPLE, status: 'queued', queuedAt: '2026-11-10T09:05:00.000Z', expectedRecipients: 1208 },
  },
});

/** `POST /admin/notification-campaigns/:id/schedule`: schedule or reschedule. */
export const scheduleCampaign = defineRoute({
  ...COMMON,
  key: 'POST /admin/notification-campaigns/:id/schedule',
  summary: 'Schedule a campaign',
  description:
    'Sets the time a draft or scheduled campaign is sent: at least 1 minute and at most 90 days ahead. The send happens within about ' +
    'a minute of that time. Nobody reachable is a 422 on `audience`.',
  permission: 'broadcasts:send',
  params: ID,
  body: z.strictObject({ scheduledAt: zIsoDateTime }),
  success: { status: 200, schema: zCampaignDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'INVALID_TRANSITION'],
  examples: {
    request: { scheduledAt: '2026-11-14T08:00:00.000Z' },
    response: {
      ...DETAIL_EXAMPLE,
      status: 'scheduled',
      scheduledAt: '2026-11-14T08:00:00.000Z',
      expectedRecipients: 1208,
    },
  },
});

/** `POST /admin/notification-campaigns/:id/cancel`: stop a scheduled or running campaign. */
export const cancelCampaign = defineRoute({
  ...COMMON,
  key: 'POST /admin/notification-campaigns/:id/cancel',
  summary: 'Cancel a campaign',
  description:
    'Cancels a scheduled, queued or sending campaign: nothing more is made, messages not yet sent fail with "The campaign was ' +
    'cancelled." and its in-app items are hidden. A draft is deleted instead; a sent campaign is over.',
  permission: 'broadcasts:send',
  params: ID,
  success: { status: 200, schema: zCampaignDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'INVALID_TRANSITION'],
  examples: {
    response: { ...DETAIL_EXAMPLE, status: 'cancelled', cancelledAt: '2026-11-10T09:10:00.000Z' },
  },
});

/** `GET /admin/notification-campaigns/:id/recipients`: who a campaign reached on one channel. */
export const listCampaignRecipients = defineRoute({
  ...COMMON,
  key: 'GET /admin/notification-campaigns/:id/recipients',
  summary: 'Campaign recipients',
  description:
    'The people of a campaign on one channel (`channel` is required): in-app items are `delivered` or `read`, email ' +
    'messages `queued`, `sent` or `failed`. `recipient` is masked by the server.',
  permission: 'broadcasts:read',
  params: ID,
  query: listQuery({
    sorts: ['id'],
    defaultSort: { field: 'id', order: 'asc' },
    filters: { status: { type: 'enum', values: [...RECIPIENT_STATUSES], ops: ['eq'] } },
    maxPage: 100,
    extra: { channel: zChannel },
  }),
  success: { status: 200, schema: zRecipient },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        id: 52,
        channel: 'email',
        recipientType: 'client',
        recipientId: 1,
        recipient: 'o***@zainmobilehub.example',
        status: 'sent',
        error: null,
        attempts: 1,
        sentAt: '2026-11-10T09:06:02.000Z',
        readAt: null,
        createdAt: '2026-11-10T09:05:30.000Z',
      },
    ],
  },
});
