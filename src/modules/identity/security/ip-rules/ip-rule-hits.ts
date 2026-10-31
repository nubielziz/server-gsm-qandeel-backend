// Hit counters of the IP rules, recording side (identity module, scenario ip-rules): the hook counts the requests a rule decided
// in a Redis hash; the worker's flush job (ip-rule-hits-flush.ts) writes them to ip_rules.hit_count and last_hit_at.
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Counter } from 'prom-client';
import { LogThrottle } from '../../../../common/log-throttle';
import { withTimeout } from '../../../../common/timeout';
import { CacheKeys } from '../../../../infra/cache';
import { MetricsService } from '../../../../infra/metrics';
import { RedisService } from '../../../../infra/redis';

/**
 * How long the counter hash lives in Redis without a hit.
 *
 * Why: longer than any outage of the worker that should be survivable; every hit renews it, and the flush empties it.
 */
export const HITS_TTL_MS = 24 * 60 * 60 * 1000;
/** Hit writes in flight at once; more are dropped (statistics, not truth) so a slow Redis cannot pile up memory. */
const MAX_PENDING_WRITES = 1_000;
const WARN_INTERVAL_MS = 30_000;
const SHUTDOWN_WAIT_MS = 2_000;

/**
 * Counts the requests that IP rules decide.
 *
 * Why: the console shows `hitCount` and `lastHitAt` per rule ("real requests the rule decided"), but a database write on
 * every refused request would hand an attacker a way to hurt Postgres. The hook adds to a Redis hash (fire and forget: a
 * failure never delays or fails a request) and the worker's per-minute job moves the totals to `ip_rules`
 * (`IpRuleHitsFlush`). The counters are statistics: Redis evicting them loses counts.
 *
 * The hash `CacheKeys.ipRuleHits()` holds, per rule id, the count under `<id>` and the epoch milliseconds of the latest hit
 * under `<id>:at`.
 *
 * Side effects: `record` writes that hash. Metric: `ip_rule_hit_record_failures_total{reason}`.
 *
 * @see docs/cache-keys.md and docs/queues.md (maintenance queue, job `ip_rule_hits_flush`)
 */
@Injectable()
export class IpRuleHits implements OnApplicationShutdown {
  private readonly logger = new Logger(IpRuleHits.name);
  private readonly throttle = new LogThrottle(WARN_INTERVAL_MS);
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: Counter<'reason'>;

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    metrics: MetricsService,
  ) {
    this.failures = new Counter({
      name: 'ip_rule_hit_record_failures_total',
      help: 'IP rule hits that were not counted, by reason: redis (the write failed) or dropped (too many writes in flight).',
      labelNames: ['reason'],
      registers: [metrics.registry],
    });
  }

  /**
   * Counts one request that a rule decided.
   *
   * Why: a block rule refused it, or (admin console, restriction on) an allow rule let it in.
   *
   * Side effects: one Redis round trip, not awaited; a failure is counted and logged (throttled), never thrown.
   *
   * @param ruleId the rule that decided
   * @param atMs when, in epoch milliseconds (default: now)
   */
  record(ruleId: number, atMs: number = Date.now()): void {
    if (this.pending.size >= MAX_PENDING_WRITES) {
      this.failures.inc({ reason: 'dropped' });
      return;
    }
    const write: Promise<void> = this.write(ruleId, atMs)
      .catch((error: unknown) => {
        this.failures.inc({ reason: 'redis' });
        if (this.throttle.attempt('record')) this.logger.warn(`IP rule hit not counted (Redis): ${String(error)}`);
      })
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }

  /**
   * Waits for the hit writes that are in flight.
   *
   * Why: tests and the shutdown read the counters right after a request.
   *
   * @returns resolves when every write started so far has finished
   */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Waits (briefly) for hit writes still in flight when the process stops. */
  async onApplicationShutdown(): Promise<void> {
    await withTimeout(this.idle(), SHUTDOWN_WAIT_MS, 'IP rule hit writes').catch(() => undefined);
  }

  private async write(ruleId: number, atMs: number): Promise<void> {
    const key = this.keys.ipRuleHits();
    const results = await this.redis.cache
      .multi()
      .hincrby(key, String(ruleId), 1)
      .hset(key, `${ruleId}:at`, String(atMs))
      .pexpire(key, HITS_TTL_MS)
      .exec();
    // exec() resolves even when one queued command failed; the failure sits in the result list.
    const failed = results?.find(([error]) => error !== null);
    if (failed?.[0]) throw failed[0];
  }
}
