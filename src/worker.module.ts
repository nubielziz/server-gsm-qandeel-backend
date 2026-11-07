// Root module of the worker process (decision 016): config, the clock (decision 031), logging, metrics, the infrastructure (database, Redis, cache,
// rate limits, crypto, storage, outbound HTTP), the queue workers and schedulers, the outbox relay, job runs, the IP rule
// hit flush, the ended-session purge, the merchant mail jobs (verification, reset and invitation links), and the metrics listener. Domain modules add their processors and schedules here as their features are built.
import { Module } from '@nestjs/common';
import { ClockModule } from './common/clock.module';
import { ConfigModule } from './config';
import { CacheModule } from './infra/cache';
import { CryptoModule } from './infra/crypto';
import { DbModule } from './infra/db';
import { OutboundHttpModule } from './infra/http';
import { LoggingModule } from './infra/logging';
import { MetricsModule, WorkerMetricsServer } from './infra/metrics';
import { QueueWorkersModule, QueuesModule } from './infra/queues';
import { RateLimitModule } from './infra/rate-limit';
import { RedisModule } from './infra/redis';
import { StorageModule } from './infra/storage';
import { JobRunsModule } from './modules/health';
import { IpRuleHitsFlushModule, MerchantMailModule, SessionPurgeModule } from './modules/identity';
import { OutboxRelayModule } from './modules/platform';

/**
 * Root Nest module of the worker process.
 *
 * Why: the worker shares the codebase with the API but never serves the API's routes. It runs the BullMQ workers for
 * every `@QueueProcessor`, creates the job schedulers on boot, relays the outbox (decision 020), and exposes its own
 * `/metrics` on `WORKER_METRICS_PORT` so Prometheus can scrape queue and job metrics (decision 015). Shutdown order
 * (decision 001): workers and the relay stop in `onModuleDestroy`; the pool, Redis and the producers close afterwards.
 */
@Module({
  imports: [
    ConfigModule,
    ClockModule,
    LoggingModule.forRoot({ service: 'worker' }),
    MetricsModule,
    DbModule,
    RedisModule,
    CacheModule,
    RateLimitModule,
    CryptoModule,
    StorageModule,
    OutboundHttpModule,
    QueuesModule,
    QueueWorkersModule,
    JobRunsModule,
    OutboxRelayModule,
    IpRuleHitsFlushModule,
    SessionPurgeModule,
    MerchantMailModule,
  ],
  providers: [WorkerMetricsServer],
})
export class WorkerModule {}
