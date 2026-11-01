// The replay filter of incoming webhooks (decisions 018, 019): the events accepted in the last minutes, in the cache Redis.
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { LogThrottle } from '../../../../../common/log-throttle';
import { CacheKeys } from '../../../../../infra/cache';
import { RedisService } from '../../../../../infra/redis';

/**
 * How long an accepted event id is remembered.
 *
 * Why: a delivery is accepted when its signed time is within 5 minutes of now, so a copy of it can be replayed for up to
 * 5 minutes after it is first seen plus the 5 minutes it may be ahead of the clock; 15 minutes covers that with a margin.
 */
export const WEBHOOK_EVENT_TTL_MS = 15 * 60 * 1000;
const WARN_INTERVAL_MS = 30_000;

/** The answer of {@link WebhookEventLedger.claim}. */
export type EventClaim = 'new' | 'duplicate' | 'unavailable';

/**
 * Remembers which gateway events were accepted.
 *
 * Why: decision 019 de-duplicates incoming webhooks by the gateway's event id. A gateway sends the same event again when our
 * answer was slow or failed, and an attacker can replay a captured request inside the time window; either way the handler
 * should do the work once. This is a cheap first filter only: the payment row (unique gateway event id in Postgres) is the
 * idempotency that decisions 022 and 024 rely on, because the cache is never a source of truth. With the cache Redis down
 * `claim` answers `unavailable` and the delivery is treated as new.
 *
 * Side effects: `SET key NX PX` / `UNLINK` on the cache Redis (`gsm:{env}:identity:webhook-event:{gateway}:{hash}`).
 *
 * @see docs/cache-keys.md
 */
@Injectable()
export class WebhookEventLedger {
  private readonly logger = new Logger(WebhookEventLedger.name);
  private readonly throttle = new LogThrottle(WARN_INTERVAL_MS);

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
  ) {}

  /**
   * Marks an event as accepted, unless it already was.
   *
   * @param gateway the gateway slug
   * @param eventId the gateway's event id
   * @returns `new` for the first delivery in the window, `duplicate` for a repeat, `unavailable` when Redis could not say
   */
  async claim(gateway: string, eventId: string): Promise<EventClaim> {
    try {
      const marked = await this.redis.cache.set(this.keyOf(gateway, eventId), '1', 'PX', WEBHOOK_EVENT_TTL_MS, 'NX');
      return marked === 'OK' ? 'new' : 'duplicate';
    } catch (error) {
      if (this.throttle.attempt('claim')) {
        this.logger.warn(`Webhook replay filter unavailable (cache Redis): ${String(error)}`);
      }
      return 'unavailable';
    }
  }

  /**
   * Forgets an event, so that the gateway's retry is treated as new.
   *
   * Why: a delivery that ended in a `5xx` was not processed; the retry must not be taken for a repeat of finished work.
   *
   * @param gateway the gateway slug
   * @param eventId the gateway's event id
   * @returns resolves when done; never throws (the mark expires by itself)
   */
  async release(gateway: string, eventId: string): Promise<void> {
    try {
      await this.redis.cache.unlink(this.keyOf(gateway, eventId));
    } catch (error) {
      if (this.throttle.attempt('release')) {
        this.logger.warn(`Webhook event mark not released (cache Redis); it expires by itself: ${String(error)}`);
      }
    }
  }

  private keyOf(gateway: string, eventId: string) {
    return this.keys.webhookEvent(gateway, createHash('sha256').update(eventId).digest('hex'));
  }
}
