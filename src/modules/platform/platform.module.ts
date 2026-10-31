// Platform module (map domain G): settings, audit logs, files, notifications, webhooks and the outbox.
// Today it serves the API documentation (src/modules/platform/docs); the other parts arrive with their features
// (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';
import { DocsController, ReferenceController } from './docs/docs.controller';
import { OpenApiService } from './docs/openapi.service';
import { ReferenceAccessGuard } from './docs/reference-access.guard';

/**
 * Nest module for Platform (map domain G).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). Platform owns the documentation routes `GET /openapi.json` and `GET /docs` of the map.
 */
@Module({
  controllers: [DocsController, ReferenceController],
  providers: [OpenApiService, ReferenceAccessGuard],
})
export class PlatformModule {}
