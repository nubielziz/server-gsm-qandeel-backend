// System health module (map domain G, surface system): GET /health and GET /metrics, plus the indicator registry.
// Alert rules, incidents, job runs and the /admin/system/* routes arrive with the health features (stage 9).
import { Module } from '@nestjs/common';
import { HealthRegistryModule } from '../../infra/health';
import { HealthService } from './application/health.service';
import { HealthController } from './controllers/health.controller';
import { MetricsController } from './controllers/metrics.controller';

/**
 * Nest module for system health.
 *
 * Why: one module per map domain (decision 016). It reads the shared registry of `src/infra/health`, where the
 * database and Redis modules register their indicators without health depending on them.
 */
@Module({
  controllers: [HealthController, MetricsController],
  imports: [HealthRegistryModule],
  providers: [HealthService],
})
export class HealthModule {}
