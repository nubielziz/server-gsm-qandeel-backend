// Root module of the worker process (decision 016): config, logging, metrics, the infrastructure (database, Redis, cache,
// rate limits, crypto, storage, outbound HTTP) and the metrics listener. BullMQ processors, schedulers and the outbox
// relay are added by the queue feature and the feature stages.
import { Module } from '@nestjs/common';
import { ConfigModule } from './config';
import { CacheModule } from './infra/cache';
import { CryptoModule } from './infra/crypto';
import { DbModule } from './infra/db';
import { OutboundHttpModule } from './infra/http';
import { LoggingModule } from './infra/logging';
import { MetricsModule, WorkerMetricsServer } from './infra/metrics';
import { RateLimitModule } from './infra/rate-limit';
import { RedisModule } from './infra/redis';
import { StorageModule } from './infra/storage';

/**
 * Root Nest module of the worker process.
 *
 * Why: the worker shares the codebase with the API but never serves the API's routes; it exposes its own `/metrics`
 * on `WORKER_METRICS_PORT` so Prometheus can scrape queue and job metrics (decision 015).
 */
@Module({
  imports: [
    ConfigModule,
    LoggingModule.forRoot({ service: 'worker' }),
    MetricsModule,
    DbModule,
    RedisModule,
    CacheModule,
    RateLimitModule,
    CryptoModule,
    StorageModule,
    OutboundHttpModule,
  ],
  providers: [WorkerMetricsServer],
})
export class WorkerModule {}
