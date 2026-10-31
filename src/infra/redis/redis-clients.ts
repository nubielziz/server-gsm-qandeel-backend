// Factories for the ioredis clients of the two Redis roles (decision 006): cache, queue producer, worker connection.
// None of them connects when it is built (`lazyConnect`); RedisService connects in onModuleInit.
import { Redis, type RedisOptions } from 'ioredis';

/**
 * Reconnect delay: 200 ms doubling up to 5 s, with +-20 % jitter so a restarted Redis is not hit by every process at once.
 *
 * @param attempt the number of the reconnect attempt, starting at 1
 * @returns milliseconds to wait before the next attempt
 */
export function reconnectDelayMs(attempt: number): number {
  const base = Math.min(200 * 2 ** (attempt - 1), 5_000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Options every client shares. */
const COMMON: RedisOptions = {
  // A constructor must never open a socket: the OpenAPI generator builds the whole app offline and fails on any attempt.
  lazyConnect: true,
  connectTimeout: 5_000,
  keepAlive: 10_000,
  retryStrategy: reconnectDelayMs,
};

/**
 * Builds the cache-role client (decision 006): cache entries, rate limits, locks, semaphores.
 *
 * Why: the cache is an optimisation, so a command must fail at once while Redis is down (callers fall back to the source
 * of truth) instead of waiting in an offline queue; a stalled Redis must not hold a request for long either.
 *
 * @param url the cache Redis URL (`REDIS_CACHE_URL`)
 * @returns an unconnected client; call `connect()` (RedisService does)
 *
 * @see docs/decisions/006-redis-topology.md
 */
export function createCacheClient(url: string): Redis {
  return new Redis(url, {
    ...COMMON,
    connectionName: 'gsm-cache',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
  });
}

/**
 * Builds the queue-role producer client (decision 006): the connection BullMQ Queues, the outbox relay and the queue
 * health check use.
 *
 * Why: a producer that waits for a dead Redis would pile up commands in memory and hang the request that enqueues; with
 * `enableOfflineQueue: false` it fails fast and the caller keeps the work in Postgres (the outbox, decision 020).
 *
 * @param url the queue Redis URL (`REDIS_QUEUE_URL`)
 * @returns an unconnected client; call `connect()` (RedisService does)
 *
 * @see docs/decisions/006-redis-topology.md
 */
export function createQueueProducerClient(url: string): Redis {
  return new Redis(url, {
    ...COMMON,
    connectionName: 'gsm-queue-producer',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 5_000,
  });
}

/**
 * Builds a connection for a BullMQ Worker (decision 006).
 *
 * Why: a Worker blocks on Redis commands and must survive restarts of the queue Redis, so its commands wait for the
 * connection (`maxRetriesPerRequest: null`, which BullMQ requires) and the client reconnects forever. It has no command
 * timeout because blocking reads legitimately wait.
 *
 * @param url the queue Redis URL (`REDIS_QUEUE_URL`)
 * @returns an unconnected client; BullMQ connects it when the Worker starts
 *
 * @see docs/decisions/006-redis-topology.md
 */
export function createWorkerConnection(url: string): Redis {
  return new Redis(url, {
    ...COMMON,
    connectionName: 'gsm-queue-worker',
    maxRetriesPerRequest: null,
  });
}
