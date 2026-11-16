// SearchTermsCounter: counts what visitors search for, without keeping anything personal (feature 29, plan section 5.6). A search is
// counted per UTC day in the cache Redis (a hash of `s:<term>` and `z:<term>` and a HyperLogLog of salted visitor hashes per term); the
// `search_terms_flush` job copies the day into Postgres. No IP, user, session or cookie is stored or sent anywhere.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { CacheKeys } from '../../../../infra/cache';
import { RedisService } from '../../../../infra/redis';
import { SearchMetrics } from '../../../../infra/search';
import { imeiIntent } from '../domain/imei-intent';
import { normaliseQuery } from '../domain/normalise';
import { isBotUserAgent, isRecordableTerm } from '../domain/recordable-term';
import { dayKey } from '../domain/terms';

/** The most distinct fields (`s:` and `z:` together) one day's hash may hold (plan section 5.6). */
export const MAX_DAY_FIELDS = 20_000;
const THREE_DAYS_SECONDS = 3 * 86_400;
const TWO_DAYS_SECONDS = 2 * 86_400;

/** What the counter needs to know about one answered search. */
export interface SearchObservation {
  /** What the visitor typed. */
  readonly text: string;
  /** How many services matched. */
  readonly total: number;
  /** The request was page 1. */
  readonly firstPage: boolean;
  /** The request carried a filter besides the query (a filter click, a price bound). */
  readonly filtered: boolean;
  /** The client address: used only to make the day's salted visitor hash, never stored. */
  readonly ip: string;
  readonly userAgent: string | undefined;
  /** The request is a prefetch (Next.js, the browser). */
  readonly prefetch: boolean;
}

/**
 * Counts searches.
 *
 * Why: the console's report (no-result terms, top terms) and the popular searches need to know what visitors look for, but a typed text
 * can hold an IMEI, a phone number or an email address: those are never counted (`isRecordableTerm`), nor are filter clicks, paging,
 * prefetches, bots and IMEIs. Distinct visitors are estimated with a HyperLogLog over `HMAC-SHA256(daily salt, IP)` (the salt is random
 * per UTC day, so yesterday's hashes cannot be linked to today's), never the address. A day's hash holds at most 20 000 fields; junk can
 * fill it, which costs only statistics (`search_terms_dropped_total`).
 *
 * Side effects: cache Redis (`search-terms:{day}`, `search-visitors:{day}:{sha1(term)}`, `search-visitor-salt:{day}`, all expiring);
 * never throws: a lost counter is a lost statistic.
 */
@Injectable()
export class SearchTermsCounter {
  private readonly logger = new Logger(SearchTermsCounter.name);
  private lastWarning = 0;

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    private readonly metrics: SearchMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Counts one answered search when the rules allow it.
   *
   * @param observation the text, the result count and what kind of request it was
   * @returns true when the search was counted
   */
  async recordSearch(observation: SearchObservation): Promise<boolean> {
    if (!observation.firstPage || observation.filtered || observation.prefetch) return false;
    if (isBotUserAgent(observation.userAgent) || imeiIntent(observation.text) !== null) return false;
    const term = normaliseQuery(observation.text);
    if (!isRecordableTerm(term)) return false;
    try {
      return await this.count(term, observation.total === 0, observation.ip);
    } catch (error) {
      // Statistics only: log one line a minute and carry on.
      const now = this.clock.nowMs();
      if (now - this.lastWarning > 60_000) {
        this.lastWarning = now;
        this.logger.warn(`A search count was lost: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
  }

  private async count(term: string, zero: boolean, ip: string): Promise<boolean> {
    const redis = this.redis.cache;
    const day = dayKey(this.clock.now());
    const counts = this.keys.searchTermsDay(day);
    const field = `s:${term}`;
    const [length, known] = (await redis.pipeline().hlen(counts).hexists(counts, field).exec()) ?? [];
    if (!known?.[1] && Number(length?.[1] ?? 0) >= MAX_DAY_FIELDS) {
      this.metrics.termsDropped.inc();
      return false;
    }
    const salt = await this.saltOf(day);
    const visitor = createHmac('sha256', salt).update(ip).digest('hex').slice(0, 16);
    const visitors = this.keys.searchVisitors(day, createHash('sha1').update(term).digest('hex'));
    const pipeline = redis.pipeline().hincrby(counts, field, 1);
    if (zero) pipeline.hincrby(counts, `z:${term}`, 1);
    pipeline.expire(counts, THREE_DAYS_SECONDS).pfadd(visitors, visitor).expire(visitors, THREE_DAYS_SECONDS);
    await pipeline.exec();
    return true;
  }

  /** The day's random salt: created once (`SET NX`, 48 hours), read by every process. */
  private async saltOf(day: string): Promise<string> {
    const redis = this.redis.cache;
    const key = this.keys.searchVisitorSalt(day);
    await redis.set(key, randomBytes(32).toString('hex'), 'EX', TWO_DAYS_SECONDS, 'NX');
    const salt = await redis.get(key);
    if (salt === null) throw new Error('The visitor salt vanished.');
    return salt;
  }
}
