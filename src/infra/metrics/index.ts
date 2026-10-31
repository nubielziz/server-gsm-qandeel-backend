// Public surface of src/infra/metrics: the service, the access rule/guard, the HTTP hook and the Nest module.
export { MetricsModule } from './metrics.module';
export { MetricsService } from './metrics.service';
export type { ApiErrorLabels, HttpMetricLabels } from './metrics.service';
export { authorizeMetricsRequest, hasForwardingHeaders, isPrivateAddress } from './metrics-access';
export type { MetricsAccessRequest } from './metrics-access';
export { MetricsAccessGuard } from './metrics-access.guard';
export { registerHttpMetrics } from './http-metrics';
export { WorkerMetricsServer } from './worker-metrics.server';
