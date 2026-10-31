// System health module (map domain G, surface system): GET /health and GET /metrics, plus the indicator registry.
// Alert rules, incidents, job runs and the /admin/system/* routes arrive with the health features (stage 9).
import { Module } from '@nestjs/common';
import { HealthRegistry } from './application/health-registry';
import { HealthService } from './application/health.service';
import { HealthController } from './controllers/health.controller';
import { MetricsController } from './controllers/metrics.controller';

/**
 * Nest module for system health.
 *
 * Why: one module per map domain (decision 016). It exports {@link HealthRegistry} so the database and Redis modules
 * can register their indicators without health depending on them.
 */
@Module({
  controllers: [HealthController, MetricsController],
  providers: [HealthRegistry, HealthService],
  exports: [HealthRegistry],
})
export class HealthModule {}
