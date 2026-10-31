# Redis infrastructure (`src/infra/redis`)

The two Redis roles of decision 006, as one client each per process. The queue Redis (`noeviction`, AOF) holds BullMQ
data only; the cache Redis (`allkeys-lru`) holds cache entries, rate limits, locks and semaphores. They are never mixed.

| What                                                       | Where                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Client factories (cache, queue producer, worker connection) | `redis-clients.ts`                                                                          |
| Nest provider, connect/close lifecycle, logging             | `redis.service.ts` (`RedisService`), `redis.module.ts`                                      |
| Health indicators `redis` and `redis_queue`                 | `redis.health.ts` (non-critical: a failure makes `GET /health` `degraded`, never `down`)     |
| Memory gauges `redis_memory_used_bytes{role}` / `_max_bytes` | `redis.metrics.ts` (read from `INFO memory` on every scrape)                                 |

## Rules

- **Constructors never connect.** Every client is `lazyConnect`; `RedisService.onModuleInit` connects (waiting at most 3 s,
  and starting anyway if Redis is down), `onApplicationShutdown` closes. The OpenAPI generator builds the app offline and
  fails on any socket attempt, so `bun run docs:openapi:check` proves it.
- **Cache and queue producer clients fail fast.** `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, a command timeout:
  while Redis is down a command rejects at once instead of piling up in memory. The cache callers fall back to the source
  of truth; the producer's caller keeps the work in Postgres (the outbox, decision 020).
- **Worker connections** come from `RedisService.createWorkerConnection()`: `maxRetriesPerRequest: null` (BullMQ requires
  it), reconnects forever, closed at shutdown.
- **BullMQ `Queue.add` waits** for the shared connection's first `ready`, so while Redis is down at startup it hangs instead
  of failing. Call `RedisService.assertQueueReady()` (throws `503 UNAVAILABLE` at once) before enqueueing.
- Every client has an `error` listener. Errors are logged once per 30 s per client, with credentials stripped.
- Tests use **database 1** of both instances (`REDIS_QUEUE_URL_TEST`, `REDIS_CACHE_URL_TEST`); under `NODE_ENV=test` the
  normal URLs are ignored.
