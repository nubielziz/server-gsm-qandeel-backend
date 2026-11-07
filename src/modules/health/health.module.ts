// System health module (map domain G, surface system): GET /health and GET /metrics, plus the indicator registry.
// The /admin/system/* routes and the dashboard are in HealthAdminModule (stage 9); alert rules and incidents arrive with 12b.
import { Module } from '@nestjs/common';
import { HealthRegistryModule } from '../../infra/health';
import { HealthService } from './application/health.service';
import { HealthController } from './controllers/health.controller';
import { MetricsController } from './controllers/metrics.controller';
import { HealthAdminModule } from './health-admin.module';

/**
 * Nest module for system health.
 *
 * Why: one module per map domain (decision 016). It reads the shared registry of `src/infra/health`, where the
 * database and Redis modules register their indicators without health depending on them.
 */
@Module({
  controllers: [HealthController, MetricsController],
  imports: [HealthRegistryModule, HealthAdminModule],
  providers: [HealthService],
})
export class HealthModule {}
