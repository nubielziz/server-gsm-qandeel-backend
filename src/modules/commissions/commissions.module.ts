// Commissions & referrals module (map domain F): commission plans, assignments and accruals.
// Empty shell in P2.1; its feature adds controllers, services and the owned tables (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';

/**
 * Nest module for Commissions & referrals (map domain F).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016).
 */
@Module({})
export class CommissionsModule {}
