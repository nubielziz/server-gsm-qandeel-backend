// Public API of the cache infrastructure (decision 022): the module, the service and the key builders.
export { CacheModule } from './cache.module';
export { CacheService } from './cache.service';
export type { GetOrLoadOptions } from './cache.service';
export { CACHE_KEY_FAMILIES, CacheKeys, familyOf } from './cache-keys';
export type { CacheKey, CacheKeyFamily, CachePrefix } from './cache-keys';
export {
  CacheValueTooLargeError,
  MAX_CACHED_VALUE_BYTES,
  TTL_JITTER_RATIO,
  decodeEntry,
  encodeEntry,
  jitterTtlMs,
} from './cache-entry';
export type { CacheEntry } from './cache-entry';
