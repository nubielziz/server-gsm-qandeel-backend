// The route of the funnel report (map stage 19). Separate from CustomersModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { FunnelReportService } from './application/funnel-report.service';
import { GrowthController } from './controllers/growth.controller';

/**
 * Provides `/admin/reports/funnel`.
 *
 * Why: the funnel use case needs the global database and clock providers, which a database-less test app does not have.
 */
@Module({
  controllers: [GrowthController],
  providers: [FunnelReportService],
})
export class GrowthModule {}
