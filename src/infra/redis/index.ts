// Public API of the Redis infrastructure (decision 006): the Nest module, the service and the client factories.
export { RedisModule } from './redis.module';
export { RedisService, withoutCredentials } from './redis.service';
export type { RedisRole } from './redis.service';
export {
  createCacheClient,
  createQueueProducerClient,
  createWorkerConnection,
  reconnectDelayMs,
} from './redis-clients';
export {
  QUEUE_MEMORY_ALERT_RATIO,
  RedisHealthIndicator,
  RedisQueueHealthIndicator,
  parseRedisMemory,
} from './redis.health';
export type { RedisMemory } from './redis.health';
export { RedisMetrics } from './redis.metrics';
