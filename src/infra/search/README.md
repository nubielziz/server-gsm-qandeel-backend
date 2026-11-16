# Search engine (`src/infra/search`)

The client of the storefront search engine, Typesense 30.2 (feature 29, decision 038). Typesense holds derived, public,
price-free documents; Postgres is the truth and every hit is re-checked there. The storefront module owns what is indexed and
when (`src/modules/storefront/search/`); this folder only talks to the node.

| What                                                                   | Where                         |
| ---------------------------------------------------------------------- | ----------------------------- |
| `TypesenseClient`: every call, parsed and checked                      | `typesense-client.ts`         |
| `SearchUnavailable`, `SearchNotReady`, `SearchRejected`                | `search-errors.ts`            |
| `SearchCircuit`: the API's breaker (3 failures in 30 s, open 15 s)     | `search-circuit.ts`           |
| `SearchHealthIndicator`: `/health` within 1 s, no resource error, alias | `search-health.indicator.ts`  |
| `SearchMetrics`: the `search_*` and `typesense_*` metrics              | `search-metrics.ts`           |
| `SearchModule.forRoot({ role })`: one client per process with its key  | `search.module.ts`            |
| Wire types of the API                                                  | `typesense.types.ts`          |

## Behaviour

- **No official client.** Every call goes through `OutboundHttp` (decision 023) with `allowPrivateNetwork: true` (the node is on
  the internal network), an explicit timeout (search: `SEARCH_TIMEOUT_MS`, the suggest passes `SEARCH_SUGGEST_TIMEOUT_MS`; import
  120 s per batch of 500; export 60 s with a 64 MiB limit; `/health` 1 s; others 5 s) and no retry. The key travels only in the
  `X-TYPESENSE-API-KEY` header; nothing here logs, and `OutboundHttp` logs the host only (never the query or the body).
- **Keys per process** (`SEARCH_KEY_ROLE`): the API holds `TYPESENSE_SEARCH_KEY` (`documents:search`, `aliases:get`,
  `collections:get`), the worker `TYPESENSE_INDEXER_KEY`. A production process with search on refuses to start without its key;
  outside production both use the node's development key. `bun scripts/search-keys.ts` creates the keys (fixed values from the
  secret store, scoped to `<prefix>.*`).
- **Every answer is checked.** A search must carry `found` and `hits`; a multi-search answers 200 even when an entry failed (step
  0: `{ code, error }` in `results[i]`), so any failed or malformed entry fails the whole call; an import answers one line per
  document without an id, so refused lines are mapped back by position (`{ ok, imported, failed: [{ id, error }] }`) and a line
  refused for lack of resources fails the batch.
- **Typed failures.** Connection, timeout, 5xx, 401/403 and a write refused for disk (422 `Rejecting write: running out of
  resource`) are `SearchUnavailable` (`network`, `timeout`, `server`, `auth`, `resources`); 404 on an alias or collection is
  `SearchNotReady`; any other 4xx (also a field the schema lacks) is `SearchRejected`. A body that does not parse is
  `SearchUnavailable('server')`.
- **The circuit** (API only): opens at once on `server`, `auth`, `resources` and `SearchNotReady`, after 3 other failures within 30
  s; one probe after 15 s. While open every search is the Postgres fallback without a call, which also keeps `OutboundHttp`'s
  warning lines to about one per 15 s while the engine is broken.
- **Health.** The `search` indicator (non-critical: search falls back) is registered by the storefront's `SearchIndexModule` while
  `SEARCH_ENABLED` is on, because the alias it checks (`<prefix>services_v<N>`) carries the schema version the storefront owns.
  With search off, `GET /health` is exactly as before and the System health component `search` stays `unknown`.
- **Shutdown.** `fetch` keeps no connection to close.
