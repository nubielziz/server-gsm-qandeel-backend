// Hit counters of the IP rules, flushing side (identity module, worker process): takes the counters the API recorded in
// Redis and adds them to ip_rules.hit_count and last_hit_at.
import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';
import { CacheKeys } from '../../../../infra/cache';
import { DbService } from '../../../../infra/db';
import { MetricsService } from '../../../../infra/metrics';
import { RedisService } from '../../../../infra/redis';
import { HITS_TTL_MS } from './ip-rule-hits';
import { type RuleHits, addIpRuleHits } from './ip-rule.repository';

/**
 * Takes the whole hash and deletes it in one step, so two flushes can never take the same counters.
 * KEYS[1] the hash: `<rule id>` is the count, `<rule id>:at` the epoch milliseconds of the latest hit.
 */
const TAKE = `local data = redis.call('hgetall', KEYS[1])
if #data > 0 then redis.call('del', KEYS[1]) end
return data`;

/**
 * Puts counters back after a failed write, without losing hits that arrived meanwhile.
 * KEYS[1] the hash; ARGV[1] the TTL in ms; then triples: rule id, count, latest hit in ms.
 */
const GIVE_BACK = `for i = 2, #ARGV, 3 do
  redis.call('hincrby', KEYS[1], ARGV[i], ARGV[i + 1])
  local current = tonumber(redis.call('hget', KEYS[1], ARGV[i] .. ':at') or '0')
  if tonumber(ARGV[i + 2]) > current then redis.call('hset', KEYS[1], ARGV[i] .. ':at', ARGV[i + 2]) end
end
redis.call('pexpire', KEYS[1], ARGV[1])
return 1`;

/**
 * What one flush did.
 *
 * Why: the job result (kept with the BullMQ job) and the tests read how much was written.
 */
export interface FlushResult {
  /** Rules that had hits. */
  readonly rules: number;
  /** Hits written, over all rules. */
  readonly hits: number;
}

/**
 * Writes the counted IP rule hits to Postgres.
 *
 * Why: the worker runs it every minute (job `ip_rule_hits_flush`, queue `maintenance`, decision 020: no `job_runs` row, the
 * metrics below show its health). The hash is taken and deleted in one Redis step, so two flushes (two workers, a retry)
 * never count a hit twice; when the database write fails the counts go back to Redis, added to the hits that arrived
 * meanwhile, and the error is rethrown. A crash between taking and writing loses at most a minute of counts.
 *
 * Side effects: updates `ip_rules.hit_count` and `last_hit_at` (not `updated_at`); empties the Redis hash. Metrics (worker):
 * `ip_rule_hits_flushed_total`, `ip_rule_hits_flush_failures_total`,
 * `ip_rule_hits_flush_last_success_timestamp_seconds` (alert when it stops moving).
 *
 * @see docs/queues.md (maintenance queue, job `ip_rule_hits_flush`)
 */
@Injectable()
export class IpRuleHitsFlush {
  private readonly logger = new Logger(IpRuleHitsFlush.name);
  private readonly flushed: Counter;
  private readonly failures: Counter;
  private readonly lastSuccess: Gauge;

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    private readonly db: DbService,
    metrics: MetricsService,
  ) {
    const registers = [metrics.registry];
    this.flushed = new Counter({
      name: 'ip_rule_hits_flushed_total',
      help: 'IP rule hits written to ip_rules by the flush job.',
      registers,
    });
    this.failures = new Counter({
      name: 'ip_rule_hits_flush_failures_total',
      help: 'Flushes of the IP rule hit counters that failed (the counts are put back in Redis).',
      registers,
    });
    this.lastSuccess = new Gauge({
      name: 'ip_rule_hits_flush_last_success_timestamp_seconds',
      help: 'Unix time of the last successful flush of the IP rule hit counters (an alert fires when it stops moving).',
      registers,
    });
  }

  /**
   * Writes the counted hits to `ip_rules` and clears the counters.
   *
   * @returns how many rules and hits were written (0 and 0 when nothing was counted)
   * @throws {Error} when Redis cannot be read or Postgres refuses the update (after the counts were put back)
   */
  async flush(): Promise<FlushResult> {
    try {
      const result = await this.run();
      this.lastSuccess.setToCurrentTime();
      return result;
    } catch (error) {
      this.failures.inc();
      throw error;
    }
  }

  private async run(): Promise<FlushResult> {
    const taken = await this.take();
    if (taken.length === 0) return { rules: 0, hits: 0 };
    try {
      await addIpRuleHits(this.db.db, taken);
    } catch (error) {
      await this.giveBack(taken);
      throw error;
    }
    const hits = taken.reduce((sum, entry) => sum + entry.count, 0);
    this.flushed.inc(hits);
    return { rules: taken.length, hits };
  }

  /** Reads and deletes the whole hash, then turns it into one entry per rule. */
  private async take(): Promise<RuleHits[]> {
    const flat = (await this.redis.cache.eval(TAKE, 1, this.keys.ipRuleHits())) as string[];
    const counts = new Map<number, { count: number; lastHitAtMs: number }>();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const field = flat[i] ?? '';
      const value = Number(flat[i + 1]);
      if (!Number.isFinite(value)) continue;
      const isTime = field.endsWith(':at');
      const ruleId = Number(isTime ? field.slice(0, -3) : field);
      if (!Number.isSafeInteger(ruleId)) continue;
      const entry = counts.get(ruleId) ?? { count: 0, lastHitAtMs: 0 };
      if (isTime) entry.lastHitAtMs = value;
      else entry.count = value;
      counts.set(ruleId, entry);
    }
    return [...counts]
      .filter(([, entry]) => entry.count > 0)
      .map(([ruleId, entry]) => ({ ruleId, count: entry.count, lastHitAtMs: entry.lastHitAtMs || Date.now() }));
  }

  private async giveBack(entries: readonly RuleHits[]): Promise<void> {
    try {
      await this.redis.cache.eval(
        GIVE_BACK,
        1,
        this.keys.ipRuleHits(),
        String(HITS_TTL_MS),
        ...entries.flatMap((entry) => [String(entry.ruleId), String(entry.count), String(entry.lastHitAtMs)]),
      );
    } catch (error) {
      this.logger.error(
        `IP rule hits could not be put back after a failed flush; ${entries.length} rules lose their last minute: ${String(error)}`,
      );
    }
  }
}
