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
   * The cached view of one session: the session row plus the state of its account and, for an account, its rank (decision 018, decision 064).
   *
   * Why: the name carries a version (`:v2`, decision 064). The view of an account session gained the rank, and the accounts migration
   * revokes every account session and rewrites the subject type, so a view cached by the old code (no rank, subject `client` or
   * `customer`) must never be read by the new code: the new name makes every old view unreachable at once, with no `SCAN` flush and no
   * window in which a view without a rank is served. The views of before sit under the name without a version; nothing reads them and
   * they expire by themselves (a minute). Raise the number when the shape of the view changes again.
   *
   * @param tokenHash the keyed hash of the session token (never the token itself)
   * @returns `gsm:{env}:identity:session:{tokenHash}:v2`
   */
  session(tokenHash: string): CacheKey {
    return `${this.keyspace}identity:session:${segment('session token hash', tokenHash)}:v2` as CacheKey;
  }

  /**
   * The cached view of one API key and the status of its merchant (Dhru authentication, decision 018).
   *
   * Why: the name carries a version (`:v3`). `:v2` (decision 062) followed a change of the access rule of a key; decision 064 changes it
   * again (a key works only for an active account of a merchant rank, and its view carries the rank kind), and its migration revokes
   * some keys in Postgres only, so a view cached under the old rule must never be read by the new code. The views of before sit
   * under the older names; nothing reads them and they expire by themselves. Raise the number when the rule that judges a key changes
   * again.
   *
   * @param keyHash the keyed hash of the API key (never the key itself)
   * @returns `gsm:{env}:identity:api-key:{keyHash}:v3`
   */
  apiKey(keyHash: string): CacheKey {
    return `${this.keyspace}identity:api-key:${segment('api key hash', keyHash)}:v3` as CacheKey;
  }

  /**
   * The mark that an incoming gateway webhook event was accepted (replay protection, decisions 018 and 019).
   *
   * @param gateway the gateway slug of the URL, lower case
   * @param eventHash the SHA-256 hex of the gateway's event id (an id can hold characters a key must not)
   * @returns `gsm:{env}:identity:webhook-event:{gateway}:{eventHash}`
   */
  webhookEvent(gateway: string, eventHash: string): CacheKey {
    return `${this.keyspace}identity:webhook-event:${segment('gateway', gateway)}:${segment('event hash', eventHash)}` as CacheKey;
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
   * The count of failed sign-ins of one email in one scope (the console, or the shop), which decides the temporary lock (identity module).
   *
   * @param emailHash the keyed hash of the scope and the normalised email (never the email itself)
   * @returns `gsm:{env}:identity:sign-in-failures:{emailHash}`
   */
  signInFailures(emailHash: string): CacheKey {
    return `${this.keyspace}identity:sign-in-failures:${segment('email hash', emailHash)}` as CacheKey;
  }

  /**
   * The heartbeat a process leaves for the health checker (health module).
   *
   * @param name the process (`api`)
   * @returns `gsm:{env}:health:heartbeat:{name}`
   */
  heartbeat(name: string): CacheKey {
    return `${this.keyspace}health:heartbeat:${segment('heartbeat name', name)}` as CacheKey;
  }

  /**
   * The cached System health snapshot (health module).
   *
   * @param last `true` for the copy that outlives the short one (served while Postgres is down)
   * @returns `gsm:{env}:health:snapshot:current` or `gsm:{env}:health:snapshot:last`
   */
  healthSnapshot(last = false): CacheKey {
    return `${this.keyspace}health:snapshot:${last ? 'last' : 'current'}` as CacheKey;
  }

  /**
   * The cached check history of a range and component (health module).
   *
   * @param range the range (`24h`)
   * @param component a component key, or `all`
   * @returns `gsm:{env}:health:checks:{range}:{component}`
   */
  healthChecks(range: string, component: string): CacheKey {
    return `${this.keyspace}health:checks:${segment('range', range)}:${segment('component', component.replace(':', '_'))}` as CacheKey;
  }

  /**
   * The cached dashboard payload (platform dashboard, built by the health module).
   *
   * @param scope `all`, `b2b` or `b2c`
   * @param days `1`, `7` or `14`
   * @returns `gsm:{env}:dashboard:payload:{scope}-{days}`
   */
  dashboard(scope: string, days: number): CacheKey {
    return `${this.keyspace}dashboard:payload:${segment('scope', scope)}-${segment('days', days)}` as CacheKey;
  }

  /**
   * The hourly counters of incoming gateway callbacks (health module).
   *
   * @param hour the UTC hour, `YYYYMMDDHH`
   * @returns `gsm:{env}:health:webhooks-in:{hour}`
   */
  webhookIntake(hour: string): CacheKey {
    return `${this.keyspace}health:webhooks-in:${segment('hour', hour)}` as CacheKey;
  }

  /**
   * The lock of the search index's long runs (feature 29): the reconcile and the rebuild hold it (`SET NX PX`, renewed every minute).
   *
   * @returns `gsm:{env}:storefront:search-index:lock`
   */
  searchIndexLock(): CacheKey {
    return `${this.keyspace}storefront:search-index:lock` as CacheKey;
  }

  /**
   * The lock of the search terms build (feature 29).
   *
   * @returns `gsm:{env}:storefront:search-terms:lock`
   */
  searchTermsLock(): CacheKey {
    return `${this.keyspace}storefront:search-terms:lock` as CacheKey;
  }

  /**
   * The popular searches the empty search box shows (feature 29, slice B2).
   *
   * @returns `gsm:{env}:storefront:search-popular`
   */
  searchPopular(): CacheKey {
    return `${this.keyspace}storefront:search-popular` as CacheKey;
  }

  /**
   * The display part of a search card (title, slug, picture, brand, network, category, type; never a price), before its `search`
   * version suffix (feature 29, slice B2).
   *
   * @param serviceId the service
   * @returns `gsm:{env}:storefront:search-card:{serviceId}` (read through `CacheService.versioned('search', key)`)
   */
  searchCard(serviceId: number): CacheKey {
    return `${this.keyspace}storefront:search-card:${segment('service id', serviceId)}` as CacheKey;
  }

  /**
   * The engine part of a suggest answer (ids, ghost, completions, filters, did-you-mean), before its `search` version suffix
   * (feature 29, slice B2).
   *
   * @param prefixHash sha1 of the normalised typed text
   * @returns `gsm:{env}:storefront:suggest:{sha1(p)}` (read through `CacheService.versioned('search', key)`)
   */
  searchSuggest(prefixHash: string): CacheKey {
    return `${this.keyspace}storefront:suggest:${segment('suggest hash', prefixHash)}` as CacheKey;
  }

  /**
   * The facet labels of the results page (the most frequent spelling per lower-cased brand and network), before its `search` version
   * suffix (feature 29, slice B2).
   *
   * @returns `gsm:{env}:storefront:search-facet-labels` (read through `CacheService.versioned('search', key)`)
   */
  searchFacetLabels(): CacheKey {
    return `${this.keyspace}storefront:search-facet-labels` as CacheKey;
  }

  /**
   * The day's search counters: a hash of `s:<term>` (searches) and `z:<term>` (no results) (feature 29).
   *
   * @param day the UTC day, `yyyymmdd`
   * @returns `gsm:{env}:storefront:search-terms:{yyyymmdd}`
   */
  searchTermsDay(day: string): CacheKey {
    return `${this.keyspace}storefront:search-terms:${segment('day', day)}` as CacheKey;
  }

  /**
   * The day's distinct-visitor estimate of one term (a HyperLogLog over salted hashes, never an IP) (feature 29).
   *
   * @param day the UTC day, `yyyymmdd`
   * @param termHash sha1 of the normalised term
   * @returns `gsm:{env}:storefront:search-visitors:{yyyymmdd}:{sha1(term)}`
   */
  searchVisitors(day: string, termHash: string): CacheKey {
    return `${this.keyspace}storefront:search-visitors:${segment('day', day)}:${segment('term hash', termHash)}` as CacheKey;
  }

  /**
   * The day's random salt of the visitor hashes (feature 29), so yesterday's hashes cannot be linked to today's.
   *
   * @param day the UTC day, `yyyymmdd`
   * @returns `gsm:{env}:storefront:search-visitor-salt:{yyyymmdd}`
   */
  searchVisitorSalt(day: string): CacheKey {
    return `${this.keyspace}storefront:search-visitor-salt:${segment('day', day)}` as CacheKey;
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
    pattern: 'gsm:{env}:identity:session:{tokenHash}:v2',
    owner: 'identity',
    ttl: '60 s (a token that matches no live session: 10 s)',
    invalidation:
      'SessionService deletes it after the commit of a revoke or a rotation, and invalidateSubject(subjectType, subjectId) after a suspension, password change, role change, rank change or (feature 20) a staff edit of an account details or email',
  },
  {
    builder: 'apiKey',
    pattern: 'gsm:{env}:identity:api-key:{keyHash}:v3',
    owner: 'identity',
    ttl: '60 s (a key that matches nothing: 10 s)',
    invalidation:
      'ApiKeyDirectory.invalidate(keyHashes) after the commit of a revoke or an edit of the key (the merchant rename or addresses, and the per-minute limit and addresses staff set, feature 20), invalidateClient(accountId) after a status change, a rename or a rank change of the account',
  },
  {
    builder: 'webhookEvent',
    pattern: 'gsm:{env}:identity:webhook-event:{gateway}:{eventHash}',
    owner: 'identity',
    ttl: '15 min (the 5 minute window on both sides of the signed time); a replay filter, not truth: the payment row is the idempotency',
    invalidation:
      'released when the request ended with a 5xx so the gateway retry is processed; otherwise it expires by itself',
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
    builder: 'signInFailures',
    pattern: 'gsm:{env}:identity:sign-in-failures:{emailHash}',
    owner: 'identity',
    ttl: '16 min after the last sign-in attempt (the lock itself lasts 15 min from the first attempt refused after ten failures); a throttle, not truth: an evicted count only loosens the lock',
    invalidation:
      "every attempt is counted before its password is checked and a correct password takes back only its own count (a running lock stays); a new password from an emailed link, set by staff or chosen by a customer or console member deletes it (a merchant's own change does not); otherwise it expires",
  },
  {
    builder: 'heartbeat',
    pattern: 'gsm:{env}:health:heartbeat:{name}',
    owner: 'health',
    ttl: '120 s; written by the API every 30 s',
    invalidation: 'none; a missing heartbeat means the process is not running',
  },
  {
    builder: 'healthSnapshot',
    pattern: 'gsm:{env}:health:snapshot:{current-or-last}',
    owner: 'health',
    ttl: 'current 10 s; last 1 day (the copy served when Postgres is down)',
    invalidation: 'PUT /admin/system/maintenance deletes current after its commit; otherwise expiry',
  },
  {
    builder: 'healthChecks',
    pattern: 'gsm:{env}:health:checks:{range}:{component}',
    owner: 'health',
    ttl: '30 s (+-15 %)',
    invalidation: 'expiry only (history, not a decision)',
  },
  {
    builder: 'dashboard',
    pattern: 'gsm:{env}:dashboard:payload:{scope}-{days}',
    owner: 'health (dashboard read model)',
    ttl: '15 s (+-15 %)',
    invalidation: 'expiry only (a read model for display; nothing decides on it)',
  },
  {
    builder: 'webhookIntake',
    pattern: 'gsm:{env}:health:webhooks-in:{YYYYMMDDHH}',
    owner: 'health',
    ttl: '48 h',
    invalidation: 'none; one hash per UTC hour (delivered, failed, retrying counters)',
  },
  {
    builder: 'searchIndexLock',
    pattern: 'gsm:{env}:storefront:search-index:lock',
    owner: 'storefront (search)',
    ttl: '30 min (SET NX PX 1800000), renewed every minute by its holder',
    invalidation:
      'released by its holder with a token compare when the reconcile or rebuild ends; otherwise it expires',
  },
  {
    builder: 'searchTermsLock',
    pattern: 'gsm:{env}:storefront:search-terms:lock',
    owner: 'storefront (search)',
    ttl: '30 min (SET NX PX 1800000), renewed every minute by its holder',
    invalidation: 'released by its holder with a token compare when the terms build ends; otherwise it expires',
  },
  {
    builder: 'searchPopular',
    pattern: 'gsm:{env}:storefront:search-popular',
    owner: 'storefront (search)',
    ttl: '10 min (+-15 %)',
    invalidation:
      'deleted by the search_settings job after a hidden-term change; otherwise expiry (display only, never a decision)',
  },
  {
    builder: 'searchCard',
    pattern: 'gsm:{env}:storefront:search-card:{serviceId}:v{search}',
    owner: 'storefront (search)',
    ttl: '30 s (+-15 %); display text only (no price, no searchable rule: both are read on every request)',
    invalidation: 'the search version moves after a synonym or pin push; otherwise expiry',
  },
  {
    builder: 'searchSuggest',
    pattern: 'gsm:{env}:storefront:suggest:{sha1(p)}:v{search}',
    owner: 'storefront (search)',
    ttl: '30 s (+-15 %); the engine part only (ids, ghost, completions, filters, did-you-mean), prices and the re-check come after it',
    invalidation: 'the search version moves after a synonym or pin push; otherwise expiry',
  },
  {
    builder: 'searchFacetLabels',
    pattern: 'gsm:{env}:storefront:search-facet-labels:v{search}',
    owner: 'storefront (search)',
    ttl: '10 min (+-15 %)',
    invalidation: 'the search version moves after a synonym or pin push; otherwise expiry (labels for display only)',
  },
  {
    builder: 'searchTermsDay',
    pattern: 'gsm:{env}:storefront:search-terms:{yyyymmdd}',
    owner: 'storefront (search)',
    ttl: '3 days; statistics only (at most 20 000 fields a day), an evicted counter is a lost statistic',
    invalidation:
      'never deleted; the search_terms_flush job copies absolute values into search_terms_daily every 15 minutes',
  },
  {
    builder: 'searchVisitors',
    pattern: 'gsm:{env}:storefront:search-visitors:{yyyymmdd}:{sha1(term)}',
    owner: 'storefront (search)',
    ttl: '3 days; a HyperLogLog of salted visitor hashes, never an IP',
    invalidation: 'never deleted; read with PFCOUNT by the search_terms_flush job',
  },
  {
    builder: 'searchVisitorSalt',
    pattern: 'gsm:{env}:storefront:search-visitor-salt:{yyyymmdd}',
    owner: 'storefront (search)',
    ttl: '48 h (SET NX: 32 random bytes per UTC day)',
    invalidation: 'never; it expires, so hashes of two days cannot be linked',
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
