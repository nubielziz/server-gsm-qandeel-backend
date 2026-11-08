// Commissions & referrals module (map domain F): commission plans, assignments and accruals (stage 11: the admin and merchant portal routes,
// the accrual engine that listens to order completions and the bulk approval).
import { Module } from '@nestjs/common';
import { CommissionsAdminModule } from './commissions-admin.module';

/**
 * Nest module for Commissions & referrals (map domain F).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts` (decision 016). The routes
 * and use cases are `CommissionsAdminModule`; the engine that accrues commissions is `CommissionsEngineModule`, which the worker loads too.
 */
@Module({ imports: [CommissionsAdminModule] })
export class CommissionsModule {}
