// SearchLocks: the cache-Redis locks of the search's long runs (feature 29, plan section 4.5): one lock for the reconcile and the
// rebuild of the services index, one for the terms build. `SET NX PX`, renewed every minute, released by its holder only.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TIMERS, type Timers } from '../../../../common/clock';
import { type CacheKey, CacheKeys } from '../../../../infra/cache';
import { RedisService } from '../../../../infra/redis';

/** How long a lock lives without renewal (30 minutes). */
export const SEARCH_LOCK_TTL_MS = 1_800_000;
/** How often its holder renews it (every minute). */
export const SEARCH_LOCK_RENEW_MS = 60_000;

/** Which lock. */
export type SearchLockName = 'index' | 'terms';

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** A held lock. */
export interface SearchLock {
  /** Releases the lock if this holder still has it (a token compare); never throws. */
  release(): Promise<void>;
}

/**
 * Takes the search locks.
 *
 * Why: plan section 4.5: a reconcile and a rebuild must never run at once (the rebuild's post-swap reconcile turns the changes made
 * during the build into sync jobs), and two terms builds must not race on the alias; a run that finds its lock held records
 * `skipped`. The lock is renewed every minute, so a long rebuild keeps it, and a crashed holder's lock expires after 30 minutes. Locks
 * live on the cache Redis (decision 006: locks are a cache-role use).
 *
 * Side effects: `SET NX PX` and Lua compare-and-renew / compare-and-delete on `gsm:{env}:storefront:search-index:lock` and
 * `gsm:{env}:storefront:search-terms:lock`; one timer per held lock.
 */
@Injectable()
export class SearchLocks {
  private readonly logger = new Logger(SearchLocks.name);

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    @Inject(TIMERS) private readonly timers: Timers,
  ) {}

  /**
   * Tries to take a lock.
   *
   * @param name `index` (reconcile and rebuild) or `terms` (terms build)
   * @returns the held lock, or `null` when another run holds it
   * @throws {Error} when the cache Redis cannot be reached (the job is retried)
   */
  async acquire(name: SearchLockName): Promise<SearchLock | null> {
    const key: CacheKey = name === 'index' ? this.keys.searchIndexLock() : this.keys.searchTermsLock();
    const token = randomUUID();
    const taken = await this.redis.cache.set(key, token, 'PX', SEARCH_LOCK_TTL_MS, 'NX');
    if (taken !== 'OK') return null;
    let released = false;
    let timer: unknown;
    const renew = () => {
      if (released) return;
      this.redis.cache
        .eval(RENEW, 1, key, token, String(SEARCH_LOCK_TTL_MS))
        .catch((error: unknown) =>
          this.logger.warn(
            `Could not renew the search ${name} lock: ${error instanceof Error ? error.message : 'error'}`,
          ),
        )
        .finally(() => {
          if (!released) timer = this.timers.setTimeout(renew, SEARCH_LOCK_RENEW_MS);
        });
    };
    timer = this.timers.setTimeout(renew, SEARCH_LOCK_RENEW_MS);
    return {
      release: async () => {
        released = true;
        this.timers.clearTimeout(timer);
        await this.redis.cache.eval(RELEASE, 1, key, token).catch(() => undefined);
      },
    };
  }
}
