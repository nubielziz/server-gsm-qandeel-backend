// Platform tables (map domain G): settings, notifications, merchant webhooks, the outbox, audit log, files.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  bigId,
  createdAt,
  fk,
  inList,
  jsonObject,
  pk,
  textList,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { clients, staffUsers } from '../../identity/db/schema';

/**
 * Channels a notification can be sent through.
 *
 * Why: the console's notification wire enum (GET /admin/notifications).
 */
export const NOTIFICATION_CHANNELS = ['email', 'telegram'] as const;

/** One value of {@link NOTIFICATION_CHANNELS}. */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Who a notification template is written for.
 *
 * Why: the console's template wire enum (GET /admin/notification-templates).
 */
export const NOTIFICATION_AUDIENCES = ['staff', 'customer', 'merchant'] as const;

/** One value of {@link NOTIFICATION_AUDIENCES}. */
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

/**
 * Delivery state of one notification.
 *
 * Why: the console's notification log wire enum.
 */
export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed'] as const;

/** One value of {@link NOTIFICATION_STATUSES}. */
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * Who a logged notification was sent to: staff, a merchant (`client`) or a storefront customer.
 *
 * Why: RESOLUTIONS identity-platform-11: the log says `client` where the template audience says `merchant`; the
 * notification worker maps one to the other.
 */
export const NOTIFICATION_RECIPIENT_TYPES = ['staff', 'client', 'customer'] as const;

/** One value of {@link NOTIFICATION_RECIPIENT_TYPES}. */
export type NotificationRecipientType = (typeof NOTIFICATION_RECIPIENT_TYPES)[number];

/**
 * Delivery state of one webhook attempt chain.
 *
 * Why: the console's webhook log wire enum (GET /admin/webhook-deliveries).
 */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;

/** One value of {@link WEBHOOK_DELIVERY_STATUSES}. */
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Who acted in an audit log row: a staff member, a merchant, a storefront customer or the system.
 *
 * Why: RESOLUTIONS identity-platform-7: the only values `AuditService` writes (the request actor, or `system` for jobs).
 */
export const AUDIT_ACTOR_TYPES = ['staff', 'client', 'customer', 'system'] as const;

/** One value of {@link AUDIT_ACTOR_TYPES}. */
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * System settings as key and value pairs.
 *
 * Why: Flat key/value system settings: storefront policies, the admin allowlist switch, maintenance (MISMATCHES B66,
 * B67).
 */
export const settings = pgTable(
  'settings',
  {
    id: pk(),
    /** unique; camelCase as the console sends it, for example `adminAllowlistOnly` */
    key: text().notNull(),
    /** any JSON value (boolean, number, string, object); no default on purpose */
    value: jsonb().$type<unknown>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('settings_key_uq').on(t.key)],
);

/** A row read from `settings`. */
export type Setting = typeof settings.$inferSelect;

/** A row to insert into `settings`. */
export type NewSetting = typeof settings.$inferInsert;

/**
 * Email and Telegram templates for staff, merchants and customers.
 *
 * Why: Message templates per event, channel and audience (routes /admin/notification-templates). The map's `locale` column is dropped:
 * English is the only language (decision 039, B226), so one template answers an event, channel and audience.
 */
export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: pk(),
    /** the event key the template answers, for example `order.completed` */
    event: text().notNull(),
    channel: text().$type<NotificationChannel>().notNull(),
    audience: text().$type<NotificationAudience>().notNull(),
    subject: text().notNull().default(''),
    body: text().notNull(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('notification_templates_event_uq').on(t.event, t.channel, t.audience),
    check('notification_templates_channel_check', inList(t.channel, NOTIFICATION_CHANNELS)),
    check('notification_templates_audience_check', inList(t.audience, NOTIFICATION_AUDIENCES)),
  ],
);

/** A row read from `notification_templates`. */
export type NotificationTemplate = typeof notificationTemplates.$inferSelect;

/** A row to insert into `notification_templates`. */
export type NewNotificationTemplate = typeof notificationTemplates.$inferInsert;

/**
 * Lifecycle of a notification campaign (feature 23).
 *
 * Why: the campaign state machine: a draft is edited, scheduled or sent; the minute sweep queues a scheduled one; the fan-out
 * moves it to `sending` and `sent`; staff cancel a scheduled or running one; a fan-out that cannot finish ends `failed`.
 */
export const NOTIFICATION_CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'queued',
  'sending',
  'sent',
  'cancelled',
  'failed',
] as const;

/** One value of {@link NOTIFICATION_CAMPAIGN_STATUSES}. */
export type NotificationCampaignStatus = (typeof NOTIFICATION_CAMPAIGN_STATUSES)[number];

/**
 * Why a campaign is sent: a service announcement, or marketing (which needs a customer's consent).
 *
 * Why: L5 (feature 23): marketing reaches only customers who agreed, checked at fan-out and at send.
 */
export const NOTIFICATION_CAMPAIGN_PURPOSES = ['service', 'marketing'] as const;

/** One value of {@link NOTIFICATION_CAMPAIGN_PURPOSES}. */
export type NotificationCampaignPurpose = (typeof NOTIFICATION_CAMPAIGN_PURPOSES)[number];

/**
 * What an in-app notification is about; the list and the clients pick an icon by it.
 *
 * Why: feature 23: campaign items are `announcement` or `marketing`; event items name their area. `billing`, `support`, `account`
 * and `alert` exist for later events, so adding them needs no CHECK migration.
 */
export const NOTIFICATION_INBOX_CATEGORIES = [
  'announcement',
  'marketing',
  'order',
  'payment',
  'wallet',
  'billing',
  'support',
  'account',
  'alert',
] as const;

/** One value of {@link NOTIFICATION_INBOX_CATEGORIES}. */
export type NotificationInboxCategory = (typeof NOTIFICATION_INBOX_CATEGORIES)[number];

/**
 * Messages staff write once and send to an audience (feature 23, notification center).
 *
 * Why: a broadcast is one row plus a chunked fan-out, never one outbox event per recipient (L5); the row keeps the audience,
 * the content (one title and one body, decision 039), the state machine, the fan-out cursor and the planned counters.
 */
export const notificationCampaigns = pgTable(
  'notification_campaigns',
  {
    id: pk(),
    /** the staff-facing label, 1-120 characters */
    name: text().notNull(),
    purpose: text().$type<NotificationCampaignPurpose>().notNull(),
    /** `in_app`, `email`, `telegram`; at least one (CHECK) */
    channels: textList(),
    /** the validated audience spec (`campaigns/audience-spec.ts`) */
    audience: jsonb().$type<Record<string, unknown>>().notNull(),
    /** `{ title, body }` (migration 0035 turned the old `{ en, ar? }` into this) */
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    /** `{ staff?, merchant?, customer? }` site-relative paths, or null */
    link: jsonb().$type<Record<string, unknown>>(),
    status: text().$type<NotificationCampaignStatus>().notNull().default('draft'),
    scheduledAt: timestampTz(),
    queuedAt: timestampTz(),
    startedAt: timestampTz(),
    finishedAt: timestampTz(),
    cancelledAt: timestampTz(),
    /** the reachable count when staff sent or scheduled it */
    expectedRecipients: integer(),
    /** people the fan-out made at least one row for */
    recipients: integer().notNull().default(0),
    /** `{ planned: { inApp, email, telegram }, skipped: { optedOut, noTelegram, noAccount } }`, written by the fan-out only */
    stats: jsonObject(),
    /** `{ type, afterId }` of the next fan-out chunk; null before the start and after the end */
    fanoutCursor: jsonb().$type<Record<string, unknown>>(),
    /** how many chunks the fan-out committed; part of continuation job ids */
    chunksDone: integer().notNull().default(0),
    /** why it is `failed` */
    error: text(),
    createdBy: fk((): AnyPgColumn => staffUsers.id).notNull(),
    updatedBy: fk((): AnyPgColumn => staffUsers.id),
    cancelledBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    /** also the fan-out's heartbeat: the sweep re-kicks a running campaign whose row has not moved for 5 minutes */
    updatedAt: updatedAt(),
  },
  (t) => [
    check('notification_campaigns_status_check', inList(t.status, NOTIFICATION_CAMPAIGN_STATUSES)),
    check('notification_campaigns_purpose_check', inList(t.purpose, NOTIFICATION_CAMPAIGN_PURPOSES)),
    check(
      'notification_campaigns_channels_check',
      sql`${t.channels} <@ array['in_app','email','telegram']::text[] and cardinality(${t.channels}) > 0`,
    ),
    index('notification_campaigns_due_idx')
      .on(t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
    index('notification_campaigns_status_idx').on(t.status, t.updatedAt),
    index('notification_campaigns_created_idx').on(t.createdAt.desc()),
    index('notification_campaigns_created_by_idx').on(t.createdBy),
    index('notification_campaigns_updated_by_idx').on(t.updatedBy),
    index('notification_campaigns_cancelled_by_idx').on(t.cancelledBy),
  ],
);

/** A row read from `notification_campaigns`. */
export type NotificationCampaign = typeof notificationCampaigns.$inferSelect;

/** A row to insert into `notification_campaigns`. */
export type NewNotificationCampaign = typeof notificationCampaigns.$inferInsert;

/**
 * The in-app notifications of staff, merchants and customers (feature 23).
 *
 * Why: the in-app channel is its own table (not a value of the log's channel enum): read state, an unread count and paging per
 * person. An item comes from a campaign (rendered from the campaign's content at read time) or from an event (rendered from the
 * in-app text registry with `variables`).
 */
export const notificationInbox = pgTable(
  'notification_inbox',
  {
    id: pk(),
    recipientType: text().$type<NotificationRecipientType>().notNull(),
    /** polymorphic: staff_users, clients or customers by recipient_type */
    recipientId: bigId().notNull(),
    campaignId: fk((): AnyPgColumn => notificationCampaigns.id),
    /** the registry key of an event item */
    event: text(),
    category: text().$type<NotificationInboxCategory>().notNull(),
    /** placeholder values of an event item; never a secret, a token or a link with a token */
    variables: jsonObject(),
    readAt: timestampTz(),
    /** the occurrence key of an event item (`inapp:<audience>:<event>:<occurrence>`) */
    dedupeKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('notification_inbox_recipient_type_check', inList(t.recipientType, NOTIFICATION_RECIPIENT_TYPES)),
    check('notification_inbox_category_check', inList(t.category, NOTIFICATION_INBOX_CATEGORIES)),
    check('notification_inbox_source_check', sql`(${t.campaignId} is not null) <> (${t.event} is not null)`),
    uniqueIndex('notification_inbox_campaign_recipient_uq')
      .on(t.campaignId, t.recipientType, t.recipientId)
      .where(sql`${t.campaignId} is not null`),
    uniqueIndex('notification_inbox_dedupe_key_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index('notification_inbox_recipient_idx').on(t.recipientType, t.recipientId, t.createdAt.desc(), t.id.desc()),
    index('notification_inbox_unread_idx')
      .on(t.recipientType, t.recipientId)
      .where(sql`${t.readAt} is null`),
    index('notification_inbox_campaign_id_idx').on(t.campaignId, t.readAt),
    index('notification_inbox_created_idx').on(t.createdAt),
    index('notification_inbox_read_idx')
      .on(t.readAt)
      .where(sql`${t.readAt} is not null`),
  ],
);

/** A row read from `notification_inbox`. */
export type NotificationInboxItem = typeof notificationInbox.$inferSelect;

/** A row to insert into `notification_inbox`. */
export type NewNotificationInboxItem = typeof notificationInbox.$inferInsert;

/**
 * A log of the notifications that were sent.
 *
 * Why: Log of the notifications sent to staff, merchants and customers (route /admin/notifications, B72).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    recipientType: text().$type<NotificationRecipientType>().notNull(),
    /** polymorphic: staff_users, clients or customers by recipient_type */
    recipientId: bigId().notNull(),
    channel: text().$type<NotificationChannel>().notNull(),
    /** the template event key (not a foreign key, B72) */
    event: text().notNull(),
    /** ids and display values only, never secrets */
    payload: jsonObject(),
    status: text().$type<NotificationStatus>().notNull().default('queued'),
    sentAt: timestampTz(),
    /** schema addition B116 */
    error: text(),
    /** how many sends were tried (feature 12a: the attempt is on the row, decision 020) */
    attempts: integer().notNull().default(0),
    /**
     * names the occurrence a row is for (`outbox-<event id>:<channel>`, `telegram-update-<id>`, `digest:...`), so a job that runs
     * twice, or an update Telegram repeats, never makes a second row; null for a row nothing repeats (feature 12a)
     */
    dedupeKey: text(),
    /** the campaign a broadcast row belongs to (feature 23); null for an event's message */
    campaignId: fk((): AnyPgColumn => notificationCampaigns.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('notifications_channel_check', inList(t.channel, NOTIFICATION_CHANNELS)),
    check('notifications_status_check', inList(t.status, NOTIFICATION_STATUSES)),
    check('notifications_recipient_type_check', inList(t.recipientType, NOTIFICATION_RECIPIENT_TYPES)),
    index('notifications_recipient_idx').on(t.recipientType, t.recipientId),
    index('notifications_status_created_idx').on(t.status, t.createdAt.desc()),
    index('notifications_created_idx').on(t.createdAt.desc()),
    uniqueIndex('notifications_dedupe_key_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    // The count of "sent in the last 30 days" per template (identity-platform-11) reads only sent rows.
    // Feature 23: the per-campaign stats (index-only) and the per-campaign recipient list.
    index('notifications_campaign_idx').on(t.campaignId, t.channel, t.status),
    index('notifications_campaign_list_idx')
      .on(t.campaignId, t.channel, t.id)
      .where(sql`${t.campaignId} is not null`),
    index('notifications_sent_idx')
      .on(t.event, t.channel, t.recipientType, t.sentAt)
      .where(sql`${t.status} = 'sent'`),
  ],
);

/** A row read from `notifications`. */
export type Notification = typeof notifications.$inferSelect;

/** A row to insert into `notifications`. */
export type NewNotification = typeof notifications.$inferInsert;

/**
 * Webhook URLs registered by merchants.
 *
 * Why: Webhook URLs merchants register to receive order and wallet events (routes /client/webhooks).
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: pk(),
    clientId: fk((): AnyPgColumn => clients.id).notNull(),
    url: text().notNull(),
    /** HMAC signing secret, AES-GCM text of decision 019 */
    secretEnc: text().notNull(),
    events: textList(),
    isActive: boolean().notNull().default(true),
    failureCount: integer().notNull().default(0),
    /** deliveries in a row that ended failed while the endpoint was on; 20 switch it off (decision 053); a delivered one or turning the endpoint on sets it to 0 */
    consecutiveFailedDeliveries: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('webhook_endpoints_client_id_idx').on(t.clientId)],
);

/** A row read from `webhook_endpoints`. */
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;

/** A row to insert into `webhook_endpoints`. */
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;

/**
 * Attempts to deliver webhooks.
 *
 * Why: Attempts to deliver outgoing events, retried with backoff by the worker (routes /admin/webhook-deliveries).
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: pk(),
    /** deleting an endpoint deletes its delivery log (route lists only webhook_endpoints) */
    endpointId: fk((): AnyPgColumn => webhookEndpoints.id, 'cascade').notNull(),
    event: text().notNull(),
    /**
     * the id of the event in the delivery envelope and in `X-GSM-Event-Id` (`evt_...`); one event reaches an endpoint once, so
     * (endpoint_id, event_id) is unique and a repeated fan-out cannot double a delivery; schema addition (feature 7b)
     */
    eventId: text().notNull(),
    /** the whole envelope `{ id, type, createdAt, data }` that is sent (public fields only, never a secret) */
    payload: jsonObject(),
    attempt: integer().notNull().default(1),
    status: text().$type<WebhookDeliveryStatus>().notNull().default('pending'),
    responseCode: integer(),
    nextRetryAt: timestampTz(),
    /** truncated to a few KB by the writer (B75); schema addition B116 */
    responseBody: text(),
    /** schema addition B116 */
    error: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('webhook_deliveries_status_check', inList(t.status, WEBHOOK_DELIVERY_STATUSES)),
    unique('webhook_deliveries_endpoint_event_uq').on(t.endpointId, t.eventId),
    index('webhook_deliveries_endpoint_id_idx').on(t.endpointId),
    index('webhook_deliveries_retry_idx')
      .on(t.nextRetryAt)
      .where(sql`${t.status} = 'pending'`),
    index('webhook_deliveries_status_created_idx').on(t.status, t.createdAt.desc()),
    index('webhook_deliveries_created_idx').on(t.createdAt.desc()),
  ],
);

/** A row read from `webhook_deliveries`. */
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/** A row to insert into `webhook_deliveries`. */
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;

/**
 * Events waiting to be processed by the worker.
 *
 * Why: Transactional outbox: state changes write a row, the worker relay moves it to BullMQ (decision 020).
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: pk(),
    /** event type, for example `order.status_changed` */
    type: text().notNull(),
    aggregateType: text().notNull(),
    /** polymorphic: orders, invoices or checkout_sessions by aggregate_type */
    aggregateId: bigId().notNull(),
    /** ids only (decision 020) */
    payload: jsonObject(),
    processedAt: timestampTz(),
    attempts: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.id)
      .where(sql`${t.processedAt} is null`),
    index('outbox_events_processed_idx')
      .on(t.processedAt)
      .where(sql`${t.processedAt} is not null`),
    index('outbox_events_aggregate_idx').on(t.aggregateType, t.aggregateId),
  ],
);

/** A row read from `outbox_events`. */
export type OutboxEvent = typeof outboxEvents.$inferSelect;

/** A row to insert into `outbox_events`. */
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;

/**
 * The audit log of admin actions.
 *
 * Why: Who changed what: every admin write is logged (architecture § 3, route /admin/audit-logs, B10).
 *
 * Append-only: a trigger rejects UPDATE and DELETE (custom migration), so the table has no `updated_at`.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    actorType: text().$type<AuditActorType>().notNull(),
    /** polymorphic: staff_users or clients by actor_type; null for system actions */
    actorId: bigId(),
    /**
     * name of the actor when the row was written, so a rename or delete does not change history; empty for the
     * system (RESOLUTIONS identity-platform-7)
     */
    actorName: text().notNull().default(''),
    /** a readable English verb phrase, as the demo writes it (ANSWERS) */
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: bigId().notNull(),
    /**
     * name snapshot shown by the console, so a later rename or delete does not change history; schema addition B116
     */
    entityLabel: text().notNull().default(''),
    /** state before the change; null for a create */
    before: jsonb().$type<Record<string, unknown>>(),
    /** state after the change; null for a delete */
    after: jsonb().$type<Record<string, unknown>>(),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check('audit_logs_actor_type_check', inList(t.actorType, AUDIT_ACTOR_TYPES)),
    index('audit_logs_created_idx').on(t.createdAt.desc()),
    index('audit_logs_actor_idx').on(t.actorType, t.actorId, t.createdAt.desc()),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
  ],
);

/** A row read from `audit_logs`. */
export type AuditLog = typeof auditLogs.$inferSelect;

/** A row to insert into `audit_logs`. */
export type NewAuditLog = typeof auditLogs.$inferInsert;

/**
 * S3 files and their metadata.
 *
 * Why: Metadata of S3 objects: KYC documents, receipts, invoices PDFs, dispute evidence (decision 004).
 */
export const files = pgTable(
  'files',
  {
    id: pk(),
    bucket: text().notNull(),
    key: text().notNull(),
    filename: text().notNull(),
    mime: text().notNull(),
    /** bytes */
    size: bigint({ mode: 'number' }).notNull(),
    /** hex digest, to detect duplicate uploads */
    sha256: text().notNull(),
    /** client, staff or customer; no source fixes the strings */
    ownerType: text().notNull(),
    /** polymorphic: clients, staff_users or customers by owner_type */
    ownerId: bigId().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('files_object_uq').on(t.bucket, t.key),
    index('files_owner_idx').on(t.ownerType, t.ownerId),
    index('files_sha256_idx').on(t.sha256),
  ],
);

/** A row read from `files`. */
export type StoredFile = typeof files.$inferSelect;

/** A row to insert into `files`. */
export type NewStoredFile = typeof files.$inferInsert;
