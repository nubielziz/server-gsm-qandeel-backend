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
import { clients } from '../../identity/db/schema';

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
 * Why: Message templates per event, channel, audience and language (routes /admin/notification-templates).
 */
export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: pk(),
    /** the event key the template answers, for example `order.completed` */
    event: text().notNull(),
    channel: text().$type<NotificationChannel>().notNull(),
    audience: text().$type<NotificationAudience>().notNull(),
    locale: text().notNull().default('en'),
    subject: text().notNull().default(''),
    body: text().notNull(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('notification_templates_event_uq').on(t.event, t.channel, t.audience, t.locale),
    check('notification_templates_channel_check', inList(t.channel, NOTIFICATION_CHANNELS)),
    check('notification_templates_audience_check', inList(t.audience, NOTIFICATION_AUDIENCES)),
  ],
);

/** A row read from `notification_templates`. */
export type NotificationTemplate = typeof notificationTemplates.$inferSelect;

/** A row to insert into `notification_templates`. */
export type NewNotificationTemplate = typeof notificationTemplates.$inferInsert;

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
