# Storefront search (`src/modules/storefront/search`)

English search of the public shop on Typesense 30.2 (feature 29, decision 038, plan `docs/briefs/29-search-typesense.md`): the shop
header completes words and phrases and suggests the nearest services while a visitor types, and the results page lists the matches
with facet counts. Postgres is the truth; the index holds derived, public, English, price-free documents, and **every hit is
re-checked in Postgres and priced there** before it is shown. A stale hit is dropped and counted (`search_stale_hits_total`).

Slice B1 built the index side (documents, sync, rebuild, reconcile, terms; `search-index.module.ts`, `search-worker.module.ts`,
`application/search-sync.ts` and its neighbours); slice B2, the API side described here (`search-http.module.ts`).

## Routes

| Route | What |
| --- | --- |
| `GET /store/v1/search/suggest` | the ghost text, up to 6 completions, up to 6 services (then nearby ones) with Postgres prices, up to 4 filter chips, "did you mean", the popular searches for an empty text, an IMEI intent. Limiter `search-suggest` (1200 a minute per address). |
| `GET /store/v1/search` | the results page: the exact cards of `GET /store/v1/services`, facet counts (each group ignores its own selection), the price span (page 1, at most 1000 matches), "did you mean". Limiter `ip`. |
| `GET /store/v1/services?q=` | unchanged array shape and `x-total-count`; on an English list the match set and the order come from the engine (`relevance` is the default sort while `q` is set), with a price sort or price bounds over the best 1000 (`x-search-truncated`). `locale=ar` stays the database search. |
| `/admin/search/*` | the console tools: synonyms, pin rules, hidden popular terms, the report, a preview, the index status and "Rebuild index" (`storefront:read`, `storefront:update`, `storefront:publish`; every write audited, with its outbox event). |

Both public routes send `x-search-engine: typesense|fallback`.

## One request

`SuggestService` / `ResultsService` / `StorefrontCatalogService.list` → `SearchMatches` or the suggest engine part → `SearchEngine.run`
(circuit, metrics, fallback) → `TypesenseClient` (one `multi_search`) → `SearchResolver` (re-check with `SearchableIds`, English listing,
price with `StorefrontQuotes.pricedSellable`) → cards (`StorefrontCatalogService.cards`, the same code as the list).

- **Suggest engine part** (ghost, completions, candidate ids with matched tokens, filter chips, did-you-mean) is cached 30 s per typed
  text; prices, availability and the re-check are read on every request, never cached. The display part of a card is cached per service
  (30 s). Both go with the `search` cache version, which moves after a synonym or pin push.
- **Fallback.** Engine off (`SEARCH_ENABLED=false`), circuit open, not ready (no alias of the running schema version), timeout, any
  failure of the call, a failed sub-search or a malformed body: the routes answer 200 with `engine: 'fallback'`. The suggest fallback
  makes **no service query**: it answers only the popular phrases (read from the cache, never loaded) that start with the typed text. The
  results fallback is the database search (`StorefrontCatalogService.list`, `engine: 'skip'`) with the same filters, `facets: null`.
- **IMEI intent.** 15 digits with a valid Luhn check, or 16, after removing spaces, dashes, dots and slashes: no search runs, nothing is
  counted, the answer carries `intent: 'imei'`.
- **Statistics** (`SearchTermsCounter`): only page 1 with no filter besides `q`, never a prefetch or a bot, never a term with an IMEI, a
  phone number, an email address, a link or five digits in a row; `HINCRBY` per UTC day plus a HyperLogLog of `HMAC(daily salt, IP)`;
  no address is stored. The worker's `search_terms_flush` copies them to `search_terms_daily` (180 days).
- **Popular searches** (the empty box) are the searched terms with at least 5 distinct visitors on each of at least 3 days in 30, fewer
  than half without results, not hidden by staff, whose phrase is a document of the terms collection (the catalog's words); with none,
  the first four category names. Cached 10 minutes; a hidden term deletes the key.

## Ranking: the final values (tuned on the golden set)

All numbers live in `domain/ranking.ts`; `test/search/golden.test.ts` (58 tests over the 60 cases of plan section 8: the fixture
catalog of 60 services plus 5 000 generated distractors) is what they were tuned against.

| Parameter | Value | Why |
| --- | --- | --- |
| `query_by` / weights | `title` 10, `title_words` 9, `codes` 10, `joins` 8, `models` 6, `brand` 6, `carrier` 5, `networks` 4, `country_names` 5, `category` 4, `summary` 2 | plan 5.2, unchanged |
| `num_typos` | `0,2,0,0,0,1,1,1,1,1,1` (services); `0,2,0,0,0,2,2,2,2,2,2` (nearby) | no typo on a field that may hold a model code (SM-A525F never finds SM-A526F); the typo-tolerant copy is `title_words` |
| `prefix` | true on every field but `summary` | model numbers match while typed (`a525`, `sm-g99`) |
| `max_candidates` | 16 | plan 5.2, unchanged |
| `drop_tokens_threshold` | 0 (suggest services), 6 (nearby), 1 (results), 0 (completions) | plan 5.2 / 5.3, unchanged |
| `typo_tokens_threshold` | 6 on the nearby search, engine default (1) elsewhere | plan 5.2, unchanged |
| `synonym_num_typos` | **0** (plan: 1) | with 1, `uk unlock` matched the synonym phrases `sim unlock` and `network unlock` through their first word, dropped the `uk` constraint and returned every unlock service (golden case 44). A typo inside a synonym word is still found through `title_words` |
| terms `num_typos` | 1, **0 when the typed text has a digit** | a completion never turns `sma527f` into `sm-a525f` |
| `sort_by` | `_text_match:desc,_eval(in_stock:true):desc,popularity:desc`; completions `_text_match:desc,weight:desc,length:asc` | plan 5.2: no bucketing, text match decides |

"Did you mean" (`domain/did-you-mean.ts`) is plan 5.4 with two additions the golden cases need: a hit with no highlighted token (it
matched through the summary or the networks) does not count among the top hits that must agree on a replacement (case 2), and a run
of query words within one typo of a multi-word synonym term is a synonym typed with a slip, never "corrected" (case 25; a single
word such as `iclod` still is, case 6).

The golden terms collection is built from the fixture catalog only: phrase weights are sums of sales, and with thousands of
distractors a generic phrase (`samsung galaxy`) always outweighs a specific one (`samsung frp`), which is the right behaviour for a
real shop but not what case 51 describes. The load script builds terms from every service.

## What is not here

- Prices: never in the index; `search-resolver.ts` and `StorefrontQuotes` price from Postgres on every request.
- Merchant, REST v1, Dhru and console searches: unchanged (merchant prices are personal and recorded).
- Arabic: `/ar` keeps `GET /store/v1/services` and the database search until Arabic is switched off.

## Postgres queries per suggest

A warm suggest (engine part and cards cached) runs 12 Postgres queries: the retail group, the currency, the searchable rule (3: sellable,
retail price row, English listing), `RetailPrices.quotes` (6: it re-reads the service, the groups, the group prices and the pricing
rules), and the stock flag. The plan's target of 4 is not reachable with catalog's public reads; reaching it needs a catalog method that
answers "sellable, priced and in stock" for a page of ids in one query (a later B-entry). `test/integration/search-api.test.ts` asserts the
measured 12 so a regression shows.

## Trying it locally

The owner's development database has no English listing of its own, so its index starts empty. `bun scripts/seed-search-demo.ts` adds
the ~60 English services of the golden fixture (each with a retail price and a listed English listing, service codes `DEMO-SEARCH-…`)
and writes `catalog.services_changed`, so a running worker indexes them within seconds; `bun scripts/search-rebuild.ts` then rebuilds
the terms collection (phrase completions are built by the rebuild, not by each sync). `--remove` takes the demo away again (a demo
service with an order is archived instead). Development only: the script refuses production.

## Load test (`bun run test:load:search`, not in `check`)

The lead runs it once before the merge and records the table here (targets: suggest p95 <= 50 ms, engine part <= 15 ms, results p95
<= 120 ms, price-sorted p95 <= 300 ms, 100 suggest requests a second for 60 s from 20 addresses with no error, an edit searchable
within 5 s at p95, a full rebuild of 100 000 services under 5 minutes and a reconcile under 2).

Run of 2026-11-16 by the lead (`--count 10000 --seconds 60 --rate 100 --ips 20 --edits 20 --full 100000`, the dev machine: WSL,
16 vCPU, Typesense 30.2 on the shared dev node with a 768 MB limit). Every target is met; the one number above its plan target is the
Postgres queries per warm suggest (12, plan target 4: `RetailPrices.quotes` alone runs 6), which the latency already absorbs.

| Measure | Result |
| --- | --- |
| Postgres fill (10 000 services) | 1.5 s |
| Rebuild (10 000 services) | 1.0 s |
| Terms build | 0.8 s |
| Reconcile (10 000 services) | 0.8 s |
| Typesense memory allocated / resident | 170 / 250 MB |
| Suggest at 100/s from 20 addresses for 60 s: p50 / p95 / p99 | 7.3 / 10.4 / 14.4 ms (target p95 <= 50), 0 errors |
| Results p50 / p95 | 35.0 / 60.6 ms (target p95 <= 120), 0 errors |
| Price-sorted results p50 / p95 | 44.7 / 95.9 ms (target p95 <= 300), 0 errors |
| Engine part (one plain search) p95 | 1.4 ms (target <= 15) |
| Postgres queries per warm suggest | 12 (plan target 4) |
| Edit to searchable (20 edits, no relay wait) p50 / p95 | 29.1 / 80.0 ms (target p95 <= 5000 with the relay) |
| Postgres fill (100 000 services) | 19.1 s |
| Full rebuild (100 000 services; target < 300 s) | 9.8 s, process peak 546 MB |
| Full reconcile (100 000 services; target < 120 s) | 7.3 s, process peak 542 MB |
| Typesense memory allocated / resident after the full run | 193 / 283 MB |

## Tests

`domain/*.spec.ts` (pure rules), `application/search-engine.spec.ts` (the fallback), `test/integration/search-api.test.ts` (routes, fallback
on every kind of failure, statistics, limiter, console tools), `test/search/golden.test.ts` (the relevance golden set),
`test/integration/search-sync.test.ts` (B1: the index).
