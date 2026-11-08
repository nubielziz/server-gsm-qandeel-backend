// Public API of the platform module: the module itself, what the bootstrap, the generator script and the contract tests
// need from its documentation routes, the audit log, the transactional outbox (write events, register their queues, relay
// them), the settings readers, maintenance mode and the merchant webhooks (the event contracts and outbox routes of 7b, the
// delivery engine, the processor of the `merchant-webhooks` queue) and the notifications (event registry, templates, delivery, the
// mail and Telegram channels, a merchant's preference rules).
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
export { IMEI_RETENTION_MAX_DAYS, imeiRetentionDaysProblem } from './settings/settings-registry';
export { OutboxModule } from './outbox/outbox.module';
export { OutboxRelayModule, OUTBOX_TICK_SCHEDULER } from './outbox/outbox-relay.module';
export { OutboxRelay, RELAY_BATCH_SIZE } from './outbox/outbox-relay';
export type { RelayResult } from './outbox/outbox-relay';
export { OutboxRouteRegistry } from './outbox/outbox-routes';
export { OutboxService } from './outbox/outbox.service';
export type {
  OutboxBacklog,
  OutboxEventInput,
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
export type { FileMeta, StoreFileInput } from './files/stored-files';
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
export { DEFAULT_TEMPLATES, defaultTemplatesSql } from './notifications/default-templates';
export type { DefaultTemplate } from './notifications/default-templates';
export { redactAddresses } from './notifications/masking';
