// Risk & compliance module (map domain K): IMEI checks, risk assessments, the blocklist and data requests (docs/ARCHITECTURE.md § 2).
// Stage 14 built the storefront IMEI check; stage 18 adds the risk rules and queue, the blocklist, the IMEI log and the data requests.
import { Module } from '@nestjs/common';
import { ImeiCheckModule } from './imei-check.module';
import { RiskAdminModule } from './risk-admin.module';

/**
 * Nest module for Risk & compliance (map domain K).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). The routes with their use cases (`ImeiCheckModule`, `RiskAdminModule`) are separate so a test app built without a
 * database can leave out what needs it.
 */
@Module({ imports: [ImeiCheckModule, RiskAdminModule] })
export class RiskModule {}
