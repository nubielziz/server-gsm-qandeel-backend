# Cache keys

Every key of the **cache Redis** (decision 006: `allkeys-lru`, no persistence) is built by `CacheKeys`
(`src/infra/cache/cache-keys.ts`) and listed here with its owner, TTL and invalidation (decision 022). A test
(`test/unit/infra/cache/cache-keys.spec.ts`) fails when a builder, its row in `CACHE_KEY_FAMILIES` or its row below is missing.
The queue Redis holds BullMQ data only and has no keys in this list (see `docs/queues.md`).

## Rules

- Shape: `gsm:{env}:{module}:{entity}:{id}[:v{n}]`. `{env}` is `development`, `test` or `production`, so environments that
  share an instance never collide. Each part is letters, digits, `.`, `_` or `-`.
- Every key has a TTL, with +-15 % jitter (`getOrLoad` adds it). Values are JSON under about 100 KB (larger values are
  refused and counted in `cache_errors_total{operation="too_large"}`).
- Every entry is sealed (decision 055): `c1:<kind>:<freshUntil>:<seal>:<JSON>`; an entry without a valid seal is a miss
  (`cache_errors_total{operation="mac"}`, logged at error level: tampering, or a `TOKEN_PEPPER` that differs between processes). A stale
  entry is served only inside the reader's `staleWhileRevalidate` window. What `getOrLoad` does not write stays unsealed: the rate-limit
  counters, stampede locks, version counters, semaphores, replay marks, the IP rule hit counters, the real-time doorbell and the health
  "last snapshot" copy.
- Read with `CacheService.getOrLoad(key, ttlSeconds, loader, options)`; options: `lockMs` (cross-instance stampede lock),
  `staleWhileRevalidate` (seconds), `negativeTtlSeconds` (short caching of "not found").
- Invalidate **after the commit**: `afterCommit(() => cache.del(key))`. For a group use a version key
  (`bumpVersion('catalog')`, read through `versioned('catalog', key)`) or, for small groups, `delByPrefix` (`SCAN`, never
  `KEYS`).
- Invalidations that follow a security change (sessions, API keys, roles, IP rules, settings, maintenance) use
  `CacheService.invalidate`: three tries, then one error line (`operation="invalidate"`); it never throws.
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
| `gsm:{env}:identity:session:{tokenHash}:v2` | identity | 60 s (a token that matches no live session: 10 s); a new or rotated session's view is loaded after the commit, a view read with less than 30 s left is loaded again in the background, and the once-a-minute `last_seen_at` write loads it again over the old view (`CacheService.reload`: never deleted first, so it stays readable while the new one loads). A view stays in Redis 60 s (the budget window) after its freshness for the cache-only lookup of decision 053 (an address that used up its failed-lookup budget is answered from this cache only): that lookup answers it and loads it again, the normal lookup reads Postgres. So a session used at least every 90 s stays served at such an address, also when it sends requests side by side; after a failed invalidation the old view is served by the normal lookup until its freshness ends (69 s at most), and by the cache-only lookup at most 60 s longer, each answer loading it again | `SessionService` deletes it after the commit of a revoke or a rotation, and `invalidateSubject(subjectType, subjectId)` after a suspension, password change, role change, rank change or (feature 20) a staff edit of an account details or email. Version `:v2` (decision 064): the view of an account session gained the rank and the accounts migration rewrites the subject type, so the new code never reads a view cached by the old one; the views of before sit under the name without a version, nothing reads them and they expire by themselves (a minute at most). Raise the number when the shape of the view changes again | `session` |
| `gsm:{env}:identity:api-key:{keyHash}:v3` | identity | 60 s (a key that matches nothing: 10 s); a view read with less than 30 s left is loaded again in the background, and the once-a-minute `last_used_at` write loads it again over the old view (`CacheService.reload`: never deleted first, so it stays readable while the new one loads). A view stays in Redis 60 s (the budget window) after its freshness for the cache-only lookup of decision 053 (an address that used up its unknown-key budget is answered from this cache only): that lookup answers it and loads it again, the normal lookup reads Postgres. So a key used at least every 90 s stays served at such an address, also when it sends calls side by side; after a failed invalidation the old view is served by the normal lookup until its freshness ends (69 s at most), and by the cache-only lookup at most 60 s longer, each answer loading it again | `ApiKeyDirectory.invalidate(keyHashes)` after the commit of a revoke or an edit of the key (the merchant rename or addresses, and the per-minute limit and addresses staff set, feature 20), `invalidateClient(accountId)` after a status change, a rename or a rank change of the account (it lists every key of the account, revoked ones included). Version `:v3` (decision 064): the access rule of a key changed again (a key works only for an active account of a merchant rank) and its migration revokes some keys in Postgres only, so the new code never reads a view cached under the old rule; the views of before sit under the older names (`:v2` of decision 062, and the name without a version), nothing reads them and they expire by themselves (about two minutes at most). Raise the number when the rule that judges a key changes again | `apiKey` |
| `gsm:{env}:identity:webhook-event:{gateway}:{eventHash}` | identity | 15 min (the 5 minute window on both sides of the signed time); a replay filter, not truth: the payment row is the idempotency | released when the request ended with a 5xx so the gateway retry is processed; otherwise it expires by itself | `webhookEvent` |
| `gsm:{env}:identity:role:{roleId}` | identity | 300 s | `RolePermissions.invalidate(roleId)` after the commit of a role change | `rolePermissions` |
| `gsm:{env}:platform:settings:all` | platform | 60 s | `SettingsReader.invalidate()` after the commit of a settings change | `settings` |
| `gsm:{env}:identity:ip-rules:active` | identity | 60 s (+-15 %), then the old snapshot is served for up to 5 minutes while one refresh runs | `IpRuleCache.invalidate()` after the commit of any IP rule or access restriction change | `ipRules` |
| `gsm:{env}:identity:ip-rule-hits:pending` | identity | 24 h, renewed by every hit; statistics only, so an evicted counter is just lost | emptied by the `ip_rule_hits_flush` job every minute; never deleted otherwise | `ipRuleHits` |
| `gsm:{env}:platform:maintenance:state` | platform | 60 s (+-15 %), then the old state is served for up to 5 minutes while one refresh runs | `MaintenanceService.invalidate()` after the commit of a maintenance change | `maintenance` |
| `gsm:{env}:identity:sign-in-failures:{emailHash}` | identity | 16 min after the last sign-in attempt (the lock itself lasts 15 min from the first attempt refused after ten failures); a throttle, not truth: an evicted count only loosens the lock | every attempt is counted before its password is checked and a correct password takes back only its own count (a running lock stays); a new password from an emailed link, set by staff or chosen by a customer or console member deletes it (a merchant's own change does not); otherwise it expires | `signInFailures` |
| `gsm:{env}:health:heartbeat:{name}` | health | 120 s; written by the API every 30 s | none; a missing heartbeat means the process is not running | `heartbeat` |
| `gsm:{env}:health:snapshot:{current-or-last}` | health | current 10 s; last 1 day (the copy served when Postgres is down) | PUT /admin/system/maintenance deletes current after its commit; otherwise expiry | `healthSnapshot` |
| `gsm:{env}:health:checks:{range}:{component}` | health | 30 s (+-15 %) | expiry only (history, not a decision) | `healthChecks` |
| `gsm:{env}:dashboard:payload:{scope}-{days}` | health (dashboard read model) | 15 s (+-15 %) | expiry only (a read model for display; nothing decides on it) | `dashboard` |
| `gsm:{env}:health:webhooks-in:{YYYYMMDDHH}` | health | 48 h | none; one hash per UTC hour (delivered, failed, retrying counters) | `webhookIntake` |
| `gsm:{env}:storefront:search-index:lock` | storefront (search) | 30 min (`SET NX PX 1800000`), renewed every minute by its holder | released by its holder with a token compare when the reconcile or rebuild ends; otherwise it expires | `searchIndexLock` |
| `gsm:{env}:storefront:search-terms:lock` | storefront (search) | 30 min (`SET NX PX 1800000`), renewed every minute by its holder | released by its holder with a token compare when the terms build ends; otherwise it expires | `searchTermsLock` |
| `gsm:{env}:storefront:search-popular` | storefront (search) | 10 min (+-15 %) | deleted by the `search_settings` job after a hidden-term change; otherwise expiry (display only, never a decision) | `searchPopular` |
| `gsm:{env}:storefront:search-card:{serviceId}:v{search}` | storefront (search) | 30 s (+-15 %); display text only (no price, no searchable rule: both are read on every request) | the search version moves after a synonym or pin push; otherwise expiry | `searchCard` |
| `gsm:{env}:storefront:suggest:{sha1(p)}:v{search}` | storefront (search) | 30 s (+-15 %); the engine part only (ids, ghost, completions, filters, did-you-mean), prices and the re-check come after it | the search version moves after a synonym or pin push; otherwise expiry | `searchSuggest` |
| `gsm:{env}:storefront:search-facet-labels:v{search}` | storefront (search) | 10 min (+-15 %) | the search version moves after a synonym or pin push; otherwise expiry (labels for display only) | `searchFacetLabels` |
| `gsm:{env}:storefront:search-terms:{yyyymmdd}` | storefront (search) | 3 days; statistics only (at most 20 000 fields a day), an evicted counter is a lost statistic | never deleted; the `search_terms_flush` job copies absolute values into `search_terms_daily` every 15 minutes | `searchTermsDay` |
| `gsm:{env}:storefront:search-visitors:{yyyymmdd}:{sha1(term)}` | storefront (search) | 3 days; a HyperLogLog of salted visitor hashes, never an IP | never deleted; read with `PFCOUNT` by the `search_terms_flush` job | `searchVisitors` |
| `gsm:{env}:storefront:search-visitor-salt:{yyyymmdd}` | storefront (search) | 48 h (`SET NX`: 32 random bytes per UTC day) | never; it expires, so hashes of two days cannot be linked | `searchVisitorSalt` |
| `gsm:{env}:{module}:{entity}:{idPrefix}` | infra/cache | n/a (a `SCAN` pattern, never stored) | n/a; `CacheService.delByPrefix` deletes every key that starts with it | `prefix` |

Version counters in use (all under the `gsm:{env}:cache:version:{name}` family above):

- **catalog** (owner: catalog module): moves after the commit of any write that can change a resolved price or what a merchant
  sees: a service create, change, archive or delete, a group price, client price or pricing rule write, a merchant group's
  discount change or delete, a category change or delete, and (feature 6) an effective cost that changed. A cached price list
  (Dhru, merchant catalog) must build its key through `CatalogPriceVersion.versioned(key)`; a list cached per merchant
  also carries the merchant's group id in its key, so a move to another group needs no bump. Feature 4b caches nothing itself: its
  routes read Postgres on every request.

- **search** (owner: storefront, feature 29): moves after the `search_settings` job pushed the synonym set or the curation set to
  Typesense, so cached suggest answers, search cards and facet labels (`searchSuggest`, `searchCard`, `searchFacetLabels`) start
  over with the new synonyms and pins. Read through `CacheService.versioned('search', key)`; nothing that decides (prices, the
  searchable rule) is cached under it.

Versioned keys are the base key plus `:v{n}`, where `{n}` is the current number of the version counter
(`gsm:{env}:cache:version:{name}`). The counter is the larger of "previous + 1" and the current time in milliseconds, so a
counter that the cache evicted and re-created can never reuse a number that old entries still carry.

## Named limiter keys that a module drives

`gsm:{env}:ratelimit:{limiter}:{key}` in the table above is one family for every named limiter in `src/infra/rate-limit/limiters.ts`.
A limiter that a module drives with a key of its own is listed here with its owner and lifetime (the key-family test reads only the
table above):

- `gsm:{env}:ratelimit:sign-in-familiar:{hash}` (owner: identity, decision 052; `SignInLock` builds the key, `RateLimitService` counts
  it). `{hash}` is the keyed hash (`TokenService.hash`) of the scope (`staff` or `shop`), the email and the network key (an IPv4 /24 or an
  IPv6 /64) of an attempt that is let through only because its network is one the account signed in from while its email is locked,
  so Redis shows no address. Lifetime: the limiter window, 15 minutes from the first point (a fixed window, no jitter and no lock-out
  of its own: it is a rate-limit window, not a cache entry); five points, the sixth attempt is refused. Invalidation: none, it
  expires; nothing writes it while no lock runs.

- `gsm:{env}:ratelimit:ip:session-failures:account:{addressKey}` (owner: identity, decisions 053 and 064; `SessionAuthenticator` builds the key,
  `RateLimitService` counts it on the `ip` limiter). `{addressKey}` is the IPv4 address or the IPv6 /64 of the caller. One point per
  session cookie that names no live account session; one budget for both URL families (`/client` and `/store/v1`) because every account
  has the one cookie. Lifetime: the `ip` window, 60 seconds (a fixed window, no jitter: a rate-limit window, not a cache entry); 300
  points, then answers come from the session cache alone. Invalidation: none, it expires. The staff budget has the same shape with
  `staff` in place of `account`.
- `gsm:{env}:ratelimit:wallet-topup:a:{accountId}` (owner: money, decision 064; the top-up use case builds the key). `{accountId}` is the
  account that asks for a new store balance top-up (before the accounts merged the key held the customer number). Lifetime: the
  limiter window, 10 minutes; ten points. A hint only, the daily limits are SQL. Invalidation: none, it expires.

## Not keys

The cache Redis also carries one **pub/sub channel**, which stores nothing, so `allkeys-lru` never evicts it and it has no TTL
and no row in the table above (the key-family test reads only that table):

- `gsm:{env}:realtime:doorbell:{db}` (owner: infra/realtime, decision 037). `{db}` is the database number of the cache URL,
  because pub/sub ignores `SELECT` and the test runs of several worktrees share one instance. Every process publishes
  (`RealtimePublisher`, after the commit); each API process has one dedicated subscriber connection (`gsm-realtime-sub`) that
  filters by `topic` in memory. A message is JSON of at most 8 KB with ids only (`v`, `topic`, `op`, `at`, ids), never a text,
  a token, an email address or a cookie; a lost message loses no data (the truth is in Postgres; see
  `src/infra/realtime/README.md`). Monitor it with `PUBSUB NUMSUB`, not `SCAN`.

## Adding a key family

1. Add a method to `CacheKeys` that returns a `CacheKey` (never build a key by hand).
2. Add its row to `CACHE_KEY_FAMILIES` (builder name, pattern, owner, TTL, invalidation).
3. Add the same row to the table above, with the pattern written exactly as in `CACHE_KEY_FAMILIES`.
4. Add the family to the module README ("Cache keys") and register the invalidation in the use case (`afterCommit`).

Families added by the features (catalog, settings, permissions, IP rules, sessions, price lists, health snapshot, ...) are
listed here by the feature that introduces them.
