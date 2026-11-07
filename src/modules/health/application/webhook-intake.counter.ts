// The hourly counters of incoming gateway callbacks (B97): the billing feature's callback handler calls `record` for each callback
// it receives; `GET /admin/system/webhooks` sums the last 24 hours. Counters live in the cache Redis (48 h), so the figures do not
// depend on Prometheus.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { CacheKeys } from '../../../infra/cache';
import { RedisService } from '../../../infra/redis';

/** How long an hourly counter is kept. */
export const INTAKE_TTL_SECONDS = 48 * 3_600;

/** What happened to a callback: accepted (2xx), refused (non-2xx, signature failures included) or queued for reprocessing. */
export type IntakeOutcome = 'delivered' | 'failed' | 'retrying';

/**
 * Counts incoming webhook callbacks by outcome.
 *
 * Why: nothing else records incoming callbacks by outcome (B97). Best effort: a Redis failure is swallowed, because a counter must
 * never make a payment callback fail.
 *
 * Side effects: `HINCRBY` on the hour's hash in the cache Redis and a 48 h expiry.
 */
@Injectable()
export class WebhookIntakeCounter {
  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Counts one callback.
   *
   * @param outcome what happened to it
   * @returns resolves when counted (never rejects)
   */
  async record(outcome: IntakeOutcome): Promise<void> {
    const key = this.keys.webhookIntake(this.clock.now().toISOString().slice(0, 13).replace(/\D/g, ''));
    try {
      await this.redis.cache.multi().hincrby(key, outcome, 1).expire(key, INTAKE_TTL_SECONDS).exec();
    } catch {
      // Best effort by design.
    }
  }
}
