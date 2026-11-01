// The cached set of active IP rules (identity module, scenario ip-rules step 4): loaded from Postgres into the cache Redis,
// kept in memory for a moment, invalidated by whatever changes a rule or the access restriction.
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { LogThrottle } from '../../../../common/log-throttle';
import { ShortMemo } from '../../../../common/short-memo';
import { CacheKeys, CacheService } from '../../../../infra/cache';
import { DbService } from '../../../../infra/db';
import { SettingsService } from '../../../platform';
import { type CompiledIpRules, type IpRuleSnapshot, compileIpRules } from './ip-rule-matcher';
import { loadLiveIpRules } from './ip-rule.repository';

/**
 * The settings key of the switch that restricts the admin console to the allowlist.
 *
 * Why: `PUT /admin/access/restriction` stores it (ALIGNMENT § 9: read back by `GET /admin/settings`); the demo seed sets it.
 */
export const ADMIN_ALLOWLIST_KEY = 'adminAllowlistOnly';

/** Seconds the cache Redis keeps the snapshot fresh: also how long a missed invalidation can last. */
const CACHE_TTL_SECONDS = 60;
/** Seconds the old snapshot is still served while one refresh runs (or while the database is away). */
const STALE_SECONDS = 300;
/** How long other instances wait for the one that is loading the snapshot. */
const LOCK_MS = 2_000;
/** Milliseconds a process keeps the compiled rules in memory: no Redis or Postgres call on most requests. */
const LOCAL_TTL_MS = 1_000;
const WARN_INTERVAL_MS = 30_000;

/**
 * Gives the request pipeline the active IP rules, ready to match.
 *
 * Why: every request except the probes is judged by the IP rules before anything else (decision 018), so the rules must
 * not cost a query. The snapshot (live rules and `adminAllowlistOnly`) lives in the cache Redis (60 s, stale-while-
 * revalidate), is parsed once per snapshot, and is kept in memory for a second. If Redis is down the loader reads Postgres
 * (at most once a second per process); if Postgres is down too, the last snapshot keeps being used.
 *
 * The routes that change a rule or the restriction (feature 2a) call {@link IpRuleCache.invalidate} after their commit:
 * `afterCommit(() => ipRules.invalidate())`. Other instances see the change within a second.
 *
 * Side effects: reads `ip_rules` and the settings key `adminAllowlistOnly`; cache key `CacheKeys.ipRules()`.
 *
 * @see docs/cache-keys.md
 */
@Injectable()
export class IpRuleCache {
  private readonly logger = new Logger(IpRuleCache.name);
  private readonly throttle = new LogThrottle(WARN_INTERVAL_MS);
  private readonly memo = new ShortMemo<CompiledIpRules>({
    ttlMs: LOCAL_TTL_MS,
    onStale: (error) => {
      if (this.throttle.attempt('stale')) {
        this.logger.warn(`IP rules could not be reloaded, using the last known set: ${String(error)}`);
      }
    },
  });
  private compiled: CompiledIpRules | undefined;

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
  ) {}

  /**
   * The rules to match against.
   *
   * @returns the compiled rules and the restriction switch
   * @throws {Error} when no copy exists anywhere (cold start, after an invalidation) and Postgres cannot answer
   */
  get(): Promise<CompiledIpRules> {
    return this.memo.get(async () => {
      const snapshot = await this.cache.getOrLoad(this.keys.ipRules(), CACHE_TTL_SECONDS, () => this.load(), {
        lockMs: LOCK_MS,
        staleWhileRevalidate: STALE_SECONDS,
      });
      return this.compile(snapshot);
    });
  }

  /**
   * Forgets the cached rules so the next request reads them again.
   *
   * Why: call it after the commit of any change to `ip_rules` or to `adminAllowlistOnly` (decision 022).
   *
   * Side effects: clears the in-memory copy of this process and deletes `CacheKeys.ipRules()`.
   *
   * @returns resolves when the cache key is gone
   * @throws {Error} when Redis fails; the in-memory copy is cleared anyway and the old entry expires within a minute
   */
  async invalidate(): Promise<void> {
    this.memo.clear();
    try {
      await this.cache.del(this.keys.ipRules());
    } finally {
      // Cleared again: a request between the two steps may have re-read the old Redis copy into memory.
      this.memo.clear();
    }
  }

  private async load(): Promise<IpRuleSnapshot> {
    const [rules, restricted] = await Promise.all([
      loadLiveIpRules(this.db.db),
      this.settings.get(ADMIN_ALLOWLIST_KEY),
    ]);
    return { version: randomUUID(), restricted: restricted === true, rules };
  }

  /** Parses the networks once per snapshot version. */
  private compile(snapshot: IpRuleSnapshot): CompiledIpRules {
    if (this.compiled?.version === snapshot.version) return this.compiled;
    this.compiled = compileIpRules(snapshot);
    return this.compiled;
  }
}
