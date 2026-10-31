# 006: Redis topology: a queue Redis and a cache Redis

Status: accepted, 2026-10-31.

**Context.** BullMQ is only correct when nothing is evicted; a cache wants eviction. One instance cannot have both.

**Decision.** Two Redis 8 instances (compose: `redis-queue`, `redis-cache`).
- Queue Redis: `maxmemory-policy noeviction`, AOF with `appendfsync everysec`, persistent volume. Holds BullMQ data
  only (queues, job schedulers, BullMQ's own rate limiter state).
- Cache Redis: `allkeys-lru`, no persistence. Holds the cache, rate-limit counters, stampede locks, session lookup
  cache and other short-lived state. Losing it costs only rebuilds.
- One shared ioredis client per role per process. Queue producers fail fast (`enableOfflineQueue: false`); Worker
  connections use `maxRetriesPerRequest: null` and reconnect forever.

Health: the System health cache card reports the cache Redis; the queue Redis is its own component (`redis_queue`)
with a memory alert, because a full noeviction instance refuses writes.

**Consequences.** Idempotency results, balances, holds and statuses never live in either Redis (Postgres only).
Production may use managed Redis or Valkey with the same two policies; the env has two URLs (`REDIS_QUEUE_URL`,
`REDIS_CACHE_URL`).
