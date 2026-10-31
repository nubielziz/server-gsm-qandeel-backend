// Platform module (map domain G): settings, audit logs, files, notifications, webhooks and the outbox.
// Today it serves the API documentation (src/modules/platform/docs), writes the outbox (src/modules/platform/outbox) and
// the audit log (src/modules/platform/audit), and reads settings for other modules (src/modules/platform/settings);
// the other parts arrive with their features (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';
import { DocsController, ReferenceController } from './docs/docs.controller';
import { OpenApiService } from './docs/openapi.service';
import { ReferenceAccessGuard } from './docs/reference-access.guard';
import { AuditModule } from './audit/audit.module';
import { OutboxModule } from './outbox/outbox.module';
import { SettingsModule } from './settings/settings.module';

/**
 * Nest module for Platform (map domain G).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). Platform owns the documentation routes `GET /openapi.json` and `GET /docs` of the map, and the
 * transactional outbox: `OutboxModule` (global) lets every module write events, `OutboxRelayModule` (worker only)
 * relays them to the queues. `AuditModule` (global) gives every use case `AuditService.record` and checks that staff
 * writes are audited; `SettingsModule` (global) gives every module the cached `SettingsReader`.
 */
@Module({
  imports: [OutboxModule, AuditModule, SettingsModule],
  controllers: [DocsController, ReferenceController],
  providers: [OpenApiService, ReferenceAccessGuard],
})
export class PlatformModule {}
