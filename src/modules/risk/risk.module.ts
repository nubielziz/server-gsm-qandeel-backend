// Risk & compliance module (map domain K): IMEI checks, risk assessments, the blocklist and data requests.
// Empty shell in P2.1; its feature adds controllers, services and the owned tables (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';

/**
 * Nest module for Risk & compliance (map domain K).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016).
 */
@Module({})
export class RiskModule {}
