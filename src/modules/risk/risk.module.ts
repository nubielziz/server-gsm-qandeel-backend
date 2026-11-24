// Risk & compliance module (map domain K): risk assessments, the blocklist and data requests (docs/ARCHITECTURE.md § 2).
// Stage 18 added the risk rules and queue, the blocklist and the data requests.
import { Module } from '@nestjs/common';
import { RiskAdminModule } from './risk-admin.module';

/**
 * Nest module for Risk & compliance (map domain K).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). The routes with their use cases (`RiskAdminModule`) are separate so a test app built without a database can leave out
 * what needs it.
 */
@Module({ imports: [RiskAdminModule] })
export class RiskModule {}
