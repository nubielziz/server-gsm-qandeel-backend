// Public API of the platform module: the module itself, what the bootstrap, the generator script and the contract tests
// need from its documentation routes, the audit log, the transactional outbox (write events, register their queues, relay
// them), the settings readers, maintenance mode and the merchant webhooks (the event contracts and outbox routes of 7b, the
// delivery engine, the processor of the `merchant-webhooks` queue) and the notifications (event registry, templates, delivery, the
// mail and Telegram channels, a merchant's preference rules), the inbox doorbell and live-stream source (feature 27) and the public service
// pictures of the storefront.
export { PlatformModule } from './platform.module';
export { FilesModule } from './files.module';
export {
  FileUploadService,
  MAX_UPLOAD_BYTES,
  cleanMediaType,
  cleanUploadName,
} from './application/file-upload.service';
export type { StoredFileView, UploadInput } from './application/file-upload.service';
export { AuditModule } from './audit/audit.module';
export { AuditService } from './audit/audit.service';
export { AUDIT_ENTITY_TYPES, CONSOLE_AUDIT_ENTITY_TYPES, isAuditEntityType } from './audit/audit-entity-types';
export type { AuditEntityType } from './audit/audit-entity-types';
export type { AuditEntry } from './audit/audit.service';
export { REDACTED, isSecretKey, redactForAudit } from './audit/audit-redaction';
export { SettingsModule } from './settings/settings.module';
// The boot check of LOOKUP_HASH_KEY (decision 054): imported by the API's and the worker's root modules.
export { LookupKeyCheckModule } from './settings/lookup-key-check.module';
export {
  LOOKUP_KEY_CHANGED,
  LOOKUP_KEY_CHECK_LABEL,
  LOOKUP_KEY_CHECK_SETTING,
  LookupKeyCheck,
} from './settings/lookup-key-check';
export type { LookupKeyVerdict } from './settings/lookup-key-check';
export { SETTINGS_TTL_SECONDS, SettingsReader } from './settings/settings-reader';
export type { IntegerBounds, IntegerSetting } from './settings/settings-reader';
export { DOCUMENTATION_ROUTES } from './docs/docs.controller';
export {
  API_VERSION,
  buildInternalDocument,
  buildOpenApiDocuments,
  buildPublicDocument,
  buildWebhooks,
  serializeOpenApiDocument,
  stripSchemaKeyword,
} from './docs/openapi-documents';
export type { BuildOptions, OpenApiDocuments } from './docs/openapi-documents';
export type { OpenApiDocument } from './docs/openapi-types';
export { OpenApiService } from './docs/openapi.service';
export type { PublishedDocs } from './docs/openapi.service';
export { REFERENCE_DOCS_GUARD } from './docs/reference-access.guard';
export { SCALAR_BUNDLE_URL, SCALAR_VERSION } from './docs/scalar-page';
export { MaintenanceModule } from './maintenance/maintenance.module';
export { MaintenanceService } from './maintenance/maintenance.service';
export {
  DEFAULT_MAINTENANCE_MESSAGE,
  MAINTENANCE_KEY,
  MAINTENANCE_OFF,
  MAINTENANCE_SCOPES,
  maintenanceRefusal,
  parseMaintenanceState,
  scopesCovering,
} from './maintenance/maintenance-state';
export type { MaintenanceRequest, MaintenanceScope, MaintenanceState } from './maintenance/maintenance-state';
export { SettingsService } from './settings/settings.service';
export {
  CUSTOMER_WALLET_SETTINGS,
  CUSTOMER_WALLET_SETTING_RANGES,
  FX_GUARD_SETTINGS,
  IMEI_RETENTION_MAX_DAYS,
  imeiRetentionDaysProblem,
  INBOX_READ_RETENTION_DAYS_KEY,
  INBOX_RETENTION_DAYS_KEY,
  LOG_RETENTION_DAYS_KEY,
  NOTIFICATION_RETENTION,
  SUPPORT_SETTINGS,
} from './settings/settings-registry';
export { OutboxModule } from './outbox/outbox.module';
export { OutboxRelayModule, OUTBOX_TICK_SCHEDULER } from './outbox/outbox-relay.module';
export { OutboxRelay, RELAY_BATCH_SIZE } from './outbox/outbox-relay';
export type { RelayResult } from './outbox/outbox-relay';
export { OutboxRouteRegistry } from './outbox/outbox-routes';
export { OutboxService } from './outbox/outbox.service';
// Decision 055: the outbox purge, and the lost-work reconcile with the registry its passes use.
export {
  OUTBOX_PURGE_BATCH,
  OUTBOX_PURGE_MAX_BATCHES,
  OUTBOX_RETENTION_DAYS,
  OutboxPurge,
} from './outbox/outbox-purge';
export { OUTBOX_PURGE_JOB, OutboxPurgeProcessor } from './outbox/outbox-purge.processor';
export { OUTBOX_PURGE_SCHEDULER } from './outbox/outbox-relay.module';
export { LostWorkRegistry } from './lost-work/lost-work.registry';
export { LOST_WORK_RECONCILE_SCHEDULER, LostWorkModule } from './lost-work/lost-work.module';
export { LOST_WORK_RECONCILE_JOB, LostWorkReconcileProcessor } from './lost-work/lost-work-reconcile.processor';
export { LostWorkReconcile, applyLostWorkItems, hasWork } from './lost-work/lost-work-reconcile';
export type { LostWorkPlans, LostWorkResult } from './lost-work/lost-work-reconcile';
export { LIVE_JOB_STATES, OutboxRequests } from './lost-work/outbox-requests';
export type { OutboxRequestInfo } from './lost-work/outbox-requests';
export { LOST_AFTER_MS, MAX_RECONCILE_REQUESTS, lostWorkAction } from './lost-work/lost-work-rules';
export type { LostWorkAction, OutboxRequestState } from './lost-work/lost-work-rules';
export type {
  LostWorkApplied,
  LostWorkContext,
  LostWorkCounts,
  LostWorkItem,
  LostWorkPass,
  LostWorkPlan,
} from './lost-work/lost-work.types';
export type {
  OutboxBacklog,
  OutboxEventInput,
  OutboxEventTrace,
  OutboxJobData,
  OutboxPayload,
  OutboxPayloadValue,
  OutboxRoute,
} from './outbox/outbox.types';
export { WebhookEventsModule } from './webhooks/webhook-events.module';
export { WebhookDeliveryModule } from './webhooks/webhook-delivery.module';
export { MerchantWebhooksModule } from './webhooks/merchant-webhooks.module';
export { MerchantWebhookService } from './webhooks/merchant-webhook.service';
export {
  portalCreateWebhook,
  portalDeleteWebhook,
  portalListWebhookDeliveries,
  portalListWebhooks,
  portalTestWebhook,
  portalUpdateWebhook,
} from './webhooks/webhooks.contracts';
export {
  SERVICE_PRICE_CHANGED_EVENT,
  WALLET_LOW_BALANCE_EVENT,
  MerchantEventRoutes,
} from './webhooks/merchant-event-routes';
export { invoicePaid, orderStatusChanged, servicePriceChanged, walletLowBalance } from './webhooks/webhook-events';
export {
  MAX_ENDPOINTS_PER_MERCHANT,
  PING_EVENT,
  WEBHOOK_EVENT_NAMES,
  WEBHOOK_MAX_ATTEMPTS,
  isWebhookEvent,
} from './webhooks/webhook-delivery.rules';
export type { WebhookEventName } from './webhooks/webhook-delivery.rules';
export { WEBHOOK_DELIVER_JOB, WEBHOOK_QUEUE, WebhookDeliveries } from './webhooks/webhook-deliveries';
export type { DeliverResult, WebhookJobData } from './webhooks/webhook-deliveries';
export { WebhookFanOut } from './webhooks/webhook-fan-out';
export type { FanOutResult } from './webhooks/webhook-fan-out';
export { MerchantWebhooksProcessor } from './webhooks/merchant-webhooks.processor';
export { WEBHOOK_TARGET_POLICY } from './webhooks/webhook-target-policy';
export type { WebhookTargetPolicy } from './webhooks/webhook-target-policy';
export { PdfModule } from './pdf/pdf.module';
export { PdfRenderer } from './pdf/pdf-renderer';
export type { PdfBlock, PdfColumn, PdfDocument } from './pdf/pdf-renderer';
export { PROOF_MIME_TYPES, StoredFiles } from './files/stored-files';
export type { FileMeta, StoreFileInput, StoredFileRecord } from './files/stored-files';
export { PUBLIC_IMAGE_NAME, PUBLIC_IMAGE_PREFIX, PUBLIC_MEDIA_PATH, PublicImages } from './files/public-images';
export type { PublicImageBytes, StorePublicImageInput, StoredPublicImage } from './files/public-images';
export {
  PUBLIC_IMAGE_MAX_BYTES,
  PUBLIC_IMAGE_MAX_SIDE,
  PUBLIC_IMAGE_MIN_SIDE,
  PUBLIC_LOGO_MIN_SIDE,
  inspectImage,
} from './files/image-inspect';
export type { ImageRefusalCode, InspectImageOptions, InspectedImage, RefusedImage } from './files/image-inspect';
export { NotificationEventsModule } from './notifications/notification-events.module';
export { NotificationTransportModule } from './notifications/notification-transport.module';
export { MAIL_PROBE_TOKEN, MailHealthProbe, MailHealthProbeModule } from './notifications/mail-health-probe';
export { NotificationDeliveryModule } from './notifications/notification-delivery.module';
export { NotificationAdminModule } from './notifications/notification-admin.module';
export {
  BUILT_IN_EVENTS,
  CUSTOMER_MAIL_EVENT_KEYS,
  MERCHANT_MAIL_EVENT_KEYS,
  NotificationEventRegistry,
  RETAIL_PRICES_FOLLOWED_EVENT,
  TELEGRAM_LINKED_EVENT,
  TELEGRAM_UNLINKED_EVENT,
} from './notifications/notification-events';
export type { NotificationEventDefinition } from './notifications/notification-events';
export { NOTIFICATION_SEND_EVENT, NotificationService } from './notifications/notification.service';
export type {
  AddressedNotificationInput,
  AddressedResult,
  EnqueueResult,
  NotificationInput,
  SendNowResult,
  SkipReason,
} from './notifications/notification.service';
export type { AttemptContext, DeliveryOutcome } from './notifications/notification-delivery';
export { DeliveryError } from './notifications/delivery-error';
export { InMemoryMailDriver } from './notifications/mail-driver';
export { MAIL_DRIVER, MailTransport } from './notifications/mail-transport';
export { InMemoryTelegramDriver } from './notifications/telegram-driver';
export { TELEGRAM_DRIVER, TELEGRAM_NOT_CONFIGURED, TelegramClient } from './notifications/telegram-client';
export { maskEmail, maskTelegram } from './notifications/masking';
export {
  EVENTS_KEY,
  LOW_BALANCE_THRESHOLD_KEY as PREFS_LOW_BALANCE_THRESHOLD_KEY,
  applyPreferences,
  channelsFor,
  choiceFor,
  parseThreshold,
  thresholdOf,
  withoutTelegram,
} from './notifications/merchant-preferences';
export type { EventChoice } from './notifications/merchant-preferences';
export { DEFAULT_TEMPLATES, defaultTemplatesSql, templatesInsertSql } from './notifications/default-templates';
export type { DefaultTemplate } from './notifications/default-templates';
export { redactAddresses } from './notifications/masking';
// Feature 23 (notification center): the registries other modules use (audience providers, in-app texts), the in-app writer, the
// campaign engine (fan-out, sweep, bulk sender) and the job-run port that health provides.
export { NOTIFICATION_CENTER_MIGRATION } from './notifications/campaigns/migration-names';
export {
  NO_COUNTS,
  NotificationAudiences,
  audienceCountFields,
  memberQuery,
  reachableSql,
} from './notifications/campaigns/notification-audiences';
export type {
  AudienceCounts,
  AudienceFlagsSql,
  AudienceMember,
  AudienceProvider,
  AudienceQuery,
  CampaignChannel,
} from './notifications/campaigns/notification-audiences';
export { AUDIENCE_TYPE_ORDER, selectionsOf, zAudienceSpec } from './notifications/campaigns/audience-spec';
export type {
  AudienceSpec,
  CustomerSegment,
  MerchantSegment,
  StaffSegment,
  TypeSelection,
} from './notifications/campaigns/audience-spec';
export type {
  NotificationCampaign,
  NotificationCampaignPurpose,
  NotificationCampaignStatus,
  NotificationInboxCategory,
  NotificationInboxItem,
} from './db/schema';
export {
  BROADCAST_ANNOUNCEMENT_EVENT,
  BROADCAST_EVENTS,
  BROADCAST_TEST_EVENT,
  BroadcastEvents,
} from './notifications/campaigns/broadcast-events';
export { CAMPAIGN_CHANNELS, CAMPAIGN_FANOUT_EVENT } from './notifications/campaigns/campaign-rules';
export { NotificationPrivacy } from './notifications/campaigns/notification-privacy';
export { marketingUnsubscribeToken, parseMarketingUnsubscribeToken } from './notifications/campaigns/unsubscribe-token';
export { InboxTextRegistry, renderInboxText } from './notifications/inbox/inbox-texts';
export type { InboxText, InboxTextDefinition } from './notifications/inbox/inbox-texts';
export { NotificationInbox } from './notifications/inbox/notification-inbox';
export { CHUNK_IDS_PER_DOORBELL, INBOX_TOPIC, InboxDoorbell } from './notifications/inbox/inbox-doorbell';
export { INBOX_REPLAY_LIMIT, InboxRealtimeSource } from './notifications/inbox/inbox-realtime.source';
export {
  NOTIFICATION_CREATED_EVENT,
  NOTIFICATION_READ_EVENT,
  UNREAD_CHANGED_EVENT,
  zNotificationCreatedEvent,
  zNotificationReadEvent,
  zUnreadChangedEvent,
} from './notifications/inbox/inbox-realtime.events';
export type { EventItemInput } from './notifications/inbox/notification-inbox';
export {
  NotificationCampaignEngineModule,
  CAMPAIGN_SWEEP_SCHEDULER,
} from './notifications/campaigns/campaign-engine.module';
export {
  CAMPAIGN_FANOUT_OPTIONS,
  CampaignFanOut,
  DEFAULT_FANOUT_OPTIONS,
} from './notifications/campaigns/campaign-fan-out';
export type {
  CampaignFanOutOptions,
  FanOutResult as CampaignFanOutResult,
} from './notifications/campaigns/campaign-fan-out';
export { CampaignFanOutProcessor } from './notifications/campaigns/campaign-fan-out.processor';
export { CampaignSweep } from './notifications/campaigns/campaign-sweep';
export type { SweepResult } from './notifications/campaigns/campaign-sweep';
export { NotificationReconcile } from './notifications/notification-reconcile';
export type { ReconcileResult } from './notifications/notification-reconcile';
export {
  NOTIFICATION_RECONCILE_JOB,
  NotificationReconcileProcessor,
} from './notifications/notification-reconcile.processor';
export { NotificationRetention } from './notifications/notification-retention';
export type { RetentionResult } from './notifications/notification-retention';
export {
  NOTIFICATION_RETENTION_JOB,
  NotificationRetentionProcessor,
} from './notifications/notification-retention.processor';
export { CAMPAIGN_SWEEP_JOB, CampaignSweepProcessor } from './notifications/campaigns/campaign-sweep.processor';
export {
  BROADCAST_QUEUE,
  BROADCAST_SEND_JOB,
  BroadcastSendProcessor,
} from './notifications/campaigns/broadcast-send.processor';
export { BroadcastBudget, MAX_BUDGET_WAITS } from './notifications/campaigns/broadcast-budget';
export { JOB_RUN_RECORDER } from './jobs/job-run-recorder';
export type { JobRunRecorder } from './jobs/job-run-recorder';
