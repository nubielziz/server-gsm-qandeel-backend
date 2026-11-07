# Cache keys

Every key of the **cache Redis** (decision 006: `allkeys-lru`, no persistence) is built by `CacheKeys`
(`src/infra/cache/cache-keys.ts`) and listed here with its owner, TTL and invalidation (decision 022). A test
(`src/infra/cache/cache-keys.spec.ts`) fails when a builder, its row in `CACHE_KEY_FAMILIES` or its row below is missing.
The queue Redis holds BullMQ data only and has no keys in this list (see `docs/queues.md`).

## Rules

- Shape: `gsm:{env}:{module}:{entity}:{id}[:v{n}]`. `{env}` is `development`, `test` or `production`, so environments that
  share an instance never collide. Each part is letters, digits, `.`, `_` or `-`.
- Every key has a TTL, with +-15 % jitter (`getOrLoad` adds it). Values are JSON under about 100 KB (larger values are
  refused and counted in `cache_errors_total{operation="too_large"}`).
- Read with `CacheService.getOrLoad(key, ttlSeconds, loader, options)`; options: `lockMs` (cross-instance stampede lock),
  `staleWhileRevalidate` (seconds), `negativeTtlSeconds` (short caching of "not found").
- Invalidate **after the commit**: `afterCommit(() => cache.del(key))`. For a group use a version key
  (`bumpVersion('catalog')`, read through `versioned('catalog', key)`) or, for small groups, `delByPrefix` (`SCAN`, never
  `KEYS`).
- Never cache as truth: balances, ledger rows, holds, payment or order status used for decisions, risk decisions,
  idempotency results (decision 022). They live in Postgres.
- Metrics: `cache_hits_total{family}`, `cache_misses_total{family}`, `cache_errors_total{family,operation}`, where the
  family is `module:entity` of the key.

## Key families

| Key | Owner | TTL | Invalidation | Builder |
|---|---|---|---|---|
| `gsm:{env}:cache:version:{name}` | infra/cache | none; created on first use and re-created if the cache evicts it | `CacheService.bumpVersion(name)` moves it to a new number; versioned keys with the old number expire | `version` |
| `{key}:lock` | infra/cache | `lockMs` of the `getOrLoad` call | released by the process that took it (compare and delete) or expires | `lock` |
| `gsm:{env}:semaphore:{name}` | infra/rate-limit | the longest lease (`ttlMs` of `acquire`) | `RateLimitService.release`, or the lease expires | `semaphore` |
| `gsm:{env}:ratelimit:{limiter}:{key}` | infra/rate-limit | the limiter window (and block time) in `src/infra/rate-limit/limiters.ts` | `RateLimitService.reset` (for example after a successful sign-in); otherwise it expires | `rateLimit` |
| `gsm:{env}:identity:session:{tokenHash}` | identity | 60 s (a token that matches no live session: 10 s) | `SessionService` deletes it after the commit of a revoke or a rotation, and `invalidateSubject(subjectType, subjectId)` after a suspension, password change or role change | `session` |
| `gsm:{env}:identity:api-key:{keyHash}` | identity | 60 s (a key that matches nothing: 10 s) | `ApiKeyDirectory.invalidate(keyHashes)` after the commit of a revoke or an edit of the key, `invalidateClient(clientId)` after a merchant status change | `apiKey` |
| `gsm:{env}:identity:webhook-event:{gateway}:{eventHash}` | identity | 15 min (the 5 minute window on both sides of the signed time); a replay filter, not truth: the payment row is the idempotency | released when the request ended with a 5xx so the gateway retry is processed; otherwise it expires by itself | `webhookEvent` |
| `gsm:{env}:identity:role:{roleId}` | identity | 300 s | `RolePermissions.invalidate(roleId)` after the commit of a role change | `rolePermissions` |
| `gsm:{env}:platform:settings:all` | platform | 60 s | `SettingsReader.invalidate()` after the commit of a settings change | `settings` |
| `gsm:{env}:identity:ip-rules:active` | identity | 60 s (+-15 %), then the old snapshot is served for up to 5 minutes while one refresh runs | `IpRuleCache.invalidate()` after the commit of any IP rule or access restriction change | `ipRules` |
| `gsm:{env}:identity:ip-rule-hits:pending` | identity | 24 h, renewed by every hit; statistics only, so an evicted counter is just lost | emptied by the `ip_rule_hits_flush` job every minute; never deleted otherwise | `ipRuleHits` |
| `gsm:{env}:platform:maintenance:state` | platform | 60 s (+-15 %), then the old state is served for up to 5 minutes while one refresh runs | `MaintenanceService.invalidate()` after the commit of a maintenance change | `maintenance` |
| `gsm:{env}:{module}:{entity}:{idPrefix}` | infra/cache | n/a (a `SCAN` pattern, never stored) | n/a; `CacheService.delByPrefix` deletes every key that starts with it | `prefix` |

Version counters in use (all under the `gsm:{env}:cache:version:{name}` family above):

- **catalog** (owner: catalog module): moves after the commit of any write that can change a resolved price or what a merchant
  sees: a service create, change, archive or delete, a group price, client price or pricing rule write, a merchant group's
  discount change or delete, a category change or delete, and (feature 6) an effective cost that changed. A cached price list
  (Dhru, REST v1, merchant catalog) must build its key through `CatalogPriceVersion.versioned(key)`; a list cached per merchant
  also carries the merchant's group id in its key, so a move to another group needs no bump. Feature 4b caches nothing itself: its
  routes read Postgres on every request.

Versioned keys are the base key plus `:v{n}`, where `{n}` is the current number of the version counter
(`gsm:{env}:cache:version:{name}`). The counter is the larger of "previous + 1" and the current time in milliseconds, so a
counter that the cache evicted and re-created can never reuse a number that old entries still carry.

## Adding a key family

1. Add a method to `CacheKeys` that returns a `CacheKey` (never build a key by hand).
2. Add its row to `CACHE_KEY_FAMILIES` (builder name, pattern, owner, TTL, invalidation).
3. Add the same row to the table above, with the pattern written exactly as in `CACHE_KEY_FAMILIES`.
4. Add the family to the module README ("Cache keys") and register the invalidation in the use case (`afterCommit`).

Families added by the features (catalog, settings, permissions, IP rules, sessions, price lists, health snapshot, ...) are
listed here by the feature that introduces them.
