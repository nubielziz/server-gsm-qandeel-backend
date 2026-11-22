// ApiKeyDirectory: finds a merchant API key by the key a caller presents, through the cache (decisions 018, 019, 022, 055), records its
// use at most once a minute, and drops the cached view when the key or its merchant changes.
import { Injectable, Logger } from '@nestjs/common';
import { LogThrottle } from '../../../../../common/log-throttle';
import { CacheKeys, CacheService } from '../../../../../infra/cache';
import { TokenService } from '../../../../../infra/crypto';
import { DbService, type TransactionContext } from '../../../../../infra/db';
import { findApiKeyByHash, liveKeyHashesOf, touchApiKey } from './api-key.repository';
import type { ApiKeyView } from './api-key.rules';

/** How long a key lookup stays in the cache (like a session lookup, decision 018). */
export const API_KEY_CACHE_TTL_SECONDS = 60;
/** How long "no such key" stays cached, so a flood of invented keys does not reach Postgres. */
export const UNKNOWN_API_KEY_TTL_SECONDS = 10;
/** `last_used_at` is written at most this often. */
export const API_KEY_TOUCH_INTERVAL_MS = 60_000;

/**
 * Printable ASCII without spaces, 16 to 256 characters.
 *
 * Why: it only bounds the work a malformed credential can cause (hashing, a cache key). Real keys are long random strings;
 * their exact format belongs to the feature that issues them.
 */
const KEY_SHAPE = /^[\x21-\x7e]{16,256}$/;

/**
 * Looks merchant API keys up.
 *
 * Why: REST v1 and Dhru authenticate every request with a key (decision 018), so the lookup must not cost a query each time. The
 * cached view also carries the merchant's status; the features that change a key or a merchant call `invalidate` /
 * `invalidateClient` after their commit, so a revoke or a suspension applies on the next request. A cached view is used only when it
 * belongs to the presented key (decision 055).
 *
 * Side effects: reads `api_keys` and `clients`; reads and deletes `gsm:{env}:identity:api-key:{keyHash}` (an invalidation is retried
 * and reported when Redis fails, decision 055); writes `api_keys.last_used_at` / `last_used_ip`.
 *
 * @see docs/cache-keys.md
 */
@Injectable()
export class ApiKeyDirectory {
  private readonly logger = new Logger(ApiKeyDirectory.name);
  private readonly throttle = new LogThrottle(60_000);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Hashes a presented key the way it is stored.
   *
   * @param key the key a caller sent
   * @returns the keyed hash (decision 019), or `undefined` when the text cannot be one of our keys
   */
  hashOf(key: string): string | undefined {
    return KEY_SHAPE.test(key) ? this.tokens.hash(key) : undefined;
  }

  /**
   * Finds the key a caller presented.
   *
   * Why: the view is used only when it belongs to the presented key (decision 055): a cached view whose key hash is another one is
   * refused and deleted.
   *
   * Side effects: on a view that does not belong to the key, deletes its cache key (best effort) and logs one warning a minute.
   *
   * @param key the key as sent (`Authorization: Bearer ...` or Dhru `apiaccesskey`)
   * @returns the view, or `undefined` for an unknown key, text that cannot be a key, or a cached view of another key. Revoked and
   *   expired keys are returned: judge them with `checkApiKey`. The view can be up to a minute old.
   */
  async findByKey(key: string): Promise<ApiKeyView | undefined> {
    const hash = this.hashOf(key);
    if (hash === undefined) return undefined;
    const cacheKey = this.keys.apiKey(hash);
    const view = await this.cache.getOrLoad(
      cacheKey,
      API_KEY_CACHE_TTL_SECONDS,
      () => findApiKeyByHash(this.db.db, hash),
      { negativeTtlSeconds: UNKNOWN_API_KEY_TTL_SECONDS },
    );
    // A cached "nothing" comes back as null.
    if (!view) return undefined;
    if (!this.tokens.equals(view.keyHash, hash)) {
      if (this.throttle.attempt('binding')) {
        this.logger.warn('A cached API key view did not belong to the key it was stored for; it was ignored.');
      }
      await this.cache.del(cacheKey).catch(() => undefined);
      return undefined;
    }
    return view;
  }

  /**
   * Records that a key was used, at most once a minute.
   *
   * Why: the console lists "last used" and the address per key (`GET /admin/clients/:id/api-keys`).
   *
   * Side effects: updates `api_keys.last_used_at` / `last_used_ip` and deletes the cached view so the next lookup sees the new
   * time (otherwise the view would repeat the write on every request until it expires).
   *
   * @param view the key as the guard saw it
   * @param ip the client address, printed
   * @param nowMs the current time in milliseconds (the injected clock's, decision 031)
   * @returns true when this call wrote the row
   */
  async touch(view: ApiKeyView, ip: string, nowMs: number): Promise<boolean> {
    if (view.lastUsedAtMs !== null && nowMs - view.lastUsedAtMs < API_KEY_TOUCH_INTERVAL_MS) return false;
    const written = await touchApiKey(this.db.db, view.id, new Date(nowMs), ip, API_KEY_TOUCH_INTERVAL_MS);
    await this.cache.del(this.keys.apiKey(view.keyHash));
    return written;
  }

  /**
   * Forgets the cached views of keys.
   *
   * Why: revoking a key, changing its scopes or allowed IPs must apply at once, not after the minute the view lives
   * (`DELETE /admin/api-keys/:id`: "effective at once").
   *
   * Side effects: deletes the cache keys (after the commit when `work` is given). Never throws: a failed delete is retried and
   * reported (decision 055).
   *
   * @param keyHashes the `api_keys.key_hash` values of the keys that changed
   * @param work the caller's transaction context, if it has one
   */
  async invalidate(keyHashes: readonly string[], work?: Pick<TransactionContext, 'afterCommit'>): Promise<void> {
    if (keyHashes.length === 0) return;
    const forget = async (): Promise<void> => {
      await this.cache.invalidate(...keyHashes.map((hash) => this.keys.apiKey(hash)));
    };
    if (work) work.afterCommit(forget);
    else await forget();
  }

  /**
   * Forgets the cached views of every key of a merchant.
   *
   * Why: the view holds the merchant's status, so suspending, reactivating or approving a merchant must clear it, or the old
   * status would be served for up to a minute.
   *
   * Side effects: reads the merchant's key hashes, then deletes their cache keys (after the commit when `work` is given). Never throws
   * for Redis: a failed delete is retried and reported (decision 055).
   *
   * @param clientId the merchant id
   * @param work the caller's transaction context, if it has one
   */
  async invalidateClient(clientId: number, work?: Pick<TransactionContext, 'afterCommit' | 'tx'>): Promise<void> {
    const hashes = await liveKeyHashesOf(work?.tx ?? this.db.db, clientId);
    await this.invalidate(hashes, work);
  }
}
