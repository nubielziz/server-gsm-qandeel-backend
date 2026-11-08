// The routes of the Checkouts page of the console (map stage 19): the abandoned list, the recovery send and the funnel. Separate from
// CustomersModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { AbandonedCheckoutsService } from './application/abandoned-checkouts.service';
import { CheckoutRecoveryService } from './application/checkout-recovery.service';
import { FunnelReportService } from './application/funnel-report.service';
import { CheckoutRecoveryModule } from './checkout-recovery.module';
import { GrowthController } from './controllers/growth.controller';

/**
 * Provides `/admin/checkouts/abandoned`, `/admin/checkouts/recover` and `/admin/reports/funnel`.
 *
 * Why: these use cases need the global database, audit, settings and clock providers and the queue Redis, which a database-less test
 * app does not have.
 */
@Module({
  imports: [CheckoutRecoveryModule],
  controllers: [GrowthController],
  providers: [AbandonedCheckoutsService, CheckoutRecoveryService, FunnelReportService],
})
export class GrowthModule {}
