// Public API of the platform module: the module itself, what the bootstrap, the generator script and the contract tests
// need from its documentation routes, the audit log, the transactional outbox (write events, register their queues, relay
// them), the settings readers and maintenance mode.
export { PlatformModule } from './platform.module';
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
