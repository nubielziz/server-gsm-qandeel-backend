// The cached maintenance state (platform module): read from settings key `maintenance` with a documented default, kept in the
// cache Redis and in memory for a moment, invalidated by the route that changes it.
import { Injectable, Logger } from '@nestjs/common';
import { LogThrottle } from '../../../common/log-throttle';
import { ShortMemo } from '../../../common/short-memo';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { SettingsService } from '../settings/settings.service';
import { MAINTENANCE_KEY, MAINTENANCE_OFF, type MaintenanceState, parseMaintenanceState } from './maintenance-state';

/** Seconds the cache Redis keeps the state fresh: also how long a missed invalidation can last. */
const CACHE_TTL_SECONDS = 60;
/** Seconds the old state is still served while one refresh runs (or while the database is away). */
const STALE_SECONDS = 300;
/** Milliseconds a process keeps the state in memory, so the hook asks neither Redis nor Postgres on every request. */
const LOCAL_TTL_MS = 1_000;
const WARN_INTERVAL_MS = 30_000;

/**
 * Tells the request pipeline whether maintenance is on.
 *
 * Why: the maintenance hook runs on every request, so the state comes from memory (1 s), then the cache Redis (60 s),
 * then settings. When the setting was never set, maintenance is off (documented default). The route that switches
 * maintenance (system health feature) calls {@link MaintenanceService.invalidate} after its commit, so the change reaches
 * every API instance within about a second. If neither Redis nor Postgres can answer, the last known state is used.
 *
 * Side effects: reads settings key `maintenance`; cache key `CacheKeys.maintenance()`; logs a warning (at most every 30 s)
 * for a stored value that is not a well-formed state, which counts as off.
 *
 * @see docs/contract/endpoints/health.md (`PUT /admin/system/maintenance`)
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);
  private readonly throttle = new LogThrottle(WARN_INTERVAL_MS);
  private readonly memo = new ShortMemo<MaintenanceState>({
    ttlMs: LOCAL_TTL_MS,
    onStale: (error) =>
      this.warn('stale', `Maintenance state could not be reloaded, using the last known one: ${String(error)}`),
  });

  constructor(
    private readonly settings: SettingsService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
  ) {}

  /**
   * The current maintenance state.
   *
   * @returns the state; "off" when the setting was never set or is malformed
   * @throws {Error} when no copy exists anywhere (cold start) and Postgres cannot answer; the hook lets the request go on
   */
  state(): Promise<MaintenanceState> {
    return this.memo.get(() =>
      this.cache.getOrLoad(this.keys.maintenance(), CACHE_TTL_SECONDS, () => this.load(), {
        staleWhileRevalidate: STALE_SECONDS,
      }),
    );
  }

  /**
   * Forgets the cached state so the next request reads the setting again.
   *
   * Why: call it from the route that changes maintenance, after the commit: `afterCommit(() => maintenance.invalidate())`
   * (decision 022).
   *
   * Side effects: clears the in-memory copy of this process and deletes `CacheKeys.maintenance()`.
   *
   * @returns resolves when the cache key is gone
   * @throws {Error} when Redis fails; the in-memory copy is cleared anyway and the old cache entry expires within a minute
   */
  async invalidate(): Promise<void> {
    this.memo.clear();
    await this.cache.del(this.keys.maintenance());
  }

  private async load(): Promise<MaintenanceState> {
    const stored = await this.settings.get(MAINTENANCE_KEY);
    if (stored === undefined || stored === null) return MAINTENANCE_OFF;
    const state = parseMaintenanceState(stored);
    if (!state) {
      this.warn(
        'malformed',
        `Settings key "${MAINTENANCE_KEY}" is not a well-formed maintenance state; treating maintenance as off`,
      );
      return MAINTENANCE_OFF;
    }
    return state;
  }

  private warn(key: string, message: string): void {
    if (this.throttle.attempt(key)) this.logger.warn(message);
  }
}
