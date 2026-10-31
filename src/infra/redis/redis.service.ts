// The process-wide Redis clients (decision 006): one cache client and one queue producer client per process, plus a
// factory for BullMQ worker connections. Connects in onModuleInit, closes in onApplicationShutdown.
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { LogThrottle } from '../../common/log-throttle';
import { TimeoutError, withTimeout } from '../../common/timeout';
import { APP_CONFIG, type AppConfig } from '../../config';
import { createCacheClient, createQueueProducerClient, createWorkerConnection } from './redis-clients';

/** The Redis instances of decision 006. */
export type RedisRole = 'cache' | 'queue';

/** How long onModuleInit waits for the first connection of a client before it lets the app start anyway. */
const STARTUP_WAIT_MS = 3_000;
/** How long a shutdown waits for `QUIT` before it drops the socket. */
const QUIT_WAIT_MS = 2_000;
/** Redis errors repeat on every reconnect attempt; one line per client per interval is logged. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Removes `user:password@` from anything that looks like a URL.
 *
 * Why: a connection error can carry the Redis URL, and a log line must never carry a credential.
 *
 * @param message text that may contain URLs
 * @returns the text with the credentials of every URL replaced by `***`
 */
export function withoutCredentials(message: string): string {
  return message.replace(/\/\/[^@\s/]+@/g, '//***@');
}

/**
 * Owns the Redis clients of this process.
 *
 * Why: decision 006 keeps two roles that never mix: the queue Redis (noeviction, AOF) holds BullMQ data only; the cache
 * Redis (allkeys-lru) holds cache entries, rate limits and locks. Every part of a process shares one client per role.
 * Constructors never connect, so the OpenAPI generator can build the app offline (the clients are `lazyConnect`).
 *
 * Side effects: opens two connections in `onModuleInit` (the app still starts when Redis is down; the clients keep
 * retrying in the background); closes them, and every worker connection it created, in `onApplicationShutdown`.
 *
 * @see docs/decisions/006-redis-topology.md
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  /** Cache-role client: cache entries, rate limits, locks. Commands fail at once while Redis is down. */
  readonly cache: Redis;
  /** Queue-role producer client: BullMQ Queues and the outbox relay. Commands fail at once while Redis is down. */
  readonly queue: Redis;

  private readonly logger = new Logger(RedisService.name);
  private readonly throttle = new LogThrottle(ERROR_LOG_INTERVAL_MS);
  private readonly workerConnections = new Set<Redis>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.cache = createCacheClient(config.redis.cacheUrl);
    this.queue = createQueueProducerClient(config.redis.queueUrl);
    this.watch(this.cache, 'cache');
    this.watch(this.queue, 'queue');
  }

  /**
   * Connects both clients, waiting at most a few seconds for each.
   *
   * Why: a command sent before the connection is ready fails at once (no offline queue), so the first request after boot
   * must find the clients connected. A Redis that is down must not stop the API from starting: `GET /health` reports it
   * as degraded and the clients reconnect on their own.
   */
  async onModuleInit(): Promise<void> {
    await Promise.all([this.open(this.cache, 'cache'), this.open(this.queue, 'queue')]);
  }

  /**
   * Creates a connection for a BullMQ Worker (`maxRetriesPerRequest: null`, reconnects forever).
   *
   * Why: Workers block on Redis and must wait out a restart of the queue Redis (decision 006). The connection is not
   * opened here; BullMQ connects it. It is closed at shutdown if the caller did not close it before.
   *
   * @returns an unconnected ioredis client for the queue Redis
   */
  createWorkerConnection(): Redis {
    const connection = createWorkerConnection(this.config.redis.queueUrl);
    this.watch(connection, 'queue worker');
    this.workerConnections.add(connection);
    return connection;
  }

  /** Closes every client of this process. Idempotent, and never throws: a dead Redis must not block the shutdown. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.cache, this.queue, ...this.workerConnections].map((client) => this.close(client)));
    this.workerConnections.clear();
  }

  /** Logs connection errors without secrets and says when a client is reachable again. */
  private watch(client: Redis, label: string): void {
    let wasDown = false;
    // Without an error listener ioredis would throw the first connection error as an uncaught exception.
    client.on('error', (error: Error) => {
      wasDown = true;
      const allowed = this.throttle.attempt(`${label}:error`);
      if (!allowed) return;
      const more = allowed.suppressed > 0 ? ` (${allowed.suppressed} similar errors not logged)` : '';
      this.logger.warn(`Redis ${label} error: ${withoutCredentials(error.message)}${more}`);
    });
    client.on('ready', () => {
      if (!wasDown) return;
      wasDown = false;
      this.logger.log(`Redis ${label} is reachable again`);
    });
  }

  private async open(client: Redis, label: string): Promise<void> {
    if (client.status !== 'wait') return;
    try {
      await withTimeout(client.connect(), STARTUP_WAIT_MS, `Redis ${label} connection`);
    } catch (error) {
      // ioredis keeps reconnecting after a failed first attempt, so the app can start; health reports it meanwhile.
      const reason = error instanceof TimeoutError ? error.message : 'the connection was refused or closed';
      this.logger.warn(`Redis ${label} is not reachable yet (${reason}); starting anyway, retrying in the background`);
    }
  }

  private async close(client: Redis): Promise<void> {
    // A client that never connected would connect just to say QUIT; ending it is enough.
    if (client.status === 'end' || client.status === 'wait') {
      client.disconnect();
      return;
    }
    // Only a client with a live socket has a close event to wait for; a reconnecting one has none.
    const hasSocket = ['connecting', 'connect', 'ready'].includes(client.status);
    const ended = hasSocket ? new Promise<void>((resolve) => client.once('end', resolve)) : Promise.resolve();
    try {
      await withTimeout(client.quit(), QUIT_WAIT_MS, 'Redis QUIT');
    } catch {
      // Unreachable or too slow: drop the socket and stop the reconnect timer.
    } finally {
      client.disconnect();
    }
    await withTimeout(ended, QUIT_WAIT_MS, 'Redis close').catch(() => undefined);
  }
}
