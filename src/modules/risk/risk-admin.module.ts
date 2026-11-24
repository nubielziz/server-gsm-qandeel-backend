// The routes and use cases of the risk module's stage 18 (feature 18): the review queue and its decisions, the rules, the blocklist
// and the data requests. Separate from RiskModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { BlocklistAdminService } from './application/blocklist-admin.service';
import { RiskInputCheck } from './application/risk-input-check';
import { RiskQueueService } from './application/risk-queue.service';
import { BlocklistController } from './controllers/blocklist.controller';
import { DataRequestsController, StorePrivacyController } from './controllers/data-requests.controller';
import { RiskController } from './controllers/risk.controller';
import { RiskServicesModule } from './risk-services.module';

/**
 * Provides the routes of feature 18 that the risk module owns (the admin routes of the queue, the rules, the blocklist and the data
 * requests, and the 2 storefront privacy routes; the 3 customer routes belong to the customers module).
 *
 * Why: the use cases need the global database, crypto, audit, settings and clock providers and the security stack, which a
 * database-less test app does not have. The held-order decisions (`RiskDecisionsService`) come from `RiskServicesModule`. `RiskInputCheck`
 * is here because only the API serves checkouts: it names the rules without an input at boot (decision 050).
 */
@Module({
  imports: [RiskServicesModule],
  controllers: [RiskController, BlocklistController, DataRequestsController, StorePrivacyController],
  providers: [RiskQueueService, BlocklistAdminService, RiskInputCheck],
})
export class RiskAdminModule {}
