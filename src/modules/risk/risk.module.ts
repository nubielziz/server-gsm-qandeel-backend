// Risk & compliance module (map domain K): IMEI checks, risk assessments, the blocklist and data requests (docs/ARCHITECTURE.md § 2).
// Stage 14 built the storefront IMEI check; the risk rules, the queue, the blocklist and the data requests are stage 18.
import { Module } from '@nestjs/common';
import { ImeiCheckModule } from './imei-check.module';

/**
 * Nest module for Risk & compliance (map domain K).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). The routes with their use cases (`ImeiCheckModule`) are separate so a test app built without a database can
 * leave out what needs it.
 */
@Module({ imports: [ImeiCheckModule] })
export class RiskModule {}
