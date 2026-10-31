// Public API of the health module: the module and the indicator registry other modules register their checks with.
export { HealthModule } from './health.module';
export { HealthRegistry } from './application/health-registry';
export type { HealthIndicator, HealthStatus } from './application/health-registry';
export type { HealthReport } from './application/health.service';
