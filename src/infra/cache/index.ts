// Public API of the cache infrastructure (decisions 022 and 055): the module, the service, the key builders and the sealed entry format.
export { CacheModule } from './cache.module';
export { CacheService } from './cache.service';
export type { GetOrLoadOptions } from './cache.service';
export { CACHE_KEY_FAMILIES, CacheKeys, familyOf } from './cache-keys';
export type { CacheKey, CacheKeyFamily, CachePrefix } from './cache-keys';
export {
  CACHE_ENTRY_VERSION,
  CACHE_MAC_LABEL,
  CacheValueTooLargeError,
  MAX_CACHED_VALUE_BYTES,
  TTL_JITTER_RATIO,
  cacheMacKey,
  jitterTtlMs,
  openEntry,
  sealEntry,
} from './cache-entry';
export type { CacheEntry, OpenedEntry } from './cache-entry';
export { INVALIDATION_RETRY_DELAYS_MS, withRetries } from './cache-invalidation';
export type { RetryOutcome } from './cache-invalidation';
