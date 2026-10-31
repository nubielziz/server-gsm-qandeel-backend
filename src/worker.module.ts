// Root module of the worker process (decision 016): config, logging, metrics and the metrics listener.
// BullMQ processors, schedulers and the outbox relay are added by P2.4 and the feature stages.
import { Module } from '@nestjs/common';
import { ConfigModule } from './config';
import { LoggingModule } from './infra/logging';
import { MetricsModule, WorkerMetricsServer } from './infra/metrics';

/**
 * Root Nest module of the worker process.
 *
 * Why: the worker shares the codebase with the API but never serves the API's routes; it exposes its own `/metrics`
 * on `WORKER_METRICS_PORT` so Prometheus can scrape queue and job metrics (decision 015).
 */
@Module({
  imports: [ConfigModule, LoggingModule.forRoot({ service: 'worker' }), MetricsModule],
  providers: [WorkerMetricsServer],
})
export class WorkerModule {}
