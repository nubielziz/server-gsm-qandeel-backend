// BroadcastBudget: the system-wide per-channel rate of campaign messages (feature 23, plan section 8.2, O8): one point per message from
// the `broadcast-email` limiter, its size read from the settings; a refused take waits and tries again.
import { Inject, Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';
import { TIMERS, type Timers } from '../../../../common/clock';
import { MetricsService } from '../../../../infra/metrics';
import { RateLimitService } from '../../../../infra/rate-limit';
import { SettingsReader } from '../../settings/settings-reader';
import { BROADCAST_EMAIL_PER_SECOND_KEY, BROADCAST_RATE_BOUNDS } from '../../settings/settings-registry';
import { DeliveryError } from '../delivery-error';

/** How often a take waits for the budget before the job gives up and lets the queue retry it. */
export const MAX_BUDGET_WAITS = 30;

const LIMITS = {
  email: { limiter: 'broadcast-email', key: BROADCAST_EMAIL_PER_SECOND_KEY, fallback: 5 },
} as const;

/**
 * Hands out the send budget of campaign messages.
 *
 * Why: the bulk queue's limiter (30 jobs a second) protects Redis and the worker; the providers' own limits are per channel and
 * lower (an SMTP account may take 5 a second). The budget is shared by every worker through the cache Redis (decision 021); while
 * it is used up the job waits with the injected timers (decision 031) instead of failing, so nothing is dropped.
 *
 * Side effects: counter keys of the limiter on the cache Redis; `notification_broadcast_waits_total{channel}`.
 */
@Injectable()
export class BroadcastBudget {
  private readonly waits: Counter<'channel'>;

  constructor(
    private readonly limits: RateLimitService,
    private readonly settings: SettingsReader,
    @Inject(TIMERS) private readonly timers: Timers,
    metrics: MetricsService,
  ) {
    this.waits = new Counter({
      name: 'notification_broadcast_waits_total',
      help: 'Waits of campaign messages for their per-channel budget, by channel.',
      labelNames: ['channel'],
      registers: [metrics.registry],
    });
  }

  /**
   * Takes one message from a channel's budget, waiting while it is used up.
   *
   * @param channel `email`
   * @throws {DeliveryError} a transient one after {@link MAX_BUDGET_WAITS} refused tries (the queue retries the job later)
   */
  async take(channel: 'email'): Promise<void> {
    const spec = LIMITS[channel];
    const limit = await this.settings.integer(spec.key, spec.fallback, BROADCAST_RATE_BOUNDS);
    for (let attempt = 0; attempt < MAX_BUDGET_WAITS; attempt += 1) {
      const decision = await this.limits.consume(spec.limiter, 'all', 1, { limit });
      if (decision.allowed) return;
      this.waits.inc({ channel });
      await this.wait(decision.retryAfterSeconds * 1000);
    }
    throw new DeliveryError(`The ${channel} budget of campaigns stayed used up; the message is retried later.`, {
      permanent: false,
    });
  }

  /**
   * Waits with the injected timers.
   *
   * @param ms how long
   * @returns a promise that resolves once the time has passed
   */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }
}
