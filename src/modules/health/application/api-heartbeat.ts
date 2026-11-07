// The API process's heartbeat: it leaves a timestamp in the cache Redis every 30 s, and the worker's checker reads it to judge the
// `api` component (the worker cannot call the API itself, and a Prometheus scrape may be absent).
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock, TIMERS, type Timers } from '../../../common/clock';
import { CacheKeys } from '../../../infra/cache';
import { RedisService } from '../../../infra/redis';

/** The heartbeat name the checker reads. */
export const API_HEARTBEAT_NAME = 'api';
/** Seconds a heartbeat lives in Redis. */
export const HEARTBEAT_TTL_SECONDS = 120;
/** Milliseconds between two beats. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Writes the API's heartbeat.
 *
 * Why: the `api` health component is "is an API process alive": the checker (in the worker) accepts a heartbeat up to 90 s old. A
 * failed write is ignored: Redis being down is its own component's problem, and the beat resumes by itself.
 *
 * Side effects: `SET ... EX 120` on `CacheKeys.heartbeat('api')` at start and every 30 s; the timer is cleared at shutdown.
 */
@Injectable()
export class ApiHeartbeat implements OnModuleInit, OnApplicationShutdown {
  private timer: unknown;
  private stopped = false;

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TIMERS) private readonly timers: Timers,
  ) {}

  /** Beats once and starts the interval. */
  async onModuleInit(): Promise<void> {
    await this.beat();
    this.arm();
  }

  /** Stops the interval. */
  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
  }

  /**
   * Writes one heartbeat.
   *
   * @returns resolves when written or when Redis refused (never rejects)
   */
  async beat(): Promise<void> {
    try {
      await this.redis.cache.set(
        this.keys.heartbeat(API_HEARTBEAT_NAME),
        this.clock.now().toISOString(),
        'EX',
        HEARTBEAT_TTL_SECONDS,
      );
    } catch {
      // Redis is away; the next beat retries.
    }
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      void this.beat().finally(() => this.arm());
    }, HEARTBEAT_INTERVAL_MS);
  }
}
