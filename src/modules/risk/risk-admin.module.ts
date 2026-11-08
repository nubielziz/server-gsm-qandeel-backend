// The routes and use cases of the risk module's stage 18 (feature 18): the review queue and its decisions, the rules, the blocklist,
// the IMEI log and the data requests. Separate from RiskModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { BlocklistAdminService } from './application/blocklist-admin.service';
import { ImeiCheckAdminService } from './application/imei-check-admin.service';
import { RiskQueueService } from './application/risk-queue.service';
import { BlocklistController } from './controllers/blocklist.controller';
import { DataRequestsController, StorePrivacyController } from './controllers/data-requests.controller';
import { ImeiChecksAdminController } from './controllers/imei-checks-admin.controller';
import { RiskController } from './controllers/risk.controller';
import { RiskServicesModule } from './risk-services.module';

/**
 * Provides the 19 routes of feature 18 that the risk module owns (16 admin routes and the 2 storefront privacy routes; the 3
 * customer routes belong to the customers module).
 *
 * Why: the use cases need the global database, crypto, audit, settings and clock providers and the security stack, which a
 * database-less test app does not have. The held-order decisions (`RiskDecisionsService`) come from `RiskServicesModule`.
 */
@Module({
  imports: [RiskServicesModule],
  controllers: [
    RiskController,
    BlocklistController,
    ImeiChecksAdminController,
    DataRequestsController,
    StorePrivacyController,
  ],
  providers: [RiskQueueService, BlocklistAdminService, ImeiCheckAdminService],
})
export class RiskAdminModule {}
