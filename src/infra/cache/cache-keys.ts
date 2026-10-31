// The only place cache keys are built (decision 022): `gsm:{env}:{module}:{entity}:{id}[:v{n}]`. Every builder is also
// described in CACHE_KEY_FAMILIES and listed in docs/cache-keys.md; a test fails when a builder is missing from either.
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';

declare const cacheKeyBrand: unique symbol;
declare const cachePrefixBrand: unique symbol;

/**
 * A complete key of the cache Redis, as built by {@link CacheKeys}.
 *
 * Why: decision 022 allows keys only from the builders, so the cache API takes this branded string and a hand-written
 * key is a compile error.
 */
export type CacheKey = string & { readonly [cacheKeyBrand]: true };

/**
 * The start of a group of keys, for `CacheService.delByPrefix`.
 *
 * Why: bulk invalidation scans a prefix; a distinct type keeps a full key from being passed where a group is meant.
 */
export type CachePrefix = string & { readonly [cachePrefixBrand]: true };

/** One piece of a key: letters, digits, dot, underscore and dash. No ":" (the separator) and no glob characters. */
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

function segment(label: string, value: string | number): string {
  const text = String(value);
  if (!SEGMENT.test(text)) throw new Error(`Cache key ${label} "${text}" must match ${SEGMENT}`);
  return text;
}

/**
 * Describes one key family for `docs/cache-keys.md`.
 *
 * Why: decision 022 wants every key family documented with its owner, TTL and invalidation; the test compares this list
 * with the builders and with the document.
 */
export interface CacheKeyFamily {
  /** Name of the {@link CacheKeys} method that builds the key. */
  readonly builder: string;
  /** The key shape, exactly as written in `docs/cache-keys.md`. */
  readonly pattern: string;
  /** The module or infrastructure part that owns the key. */
  readonly owner: string;
  readonly ttl: string;
  readonly invalidation: string;
}

/**
 * Builds every key of the cache Redis.
 *
 * Why: one naming scheme keeps keys findable (`SCAN gsm:production:catalog:*`), separates environments that share an
 * instance, and lets metrics label hits and misses by family (`module:entity`). A feature adds a builder here, a row to
 * {@link CACHE_KEY_FAMILIES} and a row to `docs/cache-keys.md`.
 *
 * @see docs/decisions/022-caching.md and docs/cache-keys.md
 */
@Injectable()
export class CacheKeys {
  /** `gsm:{env}:`, the start of every key of this process. */
  readonly keyspace: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.keyspace = `gsm:${config.env}:`;
  }

  /**
   * The counter behind `CacheService.bumpVersion` / `versioned`.
   *
   * @param name what the version covers, for example `catalog`
   * @returns `gsm:{env}:cache:version:{name}`
   */
  version(name: string): CacheKey {
    return `${this.keyspace}cache:version:${segment('version name', name)}` as CacheKey;
  }

  /**
   * The `SET NX PX` lock that protects a hot key from a stampede across instances.
   *
   * @param key the key being loaded
   * @returns the key with `:lock` appended
   */
  lock(key: CacheKey): CacheKey {
    return `${key}:lock` as CacheKey;
  }

  /**
   * The sorted set behind a Redis semaphore (per-supplier concurrency).
   *
   * @param name what is limited, for example `supplier-12`
   * @returns `gsm:{env}:semaphore:{name}`
   */
  semaphore(name: string): CacheKey {
    return `${this.keyspace}semaphore:${segment('semaphore name', name)}` as CacheKey;
  }

  /**
   * The key prefix of one named rate limiter; `rate-limiter-flexible` appends `:{key}` itself.
   *
   * @param limiter the limiter name from `src/infra/rate-limit/limiters.ts`
   * @returns `gsm:{env}:ratelimit:{limiter}` (not a complete key: the limiter adds the caller's key)
   */
  rateLimit(limiter: string): string {
    return `${this.keyspace}ratelimit:${segment('limiter name', limiter)}`;
  }

  /**
   * The cached view of one session: the session row plus the state of its account (decision 018).
   *
   * @param tokenHash the keyed hash of the session token (never the token itself)
   * @returns `gsm:{env}:identity:session:{tokenHash}`
   */
  session(tokenHash: string): CacheKey {
    return `${this.keyspace}identity:session:${segment('session token hash', tokenHash)}` as CacheKey;
  }

  /**
   * The permission list of one role, read on every staff request (decision 018: "cached per role").
   *
   * @param roleId the id of the role
   * @returns `gsm:{env}:identity:role:{roleId}`
   */
  rolePermissions(roleId: number): CacheKey {
    return `${this.keyspace}identity:role:${segment('role id', roleId)}` as CacheKey;
  }

  /**
   * Every row of the `settings` table as one flat object, read by the session lifetimes and later by the pipeline hooks.
   *
   * @returns `gsm:{env}:platform:settings:all`
   */
  settings(): CacheKey {
    return `${this.keyspace}platform:settings:all` as CacheKey;
  }

  /**
   * The cached snapshot of the active IP rules and the access-restriction switch (identity module).
   *
   * @returns `gsm:{env}:identity:ip-rules:active`
   */
  ipRules(): CacheKey {
    return `${this.keyspace}identity:ip-rules:active` as CacheKey;
  }

  /**
   * The hash of IP rule hit counters that the worker flushes to `ip_rules.hit_count` every minute (identity module).
   *
   * @returns `gsm:{env}:identity:ip-rule-hits:pending`
   */
  ipRuleHits(): CacheKey {
    return `${this.keyspace}identity:ip-rule-hits:pending` as CacheKey;
  }

  /**
   * The cached maintenance state (platform module).
   *
   * @returns `gsm:{env}:platform:maintenance:state`
   */
  maintenance(): CacheKey {
    return `${this.keyspace}platform:maintenance:state` as CacheKey;
  }

  /**
   * A group of keys, for `CacheService.delByPrefix`.
   *
   * @param module the owning module, for example `catalog`
   * @param entity the kind of entry, for example `service`
   * @param idPrefix the start of the id part, to narrow the group (optional)
   * @returns `gsm:{env}:{module}:{entity}:` followed by the id prefix
   */
  prefix(module: string, entity: string, idPrefix = ''): CachePrefix {
    const tail = idPrefix === '' ? '' : segment('id prefix', idPrefix);
    return `${this.keyspace}${segment('module', module)}:${segment('entity', entity)}:${tail}` as CachePrefix;
  }
}

/**
 * Every key family the builders produce.
 *
 * Why: see {@link CacheKeyFamily}. The infrastructure families are listed here; every feature that adds a builder adds
 * its row in the same change.
 */
export const CACHE_KEY_FAMILIES: readonly CacheKeyFamily[] = [
  {
    builder: 'version',
    pattern: 'gsm:{env}:cache:version:{name}',
    owner: 'infra/cache',
    ttl: 'none; created on first use and re-created if the cache evicts it',
    invalidation: 'CacheService.bumpVersion(name) moves it to a new number; versioned keys with the old number expire',
  },
  {
    builder: 'lock',
    pattern: '{key}:lock',
    owner: 'infra/cache',
    ttl: 'lockMs of the getOrLoad call',
    invalidation: 'released by the process that took it (compare and delete) or expires',
  },
  {
    builder: 'semaphore',
    pattern: 'gsm:{env}:semaphore:{name}',
    owner: 'infra/rate-limit',
    ttl: 'the longest lease (ttlMs of acquire)',
    invalidation: 'RateLimitService.release, or the lease expires',
  },
  {
    builder: 'rateLimit',
    pattern: 'gsm:{env}:ratelimit:{limiter}:{key}',
    owner: 'infra/rate-limit',
    ttl: 'the limiter window (and block time) in src/infra/rate-limit/limiters.ts',
    invalidation: 'RateLimitService.reset (for example after a successful sign-in); otherwise it expires',
  },
  {
    builder: 'session',
    pattern: 'gsm:{env}:identity:session:{tokenHash}',
    owner: 'identity',
    ttl: '60 s (a token that matches no live session: 10 s)',
    invalidation:
      'SessionService deletes it after the commit of a revoke or a rotation, and invalidateSubject(subjectType, subjectId) after a suspension, password change or role change',
  },
  {
    builder: 'rolePermissions',
    pattern: 'gsm:{env}:identity:role:{roleId}',
    owner: 'identity',
    ttl: '300 s',
    invalidation: 'RolePermissions.invalidate(roleId) after the commit of a role change',
  },
  {
    builder: 'settings',
    pattern: 'gsm:{env}:platform:settings:all',
    owner: 'platform',
    ttl: '60 s',
    invalidation: 'SettingsReader.invalidate() after the commit of a settings change',
  },
  {
    builder: 'ipRules',
    pattern: 'gsm:{env}:identity:ip-rules:active',
    owner: 'identity',
    ttl: '60 s (+-15 %), then the old snapshot is served for up to 5 minutes while one refresh runs',
    invalidation: 'IpRuleCache.invalidate() after the commit of any IP rule or access restriction change',
  },
  {
    builder: 'ipRuleHits',
    pattern: 'gsm:{env}:identity:ip-rule-hits:pending',
    owner: 'identity',
    ttl: '24 h, renewed by every hit; statistics only, so an evicted counter is just lost',
    invalidation: 'emptied by the ip_rule_hits_flush job every minute; never deleted otherwise',
  },
  {
    builder: 'maintenance',
    pattern: 'gsm:{env}:platform:maintenance:state',
    owner: 'platform',
    ttl: '60 s (+-15 %), then the old state is served for up to 5 minutes while one refresh runs',
    invalidation: 'MaintenanceService.invalidate() after the commit of a maintenance change',
  },
  {
    builder: 'prefix',
    pattern: 'gsm:{env}:{module}:{entity}:{idPrefix}',
    owner: 'infra/cache',
    ttl: 'n/a (a SCAN pattern, never stored)',
    invalidation: 'n/a; CacheService.delByPrefix deletes every key that starts with it',
  },
];

/**
 * The key family a key belongs to, for metric labels.
 *
 * Why: hits and misses are counted per `module:entity` (decision 015), a bounded set of labels.
 *
 * @param key a key built by {@link CacheKeys}
 * @returns `module:entity`, or `unknown` for a string that is not shaped like a key
 */
export function familyOf(key: string): string {
  const parts = key.split(':');
  return parts.length >= 4 ? `${parts[2]}:${parts[3]}` : 'unknown';
}
