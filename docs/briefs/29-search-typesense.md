# Feature 29: English product search on Typesense (completion, nearby services, console tools)

Written by Opus 5.5 (planner), 2026-11-15, against backend `main` @ `e679a61`, console `main` @ `7797aa4`, storefront `main` @
`e3a2750`; revised after two adversarial Opus reviews (§11). Owner request (2026-11-15): a plan for Typesense, written by Opus; the
search engine supports **English only**; it **completes words and phrases** and **suggests nearby services** while the visitor
types. Earlier the same day the owner chose: a real search engine (Quick add imports thousands of services), self-hosted, Postgres
the source of truth, prices never in the index, a degraded Postgres fallback. Read first: `backend/CLAUDE.md`,
`docs/briefs/_common.md`, `_feature.md`; console slice also `frontend-admin/CLAUDE.md`; storefront slice `storefront/CLAUDE.md`
(and `node_modules/next/dist/docs/`). Paths are backend-relative; `FA/` = the console worktree, `SF/` = the storefront worktree. No
agent commits, runs git that changes state, or spawns agents. Money, orders (beyond one outbox line in the stock claim), suppliers
and the ledger are not touched.

## 1. What exists (verified in the code; research of 2026-11-15)

| # | Fact | Evidence |
|---|---|---|
| 1 | Public search is one escaped `ILIKE '%q%'` OR'ed over title, summary, brand, network; no token split, no index beyond btree | `infra/db/list-sql.ts:71-87`, `storefront/contracts/storefront-public.contracts.ts:235-285` |
| 2 | What the shop may sell: live, active service; active category; `allowedGroupIds` empty or holding the retail group; a retail `service_group_prices` row; a listing with `is_listed` | `catalog/infra/storefront-services.repository.ts:115-138`, `storefront/infra/listing.repository.ts:36-62` |
| 3 | One `service_listings` row per service and locale; brand, carrier, country, featured, sort, picture equal on every locale row; `sales30d` written only by the popularity job (no `updated_at` move); `listed_at` is nullable | `storefront/db/schema.ts:45-83` (`listedAt` :67), `storefront/jobs/popularity.ts:54` |
| 4 | The retail price is the same for every visitor (tax by country and FX are applied per request); merchant prices are personal and every shown merchant price is recorded (`ListedPrices.record`, user rule 9) | `storefront/README.md:35-43`, `catalog/README.md:61-75` |
| 5 | No catalog, listing, category or stock change writes an outbox event; the only signal is `CatalogPriceVersion` (a lossy Redis counter without ids) | `catalog/application/catalog-price-version.ts`, grep `routes.register` |
| 6 | Writers: `ServiceAdminService` create/update/remove; `ServiceImporter.create` (Quick add, supplier import; 100 per chunk, one transaction each); `CategoryAdminService` update/remove; group delete (`array_remove` on `service_categories.allowed_group_ids`, returns the category ids); `GroupPriceAdminService.replace` (deletes every row, inserts the new set: a group left out loses its price); `RetailPrices.set` (listing PATCH); `ListingAdminService` create/update; `ServicePartsService.replaceOptions`; `InventoryAdminService` import/void; `InventoryStock.claim`/`sell` | research §1; `group-price-admin.service.ts:95-97`, `client-group-admin.service.ts:277`, `group.repository.ts:191` |
| 7 | Imported services get no listing and no retail price: thousands land in the merchant catalog, the shop only after staff list them | `suppliers/application/imported-service.ts:80`, `catalog/README.md:122-124` |
| 8 | Brand, carrier are free text (case varies); `country` is an ISO-2 code or empty; logos are storefront static files resolved by name; supplier names hold HTML entities (`AT&amp;T`), emoji, embedded model lists | `storefront/contracts/listings.contracts.ts:49,132`, `storefront/lib/logo-sizes.json`, dev DB read |
| 9 | Store facet counts and the price span are computed in the site over at most 1000 cached cards with a mirror of the ILIKE rule (`matchesQuery`); brands are grouped case-insensitively | `SF/lib/catalog-facets.ts:99-108`, `SF/lib/catalog.ts` |
| 10 | The `ip` limiter is 300 a minute per `request.ip` over every public store route; `media` has its own budget through `publicLimiterFor` | `infra/rate-limit/limiters.ts`, `public-ip-limit.hook.ts:55-56` |
| 11 | Dev stack file is `compose.yaml`; prod `deploy/compose.prod.yaml` has no `mem_limit` anywhere; only Caddy publishes ports; Caddy logs the full URI and Referer (one `filter` per field, today a `regexp` for ticket tokens) | `compose.yaml`, `deploy/compose.prod.yaml`, `deploy/Caddyfile:31-43` |
| 12 | Permissions are derived from route contracts (`PermissionsCatalog`); existing storefront ones: `storefront:read`, `:update`, `:create`, `:publish` | `identity/security/permissions-catalog.ts` |
| 13 | Health components are a fixed list (`CORE_COMPONENTS`) and the checker maps indicators through `INDICATORS` | `health/domain/checks.ts:6`, `health/application/component-checker.ts:44` |
| 14 | Typesense 30.2 (2026-04-19) is the current stable; synonyms are `PUT /synonym_sets/:name {items}`, curation `PUT /curation_sets/:id {items}`, both linked by `synonym_sets` / `curation_sets` in the collection schema; curation items default to `remove_matched_tokens: true`; `typo_tokens_threshold` defaults to 1; `_text_match(buckets: n)` splits the hits into n equal-sized groups and ties inside each (Context7, v30.2 docs) | Context7 `/websites/typesense` |
| 15 | Next numbers: migration **0033**, decision **038**, B-entries **B221-B223** (`extra` has 116 entries, last B220: the ticket lock merged on 2026-11-15), queue number 12, `scripts/map-additions/29.mjs` | `drizzle/meta/_journal.json`, `docs/contract/lead-decisions.json` |
| 16 | The owner's dev DB has 0 English listings (one Arabic listing): English search shows nothing there until staff list services in English; the seed has 14 | dev DB read 2026-11-15 |
| 17 | Outbox payloads: lists of at most 50 elements, at most 2048 bytes, strings ≤ 64, `aggregateId` a positive integer; a violation is a `RangeError` that rolls back the caller's transaction | `platform/outbox/outbox-payload.ts:7-40` |
| 18 | `listedServiceIds` (used by `StorefrontQuotes.listedSellable` and `.priced`) accepts `is_listed` in **any** locale | `storefront/infra/listing.repository.ts:139-146`, `storefront/application/storefront-quotes.ts:133-160` |
| 19 | `StorefrontServices.priced` is capped at 10 000 ids (`MAX_PRICED_IDS`) | `catalog/infra/storefront-services.repository.ts:79` |
| 20 | `OutboundHttp`: responses cut at 5 MiB unless `maxResponseBytes`; public hosts only unless `allowPrivateNetwork` (which also allows `http` in production); `timeoutMs` ≤ 120 000; one warning log line per non-2xx | `src/infra/http/README.md:26-45`, `http.service.ts:85` |
| 21 | `apiPublic*` (site server) sends no `X-Forwarded-For` and runs inside `'use cache'`; `apiSession*` forwards cookies and XFF | `SF/lib/api/server.ts:1-27`, `SF/lib/api/public.ts` |
| 22 | `robots.ts` disallows only checkout, track, account, merchant, sign-in, sign-up, `/client/`, `/store/`: search pages are crawlable today | `SF/app/robots.ts` |

## 2. Decision 038 (text for `docs/decisions/038-search-typesense.md`; the lead writes the file)

**Decision.**
- **Engine.** Typesense **30.2**, self-hosted, one node, image pinned by digest, on the internal network only. It serves the
  **public storefront search in English**: the header combobox (completions, services, ready filters) and the results page. The
  merchant portal, REST v1, Dhru and the console lists keep their Postgres search (machine contracts; personal prices).
- **Postgres is the truth; the index is derived.** Documents hold only what a public visitor may see and no price. Any document
  can be rebuilt from Postgres at any moment; a nightly full rebuild into a new collection with an alias swap, a reconcile every
  15 minutes and an admin "Rebuild index" make a lost or stale index harmless. Synonyms and pins live in Postgres tables and are
  pushed to Typesense; nothing is edited in Typesense by hand. The data volume is not backed up; the API keys are recreated from
  the secret store by an idempotent script (§3.3), a required step after any wipe.
- **One writer.** Only the `search_sync` job (queue `search-index`, concurrency 1) writes documents through the live alias. The
  reconcile only compares and enqueues `search_sync`; the rebuild writes only its own new collection.
- **Every hit is re-checked.** The API re-reads the services of a page from Postgres with one rule, `searchableIds` (sellable for
  the retail group, a retail price row, an **English** listing with `is_listed`), plus the card and the price in the visitor's
  currency, before it answers; a stale hit is dropped, never shown.
- **Change signals.** Every writer of indexed facts writes a domain outbox event with ids (`catalog.services_changed`,
  `catalog.category_changed`, `storefront.listing_changed`) in its transaction, at most 50 ids per event; one queue
  (`search-index`) applies them. No module calls the search code.
- **Versioned schema.** Aliases carry the schema version (`<prefix>services_v<N>`); a deploy that changes the schema finds no
  alias, searches fall back until the worker's rebuild swaps one in.
- **English only.** Only `locale = 'en'` listings are indexed; one analyser (`locale` default, no stemming); Arabic pages keep
  today's Postgres search until Arabic is switched off.
- **Degraded fallback.** On **any** engine failure (timeout, connection, any 4xx/5xx, a failed sub-search, a malformed body, a
  missing alias) or `SEARCH_ENABLED=false`, the API answers from Postgres and says so (`engine: 'fallback'`); search never makes a
  page fail. The suggest fallback makes no service query (§5.5).
- **Client.** Our own small fetch client over `OutboundHttp` (decision 023: explicit timeouts, no hidden retries;
  `allowPrivateNetwork: true`). The official `typesense` package is not used (it brings axios and its own retry loop). No browser
  talks to Typesense: every request goes through `/store/v1/search*` (one origin, our rate limits, prices joined server-side, the
  key stays on the server).
- **Secrets.** The bootstrap key lives only in the Typesense container and the operator's secret store. The worker uses an
  indexer key, the API a search key (`documents:search`, `aliases:get`, `collections:get`), both with fixed values from the
  secret store, created by `bun scripts/search-keys.ts`, limited to the environment's collection prefix; each container gets only
  its own key.
- **Analytics** are ours, in Postgres, aggregated per day and term with a distinct-visitor estimate (a HyperLogLog over a daily
  salted hash, never an IP), filtered for personal data (§5.6). Typesense analytics stay off.

**Why not Meilisearch.** Its built-in analytics are a Cloud feature and sharding/snapshots are in the BUSL edition; Typesense's
server is GPL-3.0 with one edition, synchronous writes (visible when the call returns) and curation with time windows. Meilisearch's
disk-backed index would only matter above about 1M services, far beyond the plan (§10).
**Why not Postgres only** (`pg_trgm`, `tsvector`): no prefix-plus-typo ranking per field, no synonym sets or pins, no facet counts
over typo-tolerant matches, and the autocomplete load (a request every 150 ms per typing visitor) would land on the database that
holds the ledger. Postgres stays the fallback (results only; suggest falls back without a service query).
**Rejected.** Typesense Cloud (pay per search; catalog text leaves); embeddings for "nearby" (2-6 GB RAM for a built-in model, or a
paid external call per document; short service names gain little); the browser querying Typesense with a scoped key (bypasses our
limits, needs CORS and a Caddy route, the key's filters are readable); the official JS client (above).

**Consequences.** `backend/CLAUDE.md` "Architecture" gets one clause: "Search: Typesense holds derived, public, price-free documents;
writers of indexed facts write an outbox event; never read search results as truth." A Typesense outage degrades search only.

## 3. Infrastructure

### 3.1 Containers
- **Dev and tests, `compose.yaml`** (the lead adds it on `main` before any slice, §9 step 0):
  ```yaml
  typesense:
    image: typesense/typesense:30.2@sha256:610f2d34b1f93d00762869da2c67736775e5798d19a2c8b91b014b8a0cc1e110
    command: ["--data-dir", "/data", "--api-key", "gsm-typesense-dev", "--log-slow-requests-time-ms", "200"]
    ports: ["${GSM_TYPESENSE_PORT:-8108}:8108"]
    volumes: ["typesense-data:/data"]
    mem_limit: 768m
    healthcheck: { test: ["CMD-SHELL", "curl -fsS http://localhost:8108/health | grep -q true"], interval: 2s, timeout: 3s, retries: 30 }
  ```
  plus the volume `typesense-data`. Step 0 checks that the image has `curl`; if not, the test is
  `["CMD-SHELL", "bash -c 'exec 3<>/dev/tcp/127.0.0.1/8108 && printf \"GET /health HTTP/1.0\\r\\n\\r\\n\" >&3 && grep -q true <&3'"]`.
- **Production, `deploy/compose.prod.yaml`** (slice B2): service `typesense`, same image and digest, `restart: unless-stopped`,
  `command: ["--data-dir","/data","--api-key","${TYPESENSE_BOOTSTRAP_KEY:?set it}","--log-slow-requests-time-ms","500",
  "--memory-used-max-percentage","90","--disk-used-max-percentage","85","--db-compaction-interval","86400"]` (compaction daily
  because the nightly rebuild drops and recreates collections; writes stop before the disk Postgres shares fills), volume
  `typesense-data`, network `gsm` only, **no `ports`, no Caddy route**, `mem_limit: ${TYPESENSE_MEM_LIMIT:-1536m}`, the same
  healthcheck. Step 0 checks whether `--memory-used-max-percentage` reads the cgroup limit or host RAM; if host RAM, the flag is
  dropped and `mem_limit` + restart + the memory alert carry the rule. `api` and `worker` get `depends_on: typesense: condition:
  service_started` (never `service_healthy`: the API must boot without search); the API container gets only
  `TYPESENSE_SEARCH_KEY`, the worker only `TYPESENSE_INDEXER_KEY`. `TYPESENSE_BOOTSTRAP_KEY`, `TYPESENSE_SEARCH_KEY` and
  `TYPESENSE_INDEXER_KEY` are added to the secrets list of `docs/OPERATIONS.md`, with the runbook: after a volume wipe or an
  upgrade, run `bun scripts/search-keys.ts` before api and worker start; an alert on host disk use above 80 %. The backup service
  is unchanged (derived data).
- **Caddy** (`deploy/Caddyfile`, slice B2): the shop host's log filter becomes one `multi_regexp` per field on `request>uri` and
  `request>headers>Referer` holding the existing ticket-token rule and `([?&])q=[^&]*` → `${1}q=[redacted]`, so typed queries
  (IMEIs, phones, emails) never reach access logs.

### 3.2 Config (`src/config/env.ts`, `.env.example`, `docs/OPERATIONS.md`)

| Variable | Default (dev) | Rule |
|---|---|---|
| `SEARCH_ENABLED` / `SEARCH_ENABLED_TEST` | `true` / `false` | `false`: every search path is the Postgres fallback; sync jobs complete without calls. Tests stay on ILIKE unless a search suite opts in (`test/support/search.ts` starts its app with `true`), so `storefront-catalog.test.ts` and `storefront-retail-floor.test.ts` are unchanged |
| `TYPESENSE_URL` / `TYPESENSE_URL_TEST` | `http://localhost:8108` | production required (`http://typesense:8108`) |
| `TYPESENSE_INDEXER_KEY` | `gsm-typesense-dev` | worker only; production: required in the worker, refuses the dev value |
| `TYPESENSE_SEARCH_KEY` | `gsm-typesense-dev` | API only; production: required in the API, refuses the dev value |
| `TYPESENSE_PREFIX` / `TYPESENSE_PREFIX_TEST` | `gsm_development_` / `<database name of DATABASE_URL_TEST>_` | `^[a-z0-9_]{1,40}_$` (other characters of the name become `_`); production `gsm_production_`. Each worktree's test database gives its own prefix (`gsm_29_test_`) |
| `SEARCH_SUGGEST_TIMEOUT_MS` | `250` | 50-2000 |
| `SEARCH_TIMEOUT_MS` | `800` | 100-5000 |
| `SEARCH_RECONCILE_MINUTES` | `15` | 5-1440 |

Under `NODE_ENV=test` the `*_TEST` values replace the normal ones (decision 013), and `test/support/env.ts` passes
`TYPESENSE_URL_TEST` from a worktree's `.env.test`. The storefront's isolated e2e backend (`SF/scripts/dev-backend.sh`) sets
`TYPESENSE_PREFIX=gsm_storefront_` and `SEARCH_ENABLED=true`. Which key a process requires follows `SEARCH_KEY_ROLE` (§3.4).

### 3.3 Names in Typesense (per environment and worktree, like the Redis DB numbers)
- Schema versions `SERVICES_SCHEMA_VERSION` and `TERMS_SCHEMA_VERSION` (integers in `services-schema.ts` / `terms.ts`; any change
  of fields, types or collection options bumps them). Collections `<prefix>services_v<N>_<yyyymmddhhmmss>` and
  `<prefix>terms_v<N>_<yyyymmddhhmmss>`; aliases `<prefix>services_v<N>` and `<prefix>terms_v<N>` (all reads and incremental writes
  use the alias). A missing alias of the running version means **not ready**: the API falls back (§5.5), the worker starts a
  rebuild (§4.5). Collections and aliases of older versions are dropped after the swap.
- Synonym set `<prefix>synonyms`; curation set `<prefix>curations`. Both are linked in the services schema at creation
  (`synonym_sets`, `curation_sets`); the only code that creates a services collection is `SearchCollections.create`, which always
  links both (a test asserts the alias target carries the links).
- Keys (`scripts/search-keys.ts`, with `TYPESENSE_BOOTSTRAP_KEY`, `TYPESENSE_INDEXER_KEY`, `TYPESENSE_SEARCH_KEY` and the prefix in
  the shell): each key is created with its fixed `value` from the secret store and the description `gsm:<prefix>:indexer` /
  `gsm:<prefix>:search`. Idempotent: it lists the keys, finds each by description, compares actions and collections, tries one call
  with the key, and deletes and recreates it when anything differs or the call answers 401. Indexer `actions:
  ["collections:*","documents:*","aliases:*","synonym_sets:*","curation_sets:*","metrics.json:list","stats.json:list","debug:list"]`,
  search `actions: ["documents:search","aliases:get","collections:get"]`, both `collections: ["<prefix>.*"]`. The collection scope
  does **not** restrict global endpoints such as `synonym_sets` and `curation_sets` (Typesense docs): the indexer key can write any
  set on the node. Accepted: production runs one node per environment, only our code holds the keys, and sets are named by prefix;
  OPERATIONS records it.

### 3.4 Client, health, metrics, shutdown (`src/infra/search/`, owner infra)
- `TypesenseClient` (`typesense-client.ts`): `search`, `multiSearch` (checks each `results[i]`: a sub-search with `code`/`error`,
  or a body that does not parse to the expected shape, is a failure of the whole call), `importJsonl(collection, docs, action)`
  (parses **every** result line; returns `{ ok, failed: {id, error}[] }`), `deleteByIds` (`filter_by=id:[…]`, batches of 250; a
  filter delete of absent ids deletes nothing, no flag needed), `exportFields` (`maxResponseBytes: 64 MiB`), `createCollection`,
  `dropCollection`, `listCollections(prefix)`, `getAlias`/`putAlias`/`deleteAlias`, `putSynonymSet`, `putCurationSet`, `health`,
  `metrics`, `debug` (version). Each call through `OutboundHttp` with `allowPrivateNetwork: true` and an explicit timeout (search:
  the config values; import 120 s per batch of 500; export 60 s; others 5 s), header `X-TYPESENSE-API-KEY`, never logs a key or a
  query body. Errors are typed: `SearchUnavailable { kind: 'network'|'timeout'|'server'|'auth'|'resources' }` (connection,
  timeout, 5xx, 401/403, a write refused for disk or memory, whatever its status: step 0 records it), `SearchNotReady` (404 on the
  alias or collection), `SearchRejected` (any other 4xx, a programming error). `SearchModule` (`@Global`, loaded by API and
  worker) provides it with the key of the process (`SEARCH_KEY_ROLE` token: API `search`, worker `indexer`).
- `SearchHealthIndicator`: name `search`, `critical: false`, `GET /health` within 1 s plus the `<prefix>services_v<N>` alias exists
  (`aliases:get`); registered in `onModuleInit` like `StorageHealthIndicator`. `component-checker.ts` `INDICATORS` gains
  `search: 'search'`; `CORE_COMPONENTS` gains `'search'` with the name `Search engine`.
- `SearchCircuit` (API): opens at once on `SearchUnavailable` of kind `server|auth|resources` or on `SearchNotReady`, and after 3
  other failures within 30 s; half-open after 15 s (one probe request); while open every search is the fallback without a call. It
  also bounds `OutboundHttp`'s warning lines to about one per 15 s while the engine is broken.
- Metrics. API: `search_requests_total{route,engine}` (`route` = `suggest|results|services`), histogram
  `search_engine_seconds{route}` (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1), `search_fallback_total{reason}`
  (`timeout|error|not_ready|circuit_open|disabled`), `search_stale_hits_total`, `search_zero_results_total{route}`,
  `search_suggest_limited_total`, `search_terms_dropped_total` (the daily field cap). Worker: `search_sync_documents_total{op}`
  (`upsert|delete`), `search_sync_failures_total`, `search_sync_rejected_total`, `search_auth_failures_total`, histogram
  `search_sync_lag_seconds` (outbox `created_at` to written), gauges `search_index_documents`,
  `search_index_last_rebuild_timestamp_seconds`, `search_index_last_reconcile_timestamp_seconds`, `typesense_memory_allocated_bytes`
  (read from `/metrics.json` by the reconcile; Typesense has no Prometheus endpoint). The worker writes `engine_version`,
  `memory_bytes` and `documents` into `search_index_state` on each reconcile; the API's `GET /admin/search/index` reads that row.
- A 401/403 in the worker sets `search_index_state.last_error = 'search keys missing'` and counts `search_auth_failures_total`
  (alert rule in OPERATIONS); the jobs retry, so restoring the keys heals them.
- Shutdown: fetch keeps no connection to close; the `search-index` worker closes in `onModuleDestroy` like the others.

## 4. The index

### 4.1 What is a document
One document per service in `searchableIds` (fact 2 **and** an English listing with `is_listed`; an Arabic-only or English-off
service is absent). Id = `String(serviceId)` (stable across rebuilds, so pins keep working). Nothing else: no merchant-only service,
no draft, no Arabic listing, no price, no cost, no supplier, no stock count, no person, no internal service name (only the model
codes extracted from it, owner question 15). Merchant search on Typesense is out of scope (a later B-entry would add a separate
collection filtered by `allowed_group_ids`, without prices).

`searchableIds(db, ids)` (`search/application/searchable-ids.ts`, the one rule for build and every re-check): catalog's
`StorefrontServices.sellable(db, ids, retailGroupId)`, then the ids with a retail price row, then `listedServiceIdsIn(db, ids,
'en')` (new, `storefront/infra/listing.repository.ts`: `is_listed` and `locale = 'en'`). Cards are built only from English listing
rows.

### 4.2 Services schema (`src/modules/storefront/search/domain/services-schema.ts`, exact; `SERVICES_SCHEMA_VERSION = 1`)

| Field | Type | Params | From |
|---|---|---|---|
| `title` | string | — | English `publicTitle` as displayed: entities decoded, control characters and emoji removed, case and `&` kept (Typesense folds case and drops symbols itself, so `matched_tokens` map onto the shown title) |
| `title_sort` | string | `sort: true` | `normaliseText(title)` (the `title` sort of §5.3) |
| `summary` | string | `optional` | English `summary`, first 300 characters, same cleaning |
| `brand`, `carrier` | string | `optional` | listing facts, trimmed, inner spaces collapsed, case kept (matched, not faceted) |
| `brand_key`, `carrier_key` | string | `facet`, `optional` | the same, lower case (facets and `filter_by`; labels in §5.3) |
| `country` | string | `facet`, `optional` | the ISO-2 code (upper case) |
| `country_names` | string[] | `optional` | `Intl.DisplayNames('en', {type:'region'})` name plus the alias table of `search/domain/countries.ts` (GB: uk, britain, england, united kingdom; US: usa, america, united states; AE: uae, emirates; SA: ksa, saudi; …) |
| `networks` | string[] | `optional` | `service_options` labels of list `network` (normalised, at most 50) |
| `category` | string | `facet` | category `name` |
| `category_id` | int32 | `facet` | |
| `type` | string | `facet` | `imei|server|remote|file` |
| `codes` | string[] | `optional` | model codes and variants (§4.3) |
| `joins` | string[] | `optional` | concatenated word windows (§4.3) |
| `models` | string[] | `optional` | `service_options` labels of list `model` (normalised, at most 200) |
| `popularity` | int32 | — | `sales30d` (default sorting field) |
| `featured` | bool | `facet` | |
| `in_stock` | bool | `facet` | `IN_STOCK_SQL` (availability `in_stock`) |
| `sort` | int32 | — | listing `sort` |
| `listed_at` | int64 | — | unix seconds of `listedAt ?? createdAt` of the English listing |
| `hash` | string | `index: false` | sha1 of the other fields (the reconcile diff) |

Collection options: `default_sorting_field: "popularity"`, no `token_separators`, no `symbols_to_index` (Typesense drops special
characters: `AT&T` → `att`, `SM-A525F` → `sma525f`, exactly what the owner's examples need), `synonym_sets`, `curation_sets`.
Display fields (slug, picture, ETA) are not stored: the API reads them from Postgres.

### 4.3 Normalisation and model codes (`search/domain/normalise.ts`, pure, shared by index and query)
- `normaliseText(s)`: decode HTML entities (`&amp;` `&#39;` `&quot;` and numeric), NFKC, lower case, remove control characters
  (U+0000-U+001F, U+007F) and emoji (`\p{Extended_Pictographic}`), `&` removed (`at&t` → `att`), brackets and `|,;:` to spaces,
  collapse spaces, trim. Queries are cut to 100 characters after this.
- `extractCodes(text)`: tokens (split on spaces) that hold at least one letter and one digit, 3-24 characters. For each:
  the joined form without `-./_` (`sma525f`), its parts when it had separators (`sm`, `a525f`), and the form without a leading
  1-3-letter prefix when that prefix was separated (`a525f`). Deduplicated, at most 100 per document. Sources: title,
  `services.name` (its codes only; the name itself is not indexed), model option labels.
- `wordWindows(title)`: every window of 2-4 consecutive words of the normalised title, concatenated (`iphone15`, `iphone15pro`,
  `iphone15promax`, `15promax`), when at most 24 characters; at most 60 per document.

### 4.4 Terms collection (phrase completion; `search/domain/terms.ts`, `TERMS_SCHEMA_VERSION = 1`)
Fields: `q` string (normalised phrase), `kind` string facet (`brand|carrier|category|country|title|synonym|query`), `weight` int32,
`services` int32, `length` int32 (characters of `q`); `default_sorting_field: "weight"`. **One document per `q`** (id =
`sha1(q)`; weight = the highest of its sources; kind by priority brand > carrier > category > country > title > synonym > query).
Built in full by the terms job (§4.5) from:
- **Title phrases**: the display title is split into segments at brackets, `| , ; : /` and ` - ` (a dash with spaces) **before**
  normalising (`Samsung FRP (1-24 hours)` → `samsung frp`, `1-24 hours`); every 1-4 word window inside a segment; phrases that start
  or end with a stop word (`a, an, and, the, of, for, to, with, via, by, in, on, or, all, any, only, from`) are dropped.
- **Facet values**: brand, carrier and network labels, category names, country **English names** (never the code).
- **Synonym phrases** of enabled synonyms (`google account lock`, …), kind `synonym`.
- **Popular queries** (§5.6): 1-4 words; every normalised word an exact token of the **index vocabulary** (the words of indexed
  titles, brands, carriers, networks, country names, categories, code words and enabled synonym terms, which this build computes;
  no typo-only words); at least 5 distinct visitors on each of at least 3 days in 30 days; zero-result share under 50 %; not hidden.
Weight: for a title phrase the sum of `popularity + 1` of the services that contain it (capped at 2^31-1); for a facet value its
service count x 10; for a synonym phrase the weight of its best-matching term or 10; for a query its 30-day visitor count x 10.
Phrases of one character, and phrases that are only digits, are left out.

### 4.5 Sync (writers → outbox → `search-index`)

| Event (new, `payload` ids only) | Aggregate (`aggregateType`, `aggregateId`) | Written by (in its transaction) |
|---|---|---|
| `catalog.services_changed { serviceIds: number[], reason }` (1-50 ids) | `services`, the first id | `ServiceAdminService` create, update, remove (archive and delete); `GroupPriceAdminService.replace` (**every** call: a PUT without the retail row removes the price); `ServicePartsService.replaceOptions`; `InventoryAdminService` import, void; `InventoryStock.claim` and `sell` |
| `catalog.category_changed { categoryId }` | `service_categories`, the category id | `CategoryAdminService` update, remove; the merchant group delete: one event per category id that `dropGroupFromCategories` returns |
| `storefront.listing_changed { serviceIds }` (1-50 ids) | `services`, the first id | `ListingAdminService` create, update (any field; it also covers `RetailPrices.set` of the same PATCH), delete |
| `search.settings_changed { kind: 'synonyms'|'pins'|'hidden_terms' }` | `search_synonyms` / `search_pins` / `search_hidden_terms`, the row id | the admin search routes (§6) |
| `search.rebuild_requested { staffId }` | `search_index`, 1 | `POST /admin/search/index/rebuild` |

A longer id list is split by `SearchSignals.servicesChanged(tx, ids, reason)` / `.listingsChanged(tx, ids)`
(`search/application/search-signals.ts`) into several events of 50 in the same transaction (50 ids of up to 10 digits stay under
2048 bytes). `reason` is one of `service|price|options|stock` (a metric label only). Not signalled on purpose: Quick add and
supplier import (`ServiceImporter.create`: imported services have no listing, fact 7, so they cannot be documents; listing them
later emits `storefront.listing_changed`), effective cost and supplier sync (no indexed fact), the listing picture (not indexed),
the popularity job and anything missed: the reconcile covers them. `OutboxRouteRegistry`: the three change events → queue
`search-index`, job `search_sync`; `search.settings_changed` → `search-index`, job `search_settings`; `search.rebuild_requested` →
`maintenance`, job `search_rebuild`.

**Queue `search-index`** (the 12th; `docs/queues.md` row): concurrency **1**; `search_sync` is the **only** writer of documents
through the services alias, so two writes never race on one document. Attempts 8, backoff 30 s exponential with 50 % jitter (at
most about 64 minutes in all, 32-64 with jitter), stalled re-runs 1. Jobs:
- `search_sync`: input an outbox event or `{ serviceIds }` (≤ 500, enqueued by the reconcile). Resolve ids (`category_changed` →
  the category's service ids through catalog's new `StorefrontServices.serviceIdsOfCategory`, keyset-paged, processed 500 at a
  time); `SearchDocuments.build(db, ids)` returns documents for `searchableIds` and the rest as deletes; **deletes first**
  (`deleteByIds`), then `importJsonl(alias, docs, 'upsert')` in batches of 500. A rejected line never aborts the others: its id
  and error go into `search_index_state.last_error` and `search_sync_rejected_total`, the job completes. `SearchUnavailable`
  throws (retry); a missing alias (`SearchNotReady`) completes without writes and records `not_ready` (the rebuild and its
  reconcile cover the change); a whole-request `SearchRejected` is `UnrecoverableError` with `last_error`. With
  `SEARCH_ENABLED=false` it completes at once. Updates `search_index_state.last_sync_at`.
- `search_settings`: reads every enabled row of the kind, `putSynonymSet` / `putCurationSet` (the whole set, replace), bumps the
  cache version `search` after success; `hidden_terms` instead deletes the popular cache key and enqueues `search_terms_build`
  (jobId `terms-hidden-<outboxId>`).
- On queue `maintenance` (concurrency 2, recorded in `job_runs`), none of which writes through the services alias:
  - `search_reconcile` (scheduler every `SEARCH_RECONCILE_MINUTES`; also once at worker boot, jobId `boot-<bootId>`): when the
    alias of the running schema version is missing, it enqueues `search_rebuild` (jobId `rebuild-auto-v<N>-<yyyymmddhh>`) and
    stops. Otherwise it exports `id,hash` from the alias, builds every expected document's hash from Postgres through
    `StorefrontServices.pricedPage(db, retailGroupId, afterId, 1000)` (new, keyset-paged, **no cap**; never `priced`) and
    `searchableIds`, and enqueues `search_sync` jobs of ≤ 500 ids (changed, missing and extra ids; jobId
    `reconcile-<runId>-<n>`). Then it reads `/metrics.json` and the version and writes `documents`, `memory_bytes`,
    `engine_version`, `last_reconcile_at`.
  - `search_rebuild` (scheduler `search-rebuild-nightly` at 03:40 UTC, the manual event, the reconcile above): first drops every
    collection of the prefix that is not an alias target (orphans of a stalled run); creates a services collection of the running
    version, imports everything built from `pricedPage` into **that collection only**, checks that the imported count equals the
    built count with no failed line (else drops it, keeps the old alias, records the error), `putAlias`, drops older collections of
    this version and every collection and alias of older versions, releases its lock, then enqueues `search_terms_build` and
    `search_reconcile` (jobIds `after-rebuild-<runId>-terms|reconcile`): the reconcile turns changes made during the build into
    `search_sync` jobs.
  - `search_terms_build` (hourly at :20, after a rebuild, after a hidden-term change): builds a terms collection and swaps its alias
    the same way (it is the only writer of terms collections).
  - `search_terms_flush` (every 15 minutes, §5.6); `search_terms_purge` (daily 04:10 UTC, deletes `search_terms_daily` rows older
    than 180 days).
  Reconcile and rebuild hold the cache-Redis lock `gsm:{env}:storefront:search-index:lock`, the terms build its own
  `gsm:{env}:storefront:search-terms:lock` (both `SET NX PX 1800000`, renewed every minute, released by its holder with a token
  compare); a run that finds its lock held records `skipped`.
- Lag targets: an edit is searchable **p95 within 5 s** of its commit (relay 1 s + job; measured in `test:load:search`); anything
  missed within one reconcile period (15 minutes); a wiped engine or a new schema version is whole again after one rebuild (100k
  services: under 5 minutes, measured in §8).
- Engine down: the outbox keeps the rows, the jobs retry for up to about an hour and then sit in the failed list (console queues
  page); the next reconcile after recovery repairs everything. Search falls back meanwhile (§5.5).

### 4.6 Tables (migration `0033_search`; module `storefront`, `additionalTables` in `scripts/module-map.mjs`)
- `search_synonyms`: `id` bigint identity, `kind` text check `multi|one_way`, `root` text null (required for `one_way`), `terms`
  text[] (2-20 normalised items of 1-60 characters, distinct), `is_enabled` bool default true, `note` text default `''`,
  `created_by` bigint null references `staff_users`, `created_at`, `updated_at`. The migration inserts the owner's five:
  multi `frp`, `google account lock`, `frp lock`; multi `icloud`, `activation lock`, `icloud lock`; multi `unlock`,
  `network unlock`, `carrier unlock`, `sim unlock`; multi `imei check`, `blacklist check`, `gsma check`, `clean check`;
  multi `kg lock`, `knox guard`, `knox guard lock`.
- `search_pins`: `id`, `query` text (normalised, 1-100), `match` text check `exact|contains`, `pinned` jsonb (`[{serviceId,
  position}]`, at most 10, positions 1-10 distinct), `hidden` bigint[] (at most 50), `starts_at`, `ends_at` timestamptz null,
  `is_enabled`, `note`, `created_by`, `created_at`, `updated_at`; unique `(query, match)`.
- `search_hidden_terms`: `id`, `term` text unique, `note`, `created_by`, `created_at` (kept out of popular searches).
- `search_terms_daily`: `day` date, `term` text (at most 64), `searches` int, `zero_results` int, `visitors` int default 0; primary
  key `(day, term)`.
- `search_index_state`: one row (`id smallint primary key check (id = 1)`), `schema_version` int, `services_collection`,
  `terms_collection`, `documents` int, `engine_version` text null, `memory_bytes` bigint null, `last_sync_at`, `last_reconcile_at`,
  `last_rebuild_at`, `last_terms_build_at`, `last_error` text null, `updated_at`.
Set conversion: synonym `{ id: 's<id>', synonyms: terms }` (+ `root` for one-way); pin `{ id: 'p<id>', rule: { query, match },
includes: [{ id, position }], excludes: [{ id }], filter_curated_hits: true, remove_matched_tokens: false, effective_from_ts,
effective_to_ts }` (without `remove_matched_tokens: false` Typesense would search only the words left after the rule's words).

## 5. Search API

### 5.1 Routes (rows in `scripts/map-additions/29.mjs`, stage 29, `module: 'storefront'`)

| Route | Access | Group | Spec | Errors |
|---|---|---|---|---|
| `GET /store/v1/search/suggest` | `عام` | `catalog` | `B-TBD store-search` | `VALIDATION_FAILED`, `RATE_LIMITED` |
| `GET /store/v1/search` | `عام` | `catalog` | `B-TBD store-search` | `VALIDATION_FAILED`, `RATE_LIMITED` |
| `GET /admin/search/synonyms` (list), `POST`, `PATCH /:id`, `DELETE /:id` | `storefront:read` / `storefront:update` | `storefront` | `B-TBD admin-search` | `VALIDATION_FAILED`, `NOT_FOUND` |
| `GET /admin/search/pins` (list), `POST`, `PATCH /:id`, `DELETE /:id` | `storefront:read` / `storefront:update` | `storefront` | `B-TBD admin-search` | `VALIDATION_FAILED` (also a pinned or hidden id without a listed English listing), `NOT_FOUND`, `CONFLICT` |
| `GET /admin/search/hidden-terms`, `POST`, `DELETE /:id` | `storefront:read` / `storefront:update` | `storefront` | `B-TBD admin-search` | `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT` |
| `GET /admin/search/report` | `storefront:read` | `storefront` | `B-TBD admin-search` | `VALIDATION_FAILED` |
| `GET /admin/search/preview` | `storefront:read` | `storefront` | `B-TBD admin-search` | `VALIDATION_FAILED`, `UNAVAILABLE` |
| `GET /admin/search/index` | `storefront:read` | `storefront` | `B-TBD admin-search` | — |
| `POST /admin/search/index/rebuild` (202) | `storefront:publish` | `storefront` | `B-TBD admin-search` | `JOB_ALREADY_RUNNING`, `UNAVAILABLE` |

Existing route changed additively (B1): `GET /admin/service-listings` gains a `locale` filter (`en|ar`, listings.contracts.ts:151-156)
for the console's pin picker. Tables per row: public `service_listings`, `services`, `service_categories`, `currencies`,
`search_terms_daily`; admin the table of the row (+ `audit_logs` for writes). No new error code. Audit entity types (new,
`AUDIT_ENTITY_TYPES`): `search_synonym`, `search_pin`, `search_hidden_term`, `search_index`; every admin write calls
`AuditService.record` in its transaction and writes `search.settings_changed` (or `search.rebuild_requested`) in the same
transaction.

### 5.2 `GET /store/v1/search/suggest`
Query: `q` (string, control characters stripped, 0-100 after `normaliseText`), `currency` (as `BUYER_QUERY.currency`). Unknown keys
`422`. Limiter **`search-suggest`** (new): 1200 a minute per client IP (two typing visitors behind one carrier NAT fit), chosen in
`publicLimiterFor` for that path instead of `ip`; a refusal counts `search_suggest_limited_total`. `Cache-Control: public,
max-age=30`.

Response (`SuggestBody`, final names):
```ts
{ q: string; engine: 'typesense' | 'fallback';
  ghost: string | null;                       // the remainder that completes q (q 'iphone 15 p' → 'ro'); null on fallback
  completions: { text: string; kind: 'title'|'brand'|'carrier'|'country'|'category'|'synonym'|'query' }[];   // ≤ 6
  services: { id: Id; slug: string; title: string; titleHighlight: string; brand: string; network: string; type: ServiceType;
    category: { id: Id; name: string }; imageUrl: string | null; availability: Availability;
    price: { currency: string; net: Money; gross: Money } }[];   // ≤ 6, priced like the cards without buyerCountry
  filters: { kind: 'brand'|'network'|'country'|'category'; value: string; label: string; count: number }[];  // ≤ 4
  didYouMean: string | null; popular: string[];  // popular only when q is empty (≤ 8), else []
  intent: 'imei' | null }                         // q is an IMEI (below): offer "Check this IMEI"
```
`titleHighlight` is the title with `<mark>` around matched words, built by us from Typesense's `matched_tokens` over our own escaped
title (never Typesense HTML). Empty `q`: only `popular` (cache key `gsm:{env}:storefront:search-popular`, 10 minutes ±15 %, from
§5.6; empty → the top 4 category names). **IMEI intent** (`search/domain/imei-intent.ts`): after removing spaces, dashes, dots and
slashes, 15 digits with a valid Luhn check, or 16 digits (IMEISV, its first 14 digits); such an answer runs no search and is never
recorded (the results page shows the same "Check this IMEI" link).

One `multiSearch` (timeout `SEARCH_SUGGEST_TIMEOUT_MS`) with three searches (`search/domain/ranking.ts` holds the parameters):
1. **terms**: `q`, `query_by: q`, `prefix: true`, `num_typos: 1`, `max_candidates: 16`, `per_page: 10`, `sort_by:
   _text_match:desc,weight:desc,length:asc` (ties fixed: the shorter phrase first).
2. **services**: `query_by: title,codes,joins,models,brand,carrier,networks,country_names,category,summary`, `query_by_weights:
   10,10,8,6,6,5,4,5,4,2`, `num_typos: 2,0,0,0,1,1,1,1,1,1`, `prefix: true,true,true,true,true,true,true,true,true,false` (model
   numbers match while typed: `a525`, `sm-g99`), `enable_typos_for_alpha_numerical_tokens: false` (SM-A525F never finds SM-A526F;
   `sma526f` is not a prefix of `sma525f`), `enable_typos_for_numerical_tokens: false`, `drop_tokens_threshold: 0`,
   `split_join_tokens: fallback`, `synonym_prefix: true`, `synonym_num_typos: 1`, `max_candidates: 16`, `prioritize_exact_match:
   true`, `sort_by: _text_match:desc,_eval(in_stock:true):desc,popularity:desc` (no bucketing: text match decides; `in_stock`
   only breaks exact ties, which is intended), `facet_by: brand_key,carrier_key,country,category_id`, `max_facet_values: 10`,
   `per_page: 6`, `include_fields: id`, `highlight_fields: title,brand,carrier,category,codes`.
3. **nearby**: the same as 2 with `drop_tokens_threshold: 6` (drop words until results exist), `typo_tokens_threshold: 6` (look for
   typo variants until 6 results exist; the default 1 would switch typos off after one hit), `num_typos: 2` on the text fields
   (title, brand, carrier, networks, country_names, category, summary; codes, joins, models stay 0), `per_page: 12`.
Assembly (`search/domain/suggest-assembly.ts`, pure): services = hits of 2, then hits of 3 not already present ("nearby", never an id
of 2), at most 6, after the re-check: `searchableIds` on the ids, the cards, and the price of the survivors through
`StorefrontQuotes.pricedSellable(db, context, sellable)` (split out of `priced`, so the sellable and listing reads are not repeated;
target ≤ 4 Postgres queries per suggest); a dropped id counts `search_stale_hits_total`. The display part of a card (title, slug,
picture, brand, network, category, type) is cached per service at `gsm:{env}:storefront:search-card:{serviceId}:v{search}` for 30 s
±15 % (`search/application/search-cards.ts`); `searchableIds` and the price are read on every request, never cached.
**Ghost**: `p` = `normaliseText(input)` plus one space when the raw input ends with whitespace and `p` is not empty; `ghost` = the
remainder of the first term of search 1 whose `q` starts with `p` and is longer (null otherwise). The site draws it after the raw
value. **Completions** = the terms of 1 without the one equal to `trim(p)`, at most 6 (one per phrase by construction).
**Filters** = facet values of 2 whose label (§5.3 labels; country: `Country: <English name>`, value the code) starts with a query
word, in the order brand, network, country, category, then the top values by count, at most 4; `count` from the facet. The site
links a chip to `/en/services?q=<input without the matched word>&brand=<value>` (`network`, `country`, `categoryId` alike), with `q`
left out when nothing remains. `didYouMean` (§5.4). Engine part (ids, ghost, completions, filters, didYouMean) cached at
`gsm:{env}:storefront:suggest:{sha1(p)}:v{search}` for 30 s ±15 % (prices and the re-check are applied after the cache).

### 5.3 `GET /store/v1/search` (results page) and `GET /store/v1/services?q=`
Query: `q` (required, 1-100 after normalising), `page` (1-50, default 1), `perPage` (1-48, default 24), `brand`, `network`,
`country`, `categoryId`, `type` (each repeatable), `availability`, `featured`, `sort` (`relevance` default | `popular` | `title` |
`listedAt` | `price`), `order` (`asc|desc`; relevance and popular ignore it), and `BUYER_QUERY` (`currency`, `buyerCountry`,
`region`), `minPrice`, `maxPrice` (same rules as `/services`). Limiter `ip` (per visitor: the site forwards the visitor's address,
§7). `Cache-Control: public, max-age=30`.
Response:
```ts
{ q: string; engine: 'typesense' | 'fallback'; total: number; truncated: boolean; page: number; perPage: number;
  hits: CardBody[];                                    // the exact card of GET /store/v1/services
  facets: { brand: FacetCount[]; network: FacetCount[]; country: FacetCount[];
            category: { id: Id; name: string; count: number }[]; type: FacetCount[];
            availability: { in_stock: number; on_request: number } } | null;   // null on fallback
  priceRange: { min: Money; max: Money } | null;      // page 1 only, over the matches, when total ≤ 1000
  didYouMean: string | null; intent: 'imei' | null }
```
`FacetCount = { value: string; count: number }`. Facets run on `brand_key`, `carrier_key`, `country`, `category_id`, `type`,
`in_stock`; the wire `value` of brand and network is a **label**: the most frequent spelling per `lower(value)` among English listed
listings, from one cached Postgres read (`search/application/facet-labels.ts`, key
`gsm:{env}:storefront:search-facet-labels:v{search}`, 10 minutes ±15 %); filters match case-insensitively on the `*_key` fields, so
`Samsung` and `SAMSUNG` are one entry with the summed count. Country `value` is the code, its label the English name. One
`multiSearch`: the main search (search 2's parameters with `drop_tokens_threshold: 1`, `filter_by` from the filters on
`brand_key`, `carrier_key`, `country`, `category_id`, `type`, `in_stock`, `featured`, values lower-cased where keyed and escaped with
backticks; `max_facet_values: 20`) and, when `page = 1`, the same without the page's filters for the facet counts of each facet
group's own filter (one extra search per facet group that has a selected value; counts of a group ignore that group's own
selection). Sort: `relevance` as §5.2; `popular` `popularity:desc,_text_match:desc`; `title` and `listedAt` sort on `title_sort`
and `listed_at`. **Price** (`sort=price`, `minPrice`, `maxPrice`): read up to 1000 matching ids (four pages of 250 in one
multi_search), price them with `pricedSellable`, filter, sort, slice; `total` = the filtered count; `truncated: true` when the
engine found more than 1000. `priceRange` is computed on page 1 only. Every page's ids go through `searchableIds` (§4.1).

`GET /store/v1/services` keeps its contract; when `q` is set, `locale` is `en` (or absent) and the engine is available, it takes
the id order and the match set from the same main search (no facets), adds `relevance` to its sorts and uses it as the default
**only when `q` is set** (B223). With a price sort or price bounds the set is the best 1000 matches: `x-total-count` counts those and
`x-search-truncated: true` says more matched (today's cap is 10 000; stated in B223). With `locale=ar`, or on fallback, it is
today's ILIKE path. `x-search-engine: typesense|fallback` on both routes. `src/common/contract/list-query.ts` strips control
characters from `q` (today a NUL answers 500).

### 5.4 Ranking, synonyms, pins, "Did you mean"
Ranking order (§5.2 parameters): text match decides (exact and prefix matches on title and codes, field weights, exact-match
boost; typo matches score lower), then in-stock and popularity break exact ties; pins (curation, processed before synonyms)
override, and keep every query word for the organic part (`remove_matched_tokens: false`). Synonyms apply to the query words with
one typo and to prefixes (`synonym_prefix`, `synonym_num_typos: 1`), so `frp bypas` and `iclo` still expand.
`didYouMean` (`search/domain/did-you-mean.ts`, pure), over the main search's hits with `highlight_fields:
title,brand,carrier,category,codes`:
- The checked words are the complete query words (in suggest the last word only counts when the input ends with a space); words
  containing a digit are never corrected.
- A word `w` is **unknown** when no hit's `matched_tokens` holds `w` exactly or as a prefix, and `w` is not inside an enabled
  synonym term.
- Its replacement `r` is the matched token shared by all of the top `min(3, found)` hits with Damerau-Levenshtein(`w`, `r`) ≤ 1
  (≤ 2 when `|w|` ≥ 7). `didYouMean` = the query with each unknown word replaced; null when no word was replaced.
- When the main search found nothing: the best term of the terms collection searched with `num_typos: 2`, `prefix: false` (one
  more request, only then); null when equal to the query.
The results page shows "Did you mean …?" as a link to that query.

### 5.5 Fallback
`SearchEngine.run(route, fn, fallback)`: circuit open, `SEARCH_ENABLED=false`, or any failure of the call (`SearchUnavailable`,
`SearchNotReady`, `SearchRejected`, a failed sub-search, a malformed body, a timeout) → the fallback and
`search_fallback_total{reason}` (`not_ready` for a missing alias, `error` for the rest besides `timeout`). **Suggest fallback**
makes no service query: `{ engine: 'fallback', services: [], completions: the cached popular terms that start with p (at most 6),
filters: [], ghost: null, didYouMean: null }`; Enter still reaches the results fallback. **Results fallback**:
`StorefrontCatalogService.list` with the same filters, `facets` null, `didYouMean` null. Both say `engine: 'fallback'`.

### 5.6 Analytics (no personal data)
- A **search** is counted when `GET /store/v1/search` or `GET /store/v1/services?q=` (locale `en`) answers page 1 with no filter
  besides `q` (filter clicks, paging and suggest keystrokes are not counted); `zero_results` when `total = 0`. Not counted: a
  request with `Next-Router-Prefetch`, `Purpose: prefetch` or `Sec-Purpose: prefetch`, and a bot User-Agent
  (`search/domain/recordable-term.ts` `isBotUserAgent`: bot, crawl, spider, slurp, preview, headless, …). No IP, user id, session or
  cookie is stored or sent to Typesense (`enable_analytics` is off).
- `isRecordableTerm(term)` (pure): 2-64 characters, at most 5 digits in all, no `@`, no `http`/`www.`, not starting with `+`,
  no run of 5 or more digits; otherwise not counted (IMEIs, phone numbers, emails, order numbers, links).
- Counting (`search-terms-counter.ts`): `HINCRBY gsm:{env}:storefront:search-terms:{yyyymmdd}` fields `s:<term>` and `z:<term>`
  (TTL 3 days; at most 20 000 fields a day: beyond that not counted and `search_terms_dropped_total` grows; junk can fill the cap,
  which costs only statistics), and `PFADD gsm:{env}:storefront:search-visitors:{yyyymmdd}:{sha1(term)} <v>` (TTL 3 days) where
  `v` = the first 16 hex of HMAC-SHA256(daily salt, client IP); the salt is 32 random bytes at
  `gsm:{env}:storefront:search-visitor-salt:{yyyymmdd}` (`SET NX`, TTL 48 h), so yesterday's hashes cannot be linked to today's.
- `search_terms_flush` (idempotent under retries): for today and yesterday, `HGETALL` the day's hash and `PFCOUNT` each term's
  visitors (pipelined), then upserts **absolute** values (`searches`, `zero_results`, `visitors` SET, never ADD) into
  `search_terms_daily`. No `RENAME`; the keys expire by TTL. Lost counters are lost statistics, nothing else. Retention 180 days.
- Popular searches (§4.4) are computed from these rows (visitors, not searches) and exclude `search_hidden_terms`. Click-through is
  not recorded. Search pages are `noindex` and disallowed in `robots.txt` (§7), so crawlers do not feed the counts.

## 6. Console slice (`FA/`, a new **Search** tab on the Storefront page)

- `src/features/storefront/lib/tabs.ts`: tab `{ id: 'search', label: 'Search', anyOf: ['storefront:read'] }` (last), and the
  `StorefrontTab` union gains `'search'`. Panels in `components/search/`: `SearchTab.tsx` (sub-navigation Synonyms | Pinned results
  | Report | Index), `SynonymsPanel.tsx` + `SynonymDialog.tsx` (DataTable: terms, kind, on/off, note, updated; the dialog takes terms
  as chips, kind, root for one-way; hint "Changes reach the shop within a minute"), `PinsPanel.tsx` + `PinDialog.tsx` (query, match,
  up to 10 pinned services with positions through a picker on `GET /admin/service-listings?locale=en&q=` (English listings only),
  up to 50 hidden, optional dates; a 422 for an unlisted service shows on its row), `SearchPreview.tsx` (a box above the pins:
  `GET /admin/search/preview?q=` lists the top 10 with "pinned" and "hidden" marks, so staff test a rule before leaving),
  `SearchReportPanel.tsx` (7 / 30 / 90 days: totals, top terms, no-result terms; each no-result row has **Add synonym…** (opens
  `SynonymDialog` with the term) and **Pin services…** (opens `PinDialog` with the query), each row "Hide from popular" → `POST
  /admin/search/hidden-terms`, and the hidden list with "Show again"), `IndexStatusPanel.tsx` (engine status, version, memory,
  documents vs expected, last sync, last reconcile, last rebuild, queued and failed jobs, last error; **Rebuild index** behind a
  `ConfirmDialog`, shown with `storefront:publish`; it polls every 5 s while a rebuild runs).
- `api/search.ts` (every function tagged `@route METHOD /path`), `hooks/useSearchAdmin.ts`, `types/search.ts`,
  `mocks/searchRoutes.ts` (seeded: the five synonyms, one pin `unlock`, a 30-day report with 12 terms and 4 no-result terms, index
  status `ok` with 14 documents; refusals: `CONFLICT` for a duplicate pin query, `VALIDATION_FAILED` for a pin on an unlisted
  service, `JOB_ALREADY_RUNNING` on a second rebuild; `locale` honoured by the listings mock) wired in `mocks/index.ts`. Write tests
  for each panel (create, edit, delete, refusals, permission hiding, the report's two actions).
- Admin wire (exact): synonym `{ id, kind, root: string | null, terms: string[], isEnabled, note, createdAt, updatedAt }`; pin
  `{ id, query, match, pinned: { serviceId, position, title }[], hidden: { serviceId, title }[], startsAt, endsAt, isEnabled, note,
  createdAt, updatedAt }` (titles read for display); hidden term `{ id, term, note, createdAt }`; report `{ days, totals:
  { searches, zeroResults, terms }, topTerms: { term, searches, visitors, zeroResults }[], zeroResultTerms: { term, searches,
  lastSeen }[] }` (50 each); preview `{ engine, hits: { serviceId, title, position, pinned: boolean }[], hiddenIds: Id[] }`; index
  `{ engine: { status: 'ok'|'down'|'not_ready'|'disabled', version: string | null, memoryBytes: number | null }, schemaVersion,
  collection: string | null, documents, expectedDocuments, lastSyncAt, lastReconcileAt, lastRebuildAt, lastTermsBuildAt, queued,
  failed, rebuild: { running: boolean, startedAt: string | null }, lastError: string | null }` (version, memory and documents come
  from `search_index_state`). Lists use simple-rest (`q`, `_sort` `updatedAt|query`, `isEnabled`).
- System health needs no change if the Overview renders any component the API lists; the slice checks it and, if the list is
  fixed, adds `search` / `Search engine`. `FA/docs/MISMATCHES.md`: one line (the admin search routes are backend additions, B222).

## 7. Website slice (`SF/`)

- **Where.** Only the shop header on `/en` pages gets the combobox (desktop bar and phone row). `/ar` pages, the customer account
  header, the merchant portal header and the `/services` toolbar box keep the plain GET form (merchant search stays Postgres).
- **No JS on first load.** `components/ui/search-input.tsx` stays an honest server search field: the same `next/form` with a plain
  `type="search"` input, its label and `autoComplete="off"`, **no** `id`, `role` or `aria-controls` (Enter submits to
  `/en/services?q=` without JS); it only gains `enhance?: boolean`, which adds `data-search-enhance` to its wrapper. The header
  builds one search element on the server and the frame renders it twice (desktop and phone), so ids cannot come from the server.
  New `components/search/search-enhancer.tsx` (client, under 2 KB): per copy, at hydration, it takes `useId()`, finds its own input
  through a wrapper ref and sets `id`, `role="combobox"`, `aria-expanded="false"`, `aria-controls`, `aria-autocomplete="list"` and
  the option-id prefix on it; on the first `pointerenter`, `touchstart`, `focusin` or `pointerdown` it starts `React.lazy(() =>
  import('./search-combobox'))` (the first dynamic import of the site; the chunk stays under 15 KB gzip). The combobox **never
  renders or replaces** the SSR `<input>`: it attaches to it, reads `input.value` on mount and sends one suggest at once when it is
  not empty, so characters typed while the chunk loads, and an open phone keyboard, survive. First-load JS grows by at most 2 KB
  gzip per route.
- **Combobox** (`components/search/search-combobox.tsx`, `suggestion-list.tsx`, `ghost-text.tsx`; ARIA 1.2 combobox with a
  listbox): a `popover="manual"` panel under the input; sections as `role="group"` with labels: **Suggestions** (the ghost's full
  phrase first, then completions with the typed part plain and the rest bold; a completion that does not start with the input,
  a typo match, is bold as a whole), **Services** (picture 40 px, title with `<mark>`, brand logo, availability, `price.gross` in
  the visitor's currency read from the `gsm_currency` cookie; "Prices before tax" footnote), **Filters** ("Brand: Samsung",
  "Country: United Kingdom" chips, linked as §5.2), and on an empty box **Recent searches** (localStorage `gsm.search.recent`, 8 at
  most, `lib/search/recent.ts` wrapped in try/catch like `sound-setting.ts`; "Clear recent searches" is the last `role=option` of
  that group) and **Popular searches**. `intent: 'imei'` shows one option "Check IMEI …" linking to the IMEI check page.
  A visually hidden `aria-live="polite"` status ("6 suggestions, 4 services") updates 500 ms after the last answer.
- **Keyboard.** No option is active until Down or Up; Down/Up move `aria-activedescendant` (wraps); Enter opens the active option,
  or submits the typed text when none is active (owner answer 14); Escape closes then clears; **Tab or Right arrow at the end of
  the text** accepts the ghost when no option is active, or fills the active completion (Tab moves focus as usual when there is
  nothing to accept); Home/End stay in the text.
- **Ghost.** A grey overlay span aligned with the input text, `aria-hidden` (visual only; its full phrase is the first Suggestions
  option). Drawn after the raw input value, with its trailing spaces and case. Hidden when the input overflows (`scrollWidth >
  clientWidth`), when the caret is not at the end or text is selected, and on coarse pointers (no Tab key there).
- **Phones.** Each completion has a 44 px fill arrow: an `aria-hidden` span with its own pointer handler (not a button; nested
  interactive content inside an option would be hidden from assistive tech), which puts the text in the box without submitting.
  On coarse pointers the sections are capped at 3 completions, 4 services and 2 filters, and the panel's max-height follows
  `visualViewport.height` (a resize listener; `dvh` does not shrink for the iOS keyboard).
- **Requests.** `lib/search/suggest.ts`: 150 ms debounce, `AbortController` cancels the previous request, an in-memory LRU of 30
  answers per tab, `api` from `lib/api/browser.ts` (same origin). On an error or `engine: 'fallback'` the list shows what it has;
  after two errors in a row it stops asking until the next focus. The first service of a stable answer (unchanged for 300 ms) is
  prefetched with `router.prefetch`; nothing else prefetches. A chosen query is saved to recent searches (never an IMEI-like one:
  the same rule as §5.6). Logos: `lib/search/logo-client.ts` resolves brand and carrier names with the aliases of
  `service-art.tsx` over the keys of `lib/logo-sizes.json` (imported only by the lazy chunk); no logo → no image.
- **Phone row.** `store-header-frame.tsx`: the search toggle becomes an invoker (`command="toggle-popover"` on a `popover` row) so
  a tap before hydration works; the phone row's input carries the `autofocus` attribute (the popover focusing steps run inside the
  tap, so iOS Safari opens the keyboard; a `toggle` listener would run outside the user activation).
- **Results page.** `components/store/service-list.tsx`: with `q` on `/en`, read `GET /store/v1/search` through the new
  `apiVisitorGet` (`lib/api/server.ts`: `await connection()`, forwards only `X-Forwarded-For`, `User-Agent` and the prefetch
  headers, no cookies, never called inside `'use cache'`), so each visitor has their own `ip` budget and each search is counted;
  `/store/v1/services?q=` is read the same way. Render its hits, facet counts and `priceRange` (no in-memory facets for q pages;
  `lib/catalog-facets.ts` stays for pages without q and for `engine: 'fallback'`, where counts are hidden), "Did you mean **…**?"
  above the list, the "Check this IMEI" link for `intent: 'imei'`, an empty state with popular searches and "Clear filters", a
  quiet note "Simple search is in use right now" on fallback, and "Sorted by price among the best 1000 matches" when `truncated`
  with a price sort. Sorts: a **Best match** site sort is the default while `q` is set (left out of the URL) and "Featured" is
  hidden on q pages (`lib/catalog-facets.ts:214-237`). `app/[lang]/(store)/services/page.tsx` sends `noindex` when `q` is set;
  `app/robots.ts` adds `/*/services?*q=` and `/*?*q=` to `disallow`. `lib/api/store-query.ts` builds the search query (no empty
  keys, 422 rule). `/ar` stays on `/store/v1/services`.
- **Motion.** The panel uses `.popover-menu` timing (`--duration-fast`, `@starting-style`); options do not animate; reduced
  motion is covered by the global rule. No view transition on typing.
- **Strings.** New `lib/i18n/messages/search.ts` (`en` and `ar`, every key, though Arabic pages do not mount the combobox):
  `label` "Search services", `suggestions` "Suggestions", `services` "Services", `filters` "Filters", `recent` "Recent searches",
  `clearRecent` "Clear recent searches", `popular` "Popular searches", `fill` "Fill in {text}", `imei` "Check IMEI {imei}",
  `didYouMean` "Did you mean {q}?", `fallback` "Simple search is in use right now", `taxNote` "Prices before tax", `noResults` "No
  services match “{q}”", `status` "{suggestions} suggestions, {services} services", `country` "Country: {name}", `bestMatch`
  "Best match", `priceTruncated` "Sorted by price among the best 1000 matches".
- **Tests.** Vitest: ghost (overflow, caret, trailing space), recent, suggest client (debounce, abort, LRU), keyboard model (no
  active option by default), `apiVisitorGet` (forwards only the listed headers, calls `connection()`). New `e2e/search.spec.ts`
  (written here, run by the lead against the isolated API on `:3100`): typing "sams" shows a completion and Samsung services;
  typing "samsung fr" then Tab gives "samsung frp"; arrow + Enter opens a service; Enter on text opens `/en/services?q=`;
  "samsng frp" shows "Did you mean samsung frp?"; a typo still finds the service; a query with a single exact hit still shows
  nearby services; the phone project fills from a completion; no request before the first interaction (network log); text typed
  before the chunk loads is kept; no duplicate id in the document while both header copies are mounted; axe on the open panel;
  301 results-page searches in a minute with distinct `X-Forwarded-For` values never answer 429. Edit `store.spec.ts`,
  `catalog-filters.spec.ts` (`getByRole('combobox', { name: 'Search services' })` in the header only), `pre-hydration.spec.ts`
  (the phone row's input has focus after the tap).

## 8. Tests and acceptance

| File | Covers |
|---|---|
| `storefront/search/domain/*.spec.ts` | `normaliseText` (entities, `AT&T`, emoji, NUL), display title cleaning, `extractCodes`, `wordWindows`, country names and aliases, terms (one document per phrase, segment split, stop words, kind priority, weights, synonym phrases, popular eligibility: 1-4 words, vocabulary-only, an injected phrase `cheap unlock scam site` rejected, visitors rule), `isRecordableTerm` (IMEI, phone, email, order number, `a525f` allowed), `isBotUserAgent`, IMEI intent (separators, IMEISV), `didYouMean` (each rule, digits never corrected, fewer than 3 hits), suggest assembly (ghost with ties and trailing space, dedupe nearby, filter picking and chip links), filter escaping, synonym and pin conversion (`remove_matched_tokens: false`), event chunking at 50 |
| `infra/search/*.spec.ts` | the client against a fake server (import line parsing, a 200 with failed lines, a sub-search error in a 200, a malformed body, 503 and 401 → `SearchUnavailable`, 404 → `SearchNotReady`, a disk refusal → kind `resources`, timeouts, `allowPrivateNetwork` and `maxResponseBytes` passed), circuit transitions with `TestClock` |
| `test/integration/search-sync.test.ts` (real Postgres, Redis, **Typesense**) | each writer of §4.5 emits its events in its transaction (none after a rollback; a 120-id change → 3 events; Quick add writes none); relay + `search_sync` makes the change searchable (eventually, polled; no latency assertion): a listing switched on, off, retitled; English off with Arabic on removes the document; a category deactivated hides its services; `PUT group-prices` without the retail row removes the document; a group delete → one `category_changed` per category; a stock sale flips `in_stock`; `listed_at` null; one rejected line keeps the others; reconcile enqueues `search_sync` jobs and never writes (a deleted and a stale document repaired); an unlist during a rebuild is absent after the post-swap reconcile; rebuild writes only its new collection, swaps the alias with zero failed searches during it (a parallel search loop), drops old and orphan collections, keeps both set links; a bumped schema version finds no alias, the API falls back `not_ready`, the worker rebuilds; keys made by `scripts/search-keys.ts` (not the bootstrap key) work for both roles and the search key cannot write; the locks skip a second run; `SEARCH_ENABLED=false` completes without calls |
| `test/integration/listing-locale-filter.test.ts` | `GET /admin/service-listings?locale=en` |
| `test/integration/search-api.test.ts` | every route's success and refusal (422 unknown key, 100-character cap, NUL byte 200); suggest shape; price never from the index (a price change shows at once without a reindex); a stale hit is dropped; English off with Arabic on is absent from suggest and results; fallback on a closed port, a 401, a missing alias, a sub-search error and a malformed body, with `engine: 'fallback'` and `x-search-engine`; the suggest fallback runs no service query; Postgres queries per suggest ≤ 4 (query counter); facet labels (two spellings → one entry, summed); `/services?q=` keeps its array shape and `x-total-count`, `x-search-truncated` on a price sort; `locale=ar` stays ILIKE; analytics counted only for page 1 without filters, not for prefetch or bot requests, IMEI-like terms never stored; two identical searches from two `X-Forwarded-For` addresses count 2 and are limited per address; the flush run twice gives the same rows; a term becomes popular only with 5 visitors on 3 days and only with vocabulary words; the `search-suggest` limiter; admin CRUD with audit rows and events, `CONFLICT`, a pin on an unlisted service 422, `JOB_ALREADY_RUNNING`, permissions |
| `test/search/golden.test.ts` (part of `bun run check`) | the relevance golden set below over the fixture catalog `test/fixtures/search/catalog.ts` (about 60 English services named after the table) **plus 5 000 generated distractors** (`test/fixtures/search/generator.ts`, the same generator as `test:load:search`: realistic names, seeded, popularity up to 10x the fixture's), indexed into `<prefix>golden_` collections |
| Contract suite | route, access and permission parity for the new rows; OpenAPI; no allowlist entry |

**Golden set** (expected first service unless noted; `≠` = must not be first; S = suggest, R = results). `didYouMean: null` is
asserted for #1, #4, #7, #13, #19-27 and #44.

| # | Query | Expect | # | Query | Expect |
|---|---|---|---|---|---|
| 1 | samsung frp | samsung-frp-bypass | 23 | gsma check | imei-blacklist-check |
| 2 | samsng frp | samsung-frp-bypass, didYouMean `samsung frp` | 24 | clean check | imei-blacklist-check |
| 3 | frp bypas | samsung-frp-bypass | 25 | blaclist check | imei-blacklist-check |
| 4 | google account lock samsung | samsung-frp-bypass | 26 | knox guard | samsung-kg-removal |
| 5 | icloud | iphone-icloud-removal | 27 | kg lock | samsung-kg-removal |
| 6 | iclod | iphone-icloud-removal, didYouMean `icloud` | 28 | huawai frp | huawei-frp-reset |
| 7 | activation lock | iphone-icloud-removal | 29 | xiaomi mi acount | xiaomi-mi-account-removal |
| 8 | at&t | att-usa-iphone-unlock | 30 | google pixel frp | pixel-frp-removal |
| 9 | att | att-usa-iphone-unlock | 31 | vodafon | vodafone-uk-unlock |
| 10 | AT&T iphone unlock | att-usa-iphone-unlock | 32 | sim unlock vodafone | vodafone-uk-unlock |
| 11 | tmobile | tmobile-usa-unlock | 33 | unlock + brand=Samsung (R) | only Samsung hits |
| 12 | t-mobile | tmobile-usa-unlock | 34 | unlock (exact pin fixture) | iphone-15-pro-max-unlock first; motorola-unlock-code hidden; every other hit contains `unlock`; `total` = pinned + organic `unlock` matches |
| 13 | SM-A525F | galaxy-a52-unlock-sm-a525f | 35 | `  SAMSUNG   FRP  ` | samsung-frp-bypass |
| 14 | sm a525f | galaxy-a52-unlock-sm-a525f | 36 | sams (S) | completion `samsung` exactly once; a Samsung service first |
| 15 | sma525f | galaxy-a52-unlock-sm-a525f | 37 | icl (S) | ghost `oud` |
| 16 | a525f | galaxy-a52-unlock-sm-a525f | 38 | iphone 15 p (S) | ghost `ro`; completions contain `iphone 15 pro max` |
| 17 | SM-A526F | ≠ galaxy-a52-unlock-sm-a525f | 39 | vod (S) | filter Network: Vodafone |
| 18 | SM-A528B | galaxy-a52s-unlock-sm-a528b | 40 | 356938035643809 (S) | `intent: 'imei'`, not recorded |
| 19 | iphone15promax | iphone-15-pro-max-unlock | 41 | zzzzzzz | 0 hits, `didYouMean` null |
| 20 | iphone 15 pro max | iphone-15-pro-max-unlock | 42 | فك شبكة | 0 hits, 200 |
| 21 | carrier unlock iphone 15 pro max | iphone-15-pro-max-unlock | 43 | `<script>` | 0 hits, 200 |
| 22 | imei check | imei-blacklist-check | 44 | uk unlock | vodafone-uk-unlock or ee-uk-unlock |
| 45 | samsung a52 frp (S) | the 6 services include galaxy-a52-unlock-sm-a525f and samsung-frp-bypass | 46 | vodafone uk iphone 15 unlok (S) | the 6 include vodafone-uk-unlock and iphone-15-pro-max-unlock |
| 47 | a525 (S) | galaxy-a52-unlock-sm-a525f | 48 | sm-g99 (S) | samsung-network-unlock-all-models (model options hold SM-G991B) |
| 49 | iphone15pr (S) | iphone-15-pro-max-unlock | 50 | iphone 15 pro m (S) | ghost `ax` |
| 51 | `samsung ` (S) | ghost `frp`, drawn without a double space | 52 | united kingdom unlock | vodafone-uk-unlock or ee-uk-unlock |
| 53 | usa iphone unlock | att-usa-iphone-unlock (its title does not contain "USA"; country US) | 54 | samsung frp | ≠ the popular distractor that says "Samsung FRP" only in its summary |
| 55 | iphone 15 pro max unlock | ≠ a popular distractor that matches only with a typo | 56 | iphone unlock (contains pin fixture) | pinned first; every organic hit contains both words |
| 57 | frp (S) | no completion `frp 1-24` (segment rule) and none ending in a stop word | 58 | 3569 3803 5643 809 (S) | `intent: 'imei'` |

B2 may tune only the numbers of §5.2/§5.3 (field weights, `max_candidates`, `drop_tokens_threshold`, `typo_tokens_threshold`) to
pass the set, and records the final values in the storefront README; a case it cannot pass is reported, never deleted.

**Latency and load** (`bun run test:load:search`, not in `check`; the lead runs it once before the merge on 10 000 synthetic
documents; table in `src/modules/storefront/search/README.md`): suggest at the API p95 **≤ 50 ms** (engine part p95 ≤ 15 ms),
results p95 ≤ 120 ms, price-sorted results p95 ≤ 300 ms; Postgres queries per suggest (target ≤ 4) and database CPU; 100 suggest
requests per second for 60 s from 20 IPs: 0 errors, p95 within target, Typesense RSS recorded; sync lag p95 ≤ 5 s; a full rebuild
and a full reconcile build of 100 000 synthetic documents: duration (targets under 5 minutes and under 2 minutes) and peak RSS.

**Acceptance of the feature**: on `/en`, typing "samsng fr" shows "samsung frp" as a completion and the Samsung FRP service with
its price and logo within a blink; typing "samsung fr" shows the ghost "p" and Tab completes it; Enter shows the results with brand
and network counts; a listing switched off in the console disappears from search within 5 s; `docker stop typesense` → search
keeps working (fallback note), and after the start the index is whole again by itself; `SEARCH_ENABLED=false` behaves exactly like
today.

**Migration and rollback.** Migration 0033 is additive (five tables, five synonym rows). Turning search off is
`SEARCH_ENABLED=false` (no deploy of code needed to go back to today's behaviour); removing Typesense is stopping the container and
deleting its volume. A Typesense upgrade (v31 later) or a lost volume is: new image or empty volume, `bun scripts/search-keys.ts`,
start api and worker; the worker's boot reconcile finds no alias and rebuilds (search falls back meanwhile). A schema change ships
with a version bump and needs no manual step.

## 9. Slices, order, files

**Step 0 (lead, on `main`, before the worktrees).** Add the `typesense` service and volume to `compose.yaml`, `docker compose up
-d typesense`, check the digest, the healthcheck tool, and in a scratch script: a key created with a fixed `value`; a `collections`
regex on a key; that `aliases:get` and `collections:get` suffice for the health and index reads; a failing sub-search's shape in
`multi_search`; `filter_curated_hits` and `remove_matched_tokens: false` on a `contains` and an `exact` rule; the `curated` flag on
pinned hits; `sm a525f`, `a525` and `sm-g99` against `codes`; `typo_tokens_threshold` widening; the status of a write refused by
`--disk-used-max-percentage`; whether `--memory-used-max-percentage` reads the cgroup limit; Caddy's `multi_regexp` on `uri` and
`Referer`. On the owner's DB (read only): the average document size (models, codes, joins) and the time of a full Postgres build at
that size scaled to 100k; size `mem_limit` from it (§10). Record the answers in the brief's §11. Create `../backend-29`
(`feat/backend-29`, `.env.test`: `gsm_29_test`, Redis DB 8 (7 is `backend-lock`'s); the prefix follows from the database name),
`../frontend-admin-29` (`feat/console-29`), `../storefront-29` (`feat/storefront-29`, own `npm ci`).

Order: **B1 → B2** in `../backend-29`; **C** and **S** start with B2 against §5-§7 and their mocks. The lead merges B, then C, then
S (S tested against the isolated API on `:3100`).

**B1. Index, sync, infra: HARD, an Opus implementer.** Create `src/infra/search/{search.module.ts, typesense-client.ts,
typesense.types.ts, search-errors.ts, search-circuit.ts, search-health.indicator.ts, search-metrics.ts, index.ts, README.md}` (+
specs); `src/modules/storefront/search/{search-index.module.ts, search-worker.module.ts}`, `search/domain/{normalise.ts,
countries.ts, services-schema.ts, terms.ts, vocabulary.ts, documents.ts, set-conversion.ts}` (+ specs), `search/application/
{searchable-ids.ts, search-documents.ts, search-collections.ts, search-sync.ts, search-settings-push.ts, search-reconcile.ts,
search-rebuild.ts, search-terms-build.ts, search-terms-flush.ts, search-signals.ts, search-locks.ts}`, `search/infra/
{search-source.repository.ts, search-tables.repository.ts}`, `search/jobs/{search-index.processor.ts,
search-maintenance.processors.ts, search-outbox-routes.ts}`, `search/db/schema.ts`, `drizzle/0033_search.sql` (+ journal and
snapshot), `scripts/search-keys.ts`, `scripts/search-rebuild.ts`, `test/integration/search-sync.test.ts`,
`test/integration/listing-locale-filter.test.ts`, `test/support/search.ts` (opt-in app with `SEARCH_ENABLED=true`, prefix cleanup
in `afterAll`, wait-for-sync helper). Edit `src/config/env.ts` (+ spec), `test/support/env.ts`, `src/app.module.ts`,
`src/worker.module.ts`, `src/infra/queues/queue-definitions.ts`, `docs/queues.md`, `src/infra/db/schema.ts` (export
`search/db/schema.ts`), `src/infra/cache/cache-keys.ts` and `docs/cache-keys.md` (every key of this feature, B2's included),
`scripts/module-map.mjs`, `src/modules/health/{domain/checks.ts, application/component-checker.ts}` (+ specs),
`src/modules/platform/audit/audit-entity-types.ts`, the writers of §4.5 (`catalog/application/{service-admin.service.ts,
category-admin.service.ts, client-group-admin.service.ts, group-price-admin.service.ts, service-parts.service.ts,
inventory-admin.service.ts, inventory-stock.ts, storefront-services.ts}`, `catalog/infra/storefront-services.repository.ts`
(`pricedPage`, `serviceIdsOfCategory`), `catalog/index.ts`, `storefront/application/listing-admin.service.ts`,
`storefront/infra/listing.repository.ts` (`listedServiceIdsIn`, the `locale` list filter), `storefront/contracts/listings.contracts.ts`
(`locale`), `storefront/index.ts`), `scripts/seed/run.ts` (rebuild at the end when Typesense answers), `scripts/db-reset.ts` (drop
the prefix's collections, aliases and sets), and the generated documents.
**B2. Search API, console routes, docs: a Sonnet implementer, after B1** (ranking parameters are fixed here; only §8's tuning is
free). Create `search/contracts/{store-search.contracts.ts, admin-search.contracts.ts}`, `search/controllers/
{store-search.controller.ts, admin-search.controller.ts}`, `search/application/{suggest.service.ts, results.service.ts,
search-engine.ts, search-cards.ts, facet-labels.ts, search-admin.service.ts, search-report.service.ts, search-terms-counter.ts}`,
`search/domain/{suggest-assembly.ts, did-you-mean.ts, filters.ts, recordable-term.ts, imei-intent.ts, ranking.ts}` (+ specs),
`search/search-http.module.ts`, `search/README.md`, `scripts/map-additions/29.mjs`, `test/integration/search-api.test.ts`,
`test/search/golden.test.ts`, `test/fixtures/search/{catalog.ts, generator.ts}`, `test/load/search.ts`. Edit
`storefront/storefront.module.ts`, `storefront/application/storefront-catalog.service.ts`,
`storefront/application/storefront-quotes.ts` (`pricedSellable`), `storefront/contracts/storefront-public.contracts.ts`
(`relevance` sort), `storefront/README.md`, `src/common/contract/list-query.ts` (+ spec), `src/infra/rate-limit/{limiters.ts,
public-ip-limit.ts}` (+ spec), `deploy/compose.prod.yaml`, `deploy/Caddyfile`, `.env.example`, `docs/OPERATIONS.md` (secrets, keys
runbook, alerts, the set-scope note), `package.json` (`test:load:search`), and the generated `docs/route-manifest.*`,
`docs/slices/*`, `docs/contract/endpoints/*.md`, `docs/contract/openapi*.json`, `docs/COVERAGE.md`.
Acceptance (B): §4-§5 as written; every existing test passes unchanged; `bun run format`, then `bun run check` green.

**C. Console: Sonnet.** Files of §6. Acceptance: `npm run typecheck`, `npm run lint`, `VITE_API_MOCKS=false npm run build`,
`npm test`. **S. Storefront: Sonnet; `search-combobox.tsx`, `search-enhancer.tsx` and `lib/search/suggest.ts` are HARD (Opus
reviews line by line).** Files of §7 (`components/ui/search-input.tsx`, `components/search/*`, `components/layout/{store-header.tsx,
store-header-frame.tsx}`, `components/store/service-list.tsx`, `lib/search/*`, `lib/api/{server.ts, store-query.ts}`,
`lib/catalog-facets.ts`, `lib/i18n/messages/search.ts`, `app/robots.ts`, `app/[lang]/(store)/services/page.tsx`, the e2e files)
plus `SF/lib/api/types.ts` and `npm run gen:api` (after B2's OpenAPI), `SF/scripts/dev-backend.sh`. Acceptance: `npm run
typecheck`, `npm run lint`, `npm run test` (the lead runs `next build`, checks first-load JS grows by at most 2 KB gzip per route
and the combobox chunk loads only after interaction, and runs Playwright).

No hand-written file is in two slices (generated documents are regenerated by B1 and again by B2, never hand-merged). Contract and
lead steps after the merges: replace `B-TBD store-search` by **B221** (public routes: the suggest and results shapes, English only,
no price in the index, fallback, analytics rule, noindex), `B-TBD admin-search` by **B222** (the console tools, permissions, audit,
the `locale` filter of `GET /admin/service-listings`), and add **B223** (`GET /store/v1/services`: with `q` on English the order
comes from the search engine and `relevance` is the default sort while `q` is set; typo and synonym matches appear; with a price
sort or bounds the set is the best 1000 matches and `x-search-truncated` says more matched; the array shape and filters are
unchanged); append them to `extra` of `lead-decisions.json` (indexes 115-117); write decision 038 and the CLAUDE.md clause; `bun run
routes:build && contract:docs && docs:openapi && coverage:build && check`; console `npm run mocks:live`; storefront `gen:api`.

**Handoff notes (the lead, after the merges).** `STOREFRONT-BACKEND-HANDOFF.md`: a new **§17 "Search (feature 29)"**: the two
routes with one example each, the limiter (1200 a minute for suggest), English only and what `/ar` does, the price rule ("prices in
suggestions are the card price without tax"), `engine` and the fallback behaviour, the facet counts and labels replacing
`matchesQuery` on q pages, the analytics rule (page 1, no filters, no prefetch), `apiVisitorGet` for every q read, recent searches
stay in the browser, "never call Typesense from the browser"; the `/services?q=` note (B223); the status table.
`STOREFRONT-HANDOFF.md`: the banner's change list points to §17 and its catalog section notes that q pages use `/store/v1/search`.

## 10. Resources, cost, owner questions

Indexed text is **at least** 0.5 KB a service (title, codes, joins, facets; display fields are not indexed); a service with 200
models, 100 codes and 60 joins carries several KB, so step 0 measures the average on the owner's DB and sizes `mem_limit` from it.
The terms collection adds about 10 phrases a service after deduplication. RAM by the 2-3x rule of the Typesense docs, plus about
20 MB for the process; a rebuild doubles the services part while two collections live (orphans are dropped first, so never three).

| Services | Index RAM (services + terms) | Peak during rebuild | Disk (data dir, incl. uncompacted drops within 24 h) | CPU | `mem_limit` |
|---|---|---|---|---|---|
| 10 000 | about 30-60 MB (floor) | about 100 MB | about 50 MB + up to 100 MB | 2 shared vCPU, idle most of the time | 512 MB |
| 100 000 | about 250-500 MB (floor) | about 0.8 GB | about 0.5 GB + up to 1 GB | 2 vCPU; a rebuild about 1-3 minutes | 1.5 GB (default; raised if step 0 measures more) |
| 1 000 000 | about 2.5-5 GB (floor) | about 7 GB | about 5 GB + up to 10 GB | 4 vCPU recommended; reconcile hourly | own host, or rebuild in place with a short outage (fallback serves) |

Cost: no licence fee (GPL-3.0, unmodified server, so nothing to publish); the only cost is the host's RAM and disk. Today's shop
(14 listings in the seed, 1142 supplier services in the owner's DB) sits deep in the first row. Embeddings were left out (a further
2-6 GB).

**Owner questions (defaults applied; none blocks the work):**
1. Which boxes use the engine? Default: **the shop header and the results page on English pages only**; the merchant portal,
   REST v1, Dhru and the console keep the database search (merchant prices are personal and recorded).
2. Arabic pages until Arabic is switched off? Default: **today's database search, no completion box**.
3. Prices in the suggestion list? Default: **yes, the shop price in the visitor's currency, before tax** (the same for every
   visitor; never stored in the engine).
4. Popular searches on an empty box? Default: **automatic**: at least 5 different visitors on each of 3 days, only words the catalog
   knows, and staff can hide a term.
5. Who edits synonyms and pins? Default: **staff with `storefront:update`**; "Rebuild index" `storefront:publish`; the report
   `storefront:read`; every change audited.
6. The starting synonym list (frp, icloud, unlock, imei check, kg lock)? Default: **approved as listed in §4.6**.
7. Pins apply where? Default: **the shop only**.
8. The "no results" report? Default: **kept 180 days, counts per day and term only (and an estimate of distinct visitors, never an
   IP); anything with more than 5 digits, an `@` or a link is never stored**. Clicks are not recorded.
9. Someone pastes an IMEI into search? Default: **offer "Check IMEI …"** instead of searching.
10. Model numbers? Default: **from the titles, the internal service names' codes, the model options and synonyms; matched while
    typed; no typo tolerance on codes** (SM-A525F never returns SM-A526F).
11. Hosting? Default: **one Typesense on the same server, 1.5 GB memory limit, writes stop at 85 % disk**, the database search when
    it is down.
12. "Nearby" services? Default: **word similarity plus popularity, no AI embeddings** (no extra RAM or paid calls).
13. Typesense version? Default: **30.2 now**; v31 later as a small upgrade task.
14. Enter in the box? Default: **the results page, unless a suggestion is highlighted with the arrows**; on phones a tap on the arrow
    fills the box.
15. Internal service names (`services.name`, never shown to visitors) searchable? Default: **no; only the model codes found in them**.
16. Search result pages in Google? Default: **no (`noindex`); category and service pages stay indexable**.

## 11. Review against the code, and approval

Checked in the code: the listing schema and the public list contract (`SERVICE_LIST_QUERY`, sorts, filters, search fields); the
sellable rule and `StorefrontQuotes` (`listedSellable`, `priced`, `price`) and `listedServiceIds` (any locale); the writers of §4.5
by class and method (`InventoryStock.claim`/`sell`, `ServicePartsService.replaceOptions`, `GroupPriceAdminService.replace`'s
delete-and-insert, the group delete's `dropGroupFromCategories`); the outbox conventions and limits (`outbox-payload.ts`) and the
queue table (`docs/queues.md`, 11 queues); `MAX_PRICED_IDS`; `OutboundHttp`'s limits and `allowPrivateNetwork`; the limiter table,
`publicLimiterFor` and the `request.ip` key; `PermissionsCatalog` (derived from contracts) and the existing storefront permissions;
`AUDIT_ENTITY_TYPES`; `CORE_COMPONENTS` and `INDICATORS`; the 409/503 codes (`CONFLICT`, `JOB_ALREADY_RUNNING`, `UNAVAILABLE`);
the map-additions row shape (admin rows carry the permission as the auth text) and the groups of `GET /store/v1/services`
(`catalog`) and `PATCH /admin/service-listings/:id` (`storefront`); `lead-decisions.json` (`extra` 115, last B219); migrations end
at 0032; `compose.yaml`, `deploy/compose.prod.yaml` (no `mem_limit` precedent) and `deploy/Caddyfile` (URI and Referer logged); the
console's Storefront tabs; the storefront's header, search input, list and facet files, `lib/api/server.ts` and `robots.ts`. Read in
current docs: Typesense 30.2 synonym and curation sets, curation `remove_matched_tokens`, typo and drop-token thresholds, text-match
bucketing, API key actions, server flags. Not verified (step 0 or B1 proves them): the image's `curl`, a `collections` regex on
keys, the shape of a failing sub-search in `multi_search`, `filter_curated_hits` with filters, `synonym_prefix` with
`synonym_num_typos`, the disk-refusal status, the memory flag and cgroups, Caddy `multi_regexp`, Bun with long `importJsonl` bodies
through `OutboundHttp`, and whether the console's System health lists components generically.

**Review notes** (two adversarial Opus reviews, 2026-11-15; every must-fix of both is applied above; these lines record the
should-fix items taken differently or left out, with the reason):
- Suggest fallback "only from 3 characters, cached 30 s": not needed; the suggest fallback no longer queries services at all (§5.5).
- `priceRange` "cached 30 s per (q, filters, currency)": computed on page 1 only and not cached, because `CatalogPriceVersion` is
  lossy (fact 5) and a cached span could show a price that changed; the page-1 cost equals today's site-side span over 1000 cards.
- `/services?q=` price sort "keep 10 000": a 10 000-id read is 40 sub-searches per request; the set is the best 1000 matches,
  stated in B223 with `x-search-truncated`.
- Model codes from the TAC catalogue (`model` ↔ `marketingName`): deferred to a later B-entry; the TAC table is IMEI recognition
  data with no link to services today.
- `country_key` dropped from the schema: `country` is already a normalised ISO-2 code (fact 8), so a second field adds nothing.
- The suggest card cache is taken with a 30 s TTL only (display text, no money, no decision); `searchableIds` and prices stay per
  request, which keeps "a stale hit is dropped, never shown" exact.

Approved by Opus 5.5 (planner), 2026-11-15, after two adversarial reviews
