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
| `gsm:{env}:{module}:{entity}:{idPrefix}` | infra/cache | n/a (a `SCAN` pattern, never stored) | n/a; `CacheService.delByPrefix` deletes every key that starts with it | `prefix` |

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
