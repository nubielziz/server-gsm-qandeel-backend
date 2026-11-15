// The doorbell publisher of the real-time layer (decision 037): after a commit, a change rings one Redis pub/sub channel on the
// cache Redis with ids only; the API process holding the streams re-reads Postgres. API and worker; it never throws to a use case.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock';
import { LogThrottle } from '../../common/log-throttle';
import { APP_CONFIG, type AppConfig } from '../../config';
import { onCommit } from '../db';
import { MetricsService } from '../metrics';
import { RedisService } from '../redis';
import { RealtimePublisherMetrics } from './realtime-metrics';
import type { Doorbell } from './realtime.types';

/** The largest doorbell (its JSON in bytes); ids only, so 500 recipient ids of a campaign chunk fit. */
export const MAX_DOORBELL_BYTES = 8 * 1024;
/** One log line per topic per interval while publishing fails (Redis down). */
const FAILURE_LOG_INTERVAL_MS = 30_000;

/**
 * The database number of a Redis URL (`redis://host:6380/7` is 7; none is 0).
 *
 * Why: Redis pub/sub ignores `SELECT`, so the worktree test runs that share one Redis instance on different database numbers would
 * hear each other's doorbells; the channel name carries the number instead.
 *
 * @param url a `redis://` or `rediss://` URL
 * @returns the database number
 */
export function redisDatabaseOf(url: string): number {
  const path = new URL(url).pathname.replace(/^\/+/, '');
  const db = Number.parseInt(path, 10);
  return Number.isSafeInteger(db) && db >= 0 ? db : 0;
}

/**
 * The doorbell channel of a process: `gsm:{env}:realtime:doorbell:{db}`.
 *
 * Why: decision 037: one channel for every topic (one subscriber per API process filters in memory); the environment and the
 * database number keep environments and worktrees that share an instance apart.
 *
 * @param config the process configuration (environment and cache Redis URL)
 * @returns the channel name
 */
export function realtimeChannel(config: Pick<AppConfig, 'env' | 'redis'>): string {
  return `gsm:${config.env}:realtime:doorbell:${redisDatabaseOf(config.redis.cacheUrl)}`;
}

/**
 * Rings the real-time doorbell.
 *
 * Why: decision 037: an open stream learns of a change at once, without polling. The doorbell carries ids only; a lost one loses
 * no data (the truth is in Postgres, a reconnect replays, the hub sends `resync` after its subscriber reconnects, clients keep a
 * slow safety poll). Not the outbox: the relay is FIFO and shared with order dispatch, and a doorbell is worth nothing a second
 * later.
 *
 * Side effects: `PUBLISH` on the cache Redis; counts `realtime_doorbells_published_total{topic}` and
 * `realtime_publish_failures_total{topic}`.
 *
 * @see docs/decisions/037-realtime-sse.md
 */
@Injectable()
export class RealtimePublisher {
  /** The channel every doorbell of this process goes to. */
  readonly channel: string;
  private readonly logger = new Logger(RealtimePublisher.name);
  private readonly throttle = new LogThrottle(FAILURE_LOG_INTERVAL_MS);
  private readonly metrics: RealtimePublisherMetrics;
  /** Under test an oversize doorbell is a thrown programming error; elsewhere it is logged and counted. */
  private readonly strict: boolean;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly redis: RedisService,
    @Inject(CLOCK) private readonly clock: Clock,
    metrics: MetricsService,
  ) {
    this.channel = realtimeChannel(config);
    this.strict = config.env === 'test';
    this.metrics = new RealtimePublisherMetrics(metrics.registry);
  }

  /**
   * Publishes a doorbell now.
   *
   * @param topic the source that renders it (`inbox`) or `session`
   * @param op what happened (`created`)
   * @param fields ids only (never a text, a token, an email address or a cookie)
   * @returns true when Redis took it; false when it was refused or Redis failed (logged and counted, never thrown)
   * @throws {Error} only under `NODE_ENV=test`, for a doorbell over {@link MAX_DOORBELL_BYTES} (a programming error)
   */
  async publish(topic: string, op: string, fields: Readonly<Record<string, unknown>> = {}): Promise<boolean> {
    const doorbell: Doorbell = { ...fields, v: 1, topic, op, at: this.clock.nowMs() };
    const json = JSON.stringify(doorbell);
    if (Buffer.byteLength(json) > MAX_DOORBELL_BYTES) {
      const message = `The ${topic}.${op} doorbell is ${Buffer.byteLength(json)} bytes, over ${MAX_DOORBELL_BYTES}: send ids only`;
      if (this.strict) throw new Error(message);
      this.metrics.failures.inc({ topic });
      this.logger.error(message);
      return false;
    }
    try {
      await this.redis.cache.publish(this.channel, json);
      this.metrics.published.inc({ topic });
      return true;
    } catch (error) {
      this.metrics.failures.inc({ topic });
      const allowed = this.throttle.attempt(topic);
      if (allowed) {
        const more = allowed.suppressed > 0 ? ` (${allowed.suppressed} more not logged)` : '';
        this.logger.warn(
          `Could not publish a ${topic} doorbell: ${error instanceof Error ? error.message : String(error)}${more}`,
        );
      }
      return false;
    }
  }

  /**
   * Publishes a doorbell after the current transaction commits, or at once outside a transaction (`onCommit`).
   *
   * Why: a reader must find the row the doorbell is about; a rolled-back change rings nothing.
   *
   * @param topic the source that renders it
   * @param op what happened
   * @param fields ids only
   */
  publishOnCommit(topic: string, op: string, fields: Readonly<Record<string, unknown>> = {}): void {
    onCommit(() => this.publish(topic, op, fields).then(() => undefined));
  }
}
