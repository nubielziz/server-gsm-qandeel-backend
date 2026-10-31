// Global Nest module for the two Redis roles (decision 006): provides RedisService and registers the `redis` and
// `redis_queue` health checks. Shared by the API and the worker.
import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry, HealthRegistryModule } from '../health';
import { RedisHealthIndicator, RedisQueueHealthIndicator } from './redis.health';
import { RedisMetrics } from './redis.metrics';
import { RedisService } from './redis.service';

/**
 * Provides {@link RedisService} to every module and registers the Redis health indicators.
 *
 * Why: the cache, the rate limiter, BullMQ and the outbox share the clients of the process; `GET /health` reports both
 * Redis roles as non-critical components (decision 015, map B11). Registering in `onModuleInit` keeps `src/infra` free
 * of imports from the health module (decision 016).
 *
 * @see docs/decisions/006-redis-topology.md
 */
@Global()
@Module({
  imports: [HealthRegistryModule],
  providers: [RedisService, RedisMetrics],
  exports: [RedisService],
})
export class RedisModule implements OnModuleInit {
  constructor(
    private readonly redis: RedisService,
    private readonly registry: HealthRegistry,
  ) {}

  /** Registers the `redis` and `redis_queue` indicators; the checks run only when `/health` is called. */
  onModuleInit(): void {
    this.registry.register(new RedisHealthIndicator(this.redis.cache));
    this.registry.register(new RedisQueueHealthIndicator(this.redis.queue));
  }
}
