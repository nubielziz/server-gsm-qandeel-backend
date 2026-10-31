// Cache-aside on the cache Redis (decision 022): getOrLoad with TTL jitter, in-process coalescing, a cross-instance lock,
// stale-while-revalidate and negative caching; deletion by key or prefix; version keys for bulk invalidation.
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Counter } from 'prom-client';
import { LogThrottle } from '../../common/log-throttle';
import { sleep, withTimeout } from '../../common/timeout';
import { MetricsService } from '../metrics';
import { RedisService } from '../redis';
import { type CacheEntry, CacheValueTooLargeError, decodeEntry, encodeEntry, jitterTtlMs } from './cache-entry';
import { type CacheKey, CacheKeys, type CachePrefix, familyOf } from './cache-keys';

/**
 * Options of {@link CacheService.getOrLoad}.
 *
 * Why: decision 022 lets hot keys opt into a cross-instance lock, stale-while-revalidate and negative caching; the
 * default is plain cache-aside.
 */
export interface GetOrLoadOptions {
  /**
   * Turns on the cross-instance stampede lock: while one process loads the value, the others wait up to this many
   * milliseconds for its result instead of loading too. Use it for hot keys that are expensive to rebuild.
   */
  readonly lockMs?: number;
  /**
   * Seconds after the TTL during which the old value may still be served while one refresh runs in the background.
   * Use it where a slightly old answer beats a slow one (price lists, settings).
   */
  readonly staleWhileRevalidate?: number;
  /**
   * Caches a `null`/`undefined` result for this many seconds (short, for example 30). Use it for lookups that miss
   * repeatedly (an unknown TAC); without it a missing value is never cached.
   */
  readonly negativeTtlSeconds?: number;
}

/** A load that is running in this process, shared by every caller that asks for the same key meanwhile. */
interface InFlight {
  promise: Promise<unknown>;
  /** Set by `del`: the value being loaded may predate the change, so it must not be written. */
  invalidated: boolean;
}

/** How often a waiting process checks whether the lock holder has stored the value. */
const LOCK_POLL_MS = 25;
/** Largest TTL accepted: a cache entry that lives longer than a month is not a cache entry. */
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_LOCK_MS = 60_000;
/** Cache errors repeat on every call during an outage; one line per operation and interval is logged. */
const ERROR_LOG_INTERVAL_MS = 30_000;
const SCAN_BATCH = 500;

/** Deletes a lock only when it still holds our token (it may have expired and been taken by someone else). */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/**
 * New version = the larger of "current + 1" and the current time in milliseconds. Taking the clock into account means a
 * counter the cache evicted and re-created can never fall back to a number that old entries still carry.
 */
const BUMP_VERSION = `local current = tonumber(redis.call('get', KEYS[1]) or '0')
local nextVersion = math.max(current + 1, tonumber(ARGV[1]))
redis.call('set', KEYS[1], string.format('%.0f', nextVersion))
return string.format('%.0f', nextVersion)`;
/** Creates the counter at the current time when it does not exist (atomic with the read). */
const INIT_VERSION = `local current = redis.call('get', KEYS[1])
if current then return current end
redis.call('set', KEYS[1], ARGV[1])
return ARGV[1]`;

function assertTtl(ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new RangeError(`A cache TTL must be between 0 and ${MAX_TTL_SECONDS} seconds, got ${ttlSeconds}`);
  }
}

function assertOptions(options: GetOrLoadOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new RangeError(`getOrLoad option ${name} must be a positive number, got ${String(value)}`);
    }
  }
  // Redis refuses absurd PX/EX values; a lock is held for at most a minute, a stale window at most the longest TTL.
  if (options.lockMs !== undefined && options.lockMs > MAX_LOCK_MS) {
    throw new RangeError(`getOrLoad option lockMs must be at most ${MAX_LOCK_MS}, got ${options.lockMs}`);
  }
  for (const name of ['staleWhileRevalidate', 'negativeTtlSeconds'] as const) {
    const value = options[name];
    if (value !== undefined && value > MAX_TTL_SECONDS) {
      throw new RangeError(`getOrLoad option ${name} must be at most ${MAX_TTL_SECONDS}, got ${value}`);
    }
  }
}

/**
 * Cache-aside over the cache Redis.
 *
 * Why: decision 022 keeps hot reads (Dhru `imeiservicelist`, price lists, settings, permissions, IP rules) off Postgres
 * without risking stale money decisions: it is never used for balances, ledger rows, holds, payment or order status
 * used for decisions, risk decisions or idempotency results. The cache is an optimisation, so a Redis failure on the
 * read path becomes a miss (the loader runs), never an error for the caller.
 *
 * Side effects: reads and writes keys built by {@link CacheKeys}; counts `cache_hits_total`, `cache_misses_total` and
 * `cache_errors_total` per key family; a background refresh may run after a call returned a stale value.
 *
 * @see docs/decisions/022-caching.md and docs/cache-keys.md
 */
@Injectable()
export class CacheService implements OnApplicationShutdown {
  private readonly logger = new Logger(CacheService.name);
  private readonly throttle = new LogThrottle(ERROR_LOG_INTERVAL_MS);
  private readonly loading = new Map<string, InFlight>();
  private readonly refreshing = new Map<string, InFlight>();
  private readonly background = new Set<Promise<void>>();
  private readonly hits: Counter<'family'>;
  private readonly misses: Counter<'family'>;
  private readonly errors: Counter<'family' | 'operation'>;

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    metrics: MetricsService,
  ) {
    const registers = [metrics.registry];
    this.hits = new Counter({
      name: 'cache_hits_total',
      help: 'Cache reads answered from Redis (fresh, stale or negative entries), by key family.',
      labelNames: ['family'],
      registers,
    });
    this.misses = new Counter({
      name: 'cache_misses_total',
      help: 'Cache reads that had to run the loader, by key family.',
      labelNames: ['family'],
      registers,
    });
    this.errors = new Counter({
      name: 'cache_errors_total',
      help: 'Cache operations that failed (Redis down, unreadable or oversize entry), by key family and operation.',
      labelNames: ['family', 'operation'],
      registers,
    });
  }

  /**
   * Returns the cached value, or loads it, stores it and returns it.
   *
   * Why: decision 022. Concurrent calls for one key in this process share a single load; with `lockMs` the other
   * processes wait for it too. Values must be plain JSON (a Date comes back as a string) and are shared between the
   * callers of one load, so never mutate a returned value. `null`/`undefined` results are never cached unless
   * `negativeTtlSeconds` is set; a negative entry is returned as `null`.
   *
   * Side effects: one Redis read per call; on a miss one write with a TTL of `ttlSeconds` +-15 % (plus the stale window);
   * the lock key while loading. A write that fails or is too large (over 100 KB) is logged and counted, and the value
   * is still returned.
   *
   * @param key the key, from {@link CacheKeys} (or {@link CacheService.versioned})
   * @param ttlSeconds how long the value stays fresh, 0 to 30 days
   * @param loader reads the source of truth; its errors reach every waiting caller and nothing is cached
   * @param options lock, stale-while-revalidate and negative caching
   * @returns the value
   * @throws {RangeError} for a TTL or option that is not a positive number, or a key not built by {@link CacheKeys}
   * @throws whatever the loader throws
   */
  async getOrLoad<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: GetOrLoadOptions = {},
  ): Promise<T> {
    this.assertOwned(key);
    assertTtl(ttlSeconds);
    assertOptions(options);
    const shared = this.loading.get(key);
    if (shared) return shared.promise as Promise<T>;
    const flight: InFlight = { promise: Promise.resolve(), invalidated: false };
    flight.promise = this.readThrough<T>(key, ttlSeconds, loader, options, flight).finally(() => {
      if (this.loading.get(key) === flight) this.loading.delete(key);
    });
    this.loading.set(key, flight);
    return flight.promise as Promise<T>;
  }

  /**
   * Deletes keys.
   *
   * Why: decision 022 invalidates after the commit: `afterCommit(() => cache.del(key))`. A load of the same key that is
   * running in this process is told not to store its (possibly older) value. Across processes the TTL bounds how long
   * a racing writer can leave an old value.
   *
   * Side effects: `UNLINK` on the cache Redis.
   *
   * @param keys the keys to delete
   * @returns how many existed
   * @throws {Error} when Redis fails, so the caller can log or retry: a missed invalidation leaves old data until the TTL
   */
  async del(...keys: CacheKey[]): Promise<number> {
    for (const key of keys) {
      this.assertOwned(key);
      this.invalidate(key);
    }
    if (keys.length === 0) return 0;
    try {
      return await this.redis.cache.unlink(...keys);
    } catch (error) {
      this.failed(familyOf(keys[0] ?? ''), 'del', error);
      throw error;
    }
  }

  /**
   * Deletes every key that starts with a prefix, scanning with `SCAN` (never `KEYS`).
   *
   * Why: a group invalidation that has no version key, for example everything cached for one merchant. Prefer a version
   * key (`bumpVersion`) for large groups: a scan walks the whole keyspace.
   *
   * Side effects: `SCAN` + `UNLINK` in batches of 500 on the cache Redis.
   *
   * @param prefix a prefix from `CacheKeys.prefix`
   * @returns how many keys were deleted
   * @throws {Error} when Redis fails part-way (keys already deleted stay deleted)
   */
  async delByPrefix(prefix: CachePrefix): Promise<number> {
    // `gsm:{env}:{module}:{entity}:{id prefix}`: a bare keyspace or module would delete far too much.
    const rest = prefix.startsWith(this.keys.keyspace) ? prefix.slice(this.keys.keyspace.length) : '';
    if (!/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]*$/.test(rest)) {
      throw new RangeError('A prefix must be built with CacheKeys.prefix (module and entity at least)');
    }
    for (const key of [...this.loading.keys(), ...this.refreshing.keys()]) {
      if (key.startsWith(prefix)) this.invalidate(key);
    }
    try {
      let cursor = '0';
      let removed = 0;
      do {
        const [next, batch] = await this.redis.cache.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', SCAN_BATCH);
        cursor = next;
        if (batch.length > 0) removed += await this.redis.cache.unlink(...batch);
      } while (cursor !== '0');
      return removed;
    } catch (error) {
      this.failed(familyOf(prefix), 'del_prefix', error);
      throw error;
    }
  }

  /**
   * Moves a version counter to a new number, which makes every key built with {@link CacheService.versioned} for that
   * name unreachable at once.
   *
   * Why: decision 022 invalidates large groups (the whole catalog) with one write instead of a scan. Old entries are
   * never read again and expire by their own TTL. Call it after the commit, like `del`.
   *
   * Side effects: writes `CacheKeys.version(name)`.
   *
   * @param name what the version covers, for example `catalog`
   * @returns the new version number
   * @throws {Error} when Redis fails
   */
  async bumpVersion(name: string): Promise<number> {
    const versionKey = this.keys.version(name);
    try {
      return Number(await this.redis.cache.eval(BUMP_VERSION, 1, versionKey, String(Date.now())));
    } catch (error) {
      this.failed(familyOf(versionKey), 'bump_version', error);
      throw error;
    }
  }

  /**
   * Appends the current version to a key: `{key}:v{n}`.
   *
   * Why: a read that goes through a versioned key sees a new key as soon as `bumpVersion` ran. When Redis cannot be read
   * the key gets a one-time suffix instead: it matches nothing, so the caller loads from the source (a miss, never an
   * old value) and this method never throws.
   *
   * @param name the version counter to read, as given to `bumpVersion`
   * @param key the base key
   * @returns the versioned key
   */
  async versioned(name: string, key: CacheKey): Promise<CacheKey> {
    const versionKey = this.keys.version(name);
    try {
      const stored =
        (await this.redis.cache.get(versionKey)) ??
        String(await this.redis.cache.eval(INIT_VERSION, 1, versionKey, String(Date.now())));
      if (!/^\d+$/.test(stored)) throw new Error('version counter is not a number');
      return `${key}:v${stored}` as CacheKey;
    } catch (error) {
      this.failed(familyOf(versionKey), 'version', error);
      return `${key}:v-${randomUUID()}` as CacheKey;
    }
  }

  /** Waits for background refreshes so a closing app does not leave work behind. */
  async onApplicationShutdown(): Promise<void> {
    await withTimeout(Promise.allSettled([...this.background]), 2_000, 'cache background refresh').catch(
      () => undefined,
    );
  }

  private assertOwned(key: string): void {
    if (!key.startsWith(this.keys.keyspace)) throw new RangeError('A cache key must be built with CacheKeys');
  }

  /**
   * Tells loads of this key that run in this process not to store their result, and stops sharing them: a caller
   * that arrives after the invalidation starts a fresh load instead of joining one that may read the old data.
   */
  private invalidate(key: string): void {
    const loading = this.loading.get(key);
    if (loading) {
      loading.invalidated = true;
      this.loading.delete(key);
    }
    const refreshing = this.refreshing.get(key);
    if (refreshing) {
      refreshing.invalidated = true;
      this.refreshing.delete(key);
    }
  }

  private failed(family: string, operation: string, error: unknown): void {
    this.errors.inc({ family, operation });
    const allowed = this.throttle.attempt(`${family}:${operation}`);
    if (!allowed) return;
    const reason = error instanceof Error ? error.message : String(error);
    const more = allowed.suppressed > 0 ? ` (${allowed.suppressed} similar errors not logged)` : '';
    this.logger.warn(`Cache ${operation} failed for ${family}: ${reason}${more}`);
  }

  /** Reads the entry; a Redis error or an unreadable entry counts as a miss. */
  private async lookup(key: CacheKey): Promise<CacheEntry | undefined> {
    let text: string | null;
    try {
      text = await this.redis.cache.get(key);
    } catch (error) {
      this.failed(familyOf(key), 'get', error);
      return undefined;
    }
    if (text === null) return undefined;
    const entry = decodeEntry(text);
    if (!entry) this.failed(familyOf(key), 'decode', new Error('stored entry is not readable; it will be overwritten'));
    return entry;
  }

  private async readThrough<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: GetOrLoadOptions,
    flight: InFlight,
  ): Promise<T> {
    const family = familyOf(key);
    const entry = await this.lookup(key);
    if (entry) {
      if (Date.now() <= entry.freshUntil) {
        this.hits.inc({ family });
        return entry.value as T;
      }
      if (options.staleWhileRevalidate !== undefined) {
        // Stale but inside the window: answer now, refresh once in the background.
        this.hits.inc({ family });
        this.refreshInBackground(key, ttlSeconds, loader, options);
        return entry.value as T;
      }
    }
    this.misses.inc({ family });
    return this.load(key, ttlSeconds, loader, options, flight);
  }

  private async load<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: GetOrLoadOptions,
    flight: InFlight,
  ): Promise<T> {
    if (options.lockMs === undefined) return this.loadAndStore(key, ttlSeconds, loader, options, flight);

    const lockKey = this.keys.lock(key);
    const token = randomUUID();
    const acquired = await this.tryLock(lockKey, token, options.lockMs);
    if (acquired === false) {
      const entry = await this.waitForEntry(key, lockKey, options.lockMs);
      if (entry) return entry.value as T;
      // The holder failed or is slower than lockMs: load it here rather than make the caller fail.
      return this.loadAndStore(key, ttlSeconds, loader, options, flight);
    }
    try {
      if (acquired) {
        // Another process may have stored the value between our miss and our lock.
        const again = await this.lookup(key);
        if (again && Date.now() <= again.freshUntil) return again.value as T;
      }
      return await this.loadAndStore(key, ttlSeconds, loader, options, flight);
    } finally {
      if (acquired) await this.unlock(lockKey, token);
    }
  }

  private async loadAndStore<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: GetOrLoadOptions,
    flight: InFlight,
  ): Promise<T> {
    const value = await loader();
    if (!flight.invalidated) await this.store(key, value, ttlSeconds, options);
    return value;
  }

  /** Writes the entry; failures are counted and logged, never thrown (the caller already has its value). */
  private async store(key: CacheKey, value: unknown, ttlSeconds: number, options: GetOrLoadOptions): Promise<void> {
    const negative = value === null || value === undefined;
    if (negative && options.negativeTtlSeconds === undefined) return;
    const freshMs = jitterTtlMs(negative ? (options.negativeTtlSeconds ?? ttlSeconds) : ttlSeconds);
    const staleMs = negative ? 0 : Math.round((options.staleWhileRevalidate ?? 0) * 1000);
    try {
      const text = encodeEntry(value, Date.now() + freshMs);
      await this.redis.cache.set(key, text, 'PX', freshMs + staleMs);
    } catch (error) {
      const tooLarge = error instanceof CacheValueTooLargeError;
      this.failed(familyOf(key), tooLarge ? 'too_large' : 'set', error);
    }
  }

  /** `true` when the lock is ours, `false` when someone else holds it, `undefined` when Redis could not say. */
  private async tryLock(lockKey: CacheKey, token: string, lockMs: number): Promise<boolean | undefined> {
    try {
      return (await this.redis.cache.set(lockKey, token, 'PX', Math.ceil(lockMs), 'NX')) === 'OK';
    } catch (error) {
      this.failed(familyOf(lockKey), 'lock', error);
      return undefined;
    }
  }

  private async unlock(lockKey: CacheKey, token: string): Promise<void> {
    try {
      await this.redis.cache.eval(RELEASE_LOCK, 1, lockKey, token);
    } catch (error) {
      // The lock expires by itself after lockMs.
      this.failed(familyOf(lockKey), 'unlock', error);
    }
  }

  /** Polls until the lock holder has stored the value, the lock is gone, or lockMs has passed. */
  private async waitForEntry(key: CacheKey, lockKey: CacheKey, lockMs: number): Promise<CacheEntry | undefined> {
    // A monotonic clock: the system clock may be stepped (time sync) while we wait.
    const deadline = performance.now() + lockMs;
    while (performance.now() < deadline) {
      await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - performance.now())));
      const entry = await this.lookup(key);
      if (entry && Date.now() <= entry.freshUntil) return entry;
      try {
        // The holder finished without storing anything (it failed, or the value is not cacheable): stop waiting.
        if ((await this.redis.cache.exists(lockKey)) === 0) return undefined;
      } catch (error) {
        this.failed(familyOf(lockKey), 'lock', error);
        return undefined;
      }
    }
    return undefined;
  }

  private refreshInBackground<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: GetOrLoadOptions,
  ): void {
    if (this.refreshing.has(key)) return;
    const flight: InFlight = { promise: Promise.resolve(), invalidated: false };
    this.refreshing.set(key, flight);
    const task: Promise<void> = this.refresh(key, ttlSeconds, loader, options, flight)
      .catch((error: unknown) => this.failed(familyOf(key), 'refresh', error))
      .finally(() => {
        if (this.refreshing.get(key) === flight) this.refreshing.delete(key);
        this.background.delete(task);
      });
    this.background.add(task);
  }

  private async refresh<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: GetOrLoadOptions,
    flight: InFlight,
  ): Promise<void> {
    const lockKey = this.keys.lock(key);
    const token = randomUUID();
    const acquired = options.lockMs === undefined ? undefined : await this.tryLock(lockKey, token, options.lockMs);
    // Another process holds the lock and is refreshing already.
    if (acquired === false) return;
    try {
      const value = await loader();
      if (!flight.invalidated) await this.store(key, value, ttlSeconds, options);
    } finally {
      if (acquired) await this.unlock(lockKey, token);
    }
  }
}
