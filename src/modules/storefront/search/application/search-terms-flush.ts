// SearchTermsFlush: the `search_terms_flush` and `search_terms_purge` jobs (feature 29, plan section 5.6): copies the day's search
// counters from the cache Redis into `search_terms_daily` as absolute values, and deletes rows older than 180 days.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { CacheKeys } from '../../../../infra/cache';
import { DbService } from '../../../../infra/db';
import { RedisService } from '../../../../infra/redis';
import { dayKey, dayOf, termId } from '../domain/terms';
import { type TermsDayRow, purgeTermsDays, upsertTermsDays } from '../infra/search-tables.repository';

/** How long the daily figures are kept (plan section 5.6, owner question 8). */
export const TERMS_RETENTION_DAYS = 180;
const DAY_MS = 86_400_000;
const PFCOUNT_SLICE = 500;

/** What one flush wrote. */
export interface TermsFlushReport {
  /** The days read (today and yesterday, `yyyy-mm-dd`). */
  readonly days: readonly string[];
  /** Rows written. */
  readonly terms: number;
}

/**
 * Moves the search counters into Postgres.
 *
 * Why: plan section 5.6: a searched term is counted in Redis (`HINCRBY` of `s:<term>` and `z:<term>`, `PFADD` of a salted visitor
 * hash; slice B2); every 15 minutes this job reads the whole of today and yesterday and SETs the figures in `search_terms_daily`, so a
 * retry or a parallel run writes the same rows (no `RENAME`, the keys expire by TTL). No IP, user or cookie is read or written: the
 * visitor figure is the `PFCOUNT` of the term's day.
 *
 * Side effects: `HGETALL` and `PFCOUNT` on the cache Redis; upserts and deletes in `search_terms_daily`.
 */
@Injectable()
export class SearchTermsFlush {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Flushes today and yesterday.
   *
   * @returns the days read and the rows written
   * @throws {Error} when the cache Redis or Postgres fails (retried by the queue)
   */
  async flush(): Promise<TermsFlushReport> {
    const now = this.clock.nowMs();
    const moments = [new Date(now - DAY_MS), new Date(now)];
    let written = 0;
    for (const at of moments) {
      const rows = await this.readDay(at);
      written += await upsertTermsDays(this.db.db, rows, this.clock.now());
    }
    return { days: moments.map(dayOf), terms: written };
  }

  /**
   * Deletes the figures older than {@link TERMS_RETENTION_DAYS} days.
   *
   * @returns how many rows were deleted
   */
  async purge(): Promise<number> {
    const firstKept = dayOf(new Date(this.clock.nowMs() - TERMS_RETENTION_DAYS * DAY_MS));
    return purgeTermsDays(this.db.db, firstKept);
  }

  private async readDay(at: Date): Promise<TermsDayRow[]> {
    const day = dayKey(at);
    const fields = await this.redis.cache.hgetall(this.keys.searchTermsDay(day));
    const counts = new Map<string, { searches: number; zeroResults: number }>();
    for (const [field, value] of Object.entries(fields)) {
      const kind = field.slice(0, 2);
      const term = field.slice(2);
      if ((kind !== 's:' && kind !== 'z:') || term === '' || term.length > 64) continue;
      const entry = counts.get(term) ?? { searches: 0, zeroResults: 0 };
      const number = Math.max(0, Math.floor(Number(value) || 0));
      if (kind === 's:') entry.searches = number;
      else entry.zeroResults = number;
      counts.set(term, entry);
    }
    const terms = [...counts.keys()].filter((term) => (counts.get(term)?.searches ?? 0) > 0);
    const visitors = new Map<string, number>();
    for (let start = 0; start < terms.length; start += PFCOUNT_SLICE) {
      const slice = terms.slice(start, start + PFCOUNT_SLICE);
      const pipeline = this.redis.cache.pipeline();
      for (const term of slice) pipeline.pfcount(this.keys.searchVisitors(day, termId(term)));
      const answers = (await pipeline.exec()) ?? [];
      slice.forEach((term, index) => {
        const [error, count] = answers[index] ?? [null, 0];
        visitors.set(term, error ? 0 : Number(count) || 0);
      });
    }
    return terms.map((term) => ({
      day: dayOf(at),
      term,
      searches: counts.get(term)!.searches,
      zeroResults: counts.get(term)!.zeroResults,
      visitors: visitors.get(term) ?? 0,
    }));
  }
}
