# 038: Public storefront search on Typesense

Status: accepted, 2026-11-16 (feature 29, planned by Opus 5.5 after two adversarial reviews, approved by the lead; plan
`docs/briefs/29-search-typesense.md`). Builds on decisions 020 (outbox), 023 (outbound HTTP), 035 (routes beyond the map) and 036
(production deploy). Spec entries B221-B223.

**Context.** The shop's search was an ILIKE filter on the listing list: no completion, no typo tolerance and no suggestions while
the visitor types. The owner asked on 2026-11-15 for a search box that completes words and phrases from the catalog and suggests
the nearest services, English only (Arabic will be switched off on the website), and chose Typesense after Meilisearch and a
Postgres-only search were compared; the catalog is expected to grow large.

**Decision.**
- **Engine.** Typesense **30.2**, self-hosted, one node, image pinned by digest, on the internal network only. It serves the
  **public storefront search in English**: the header combobox (completions, services, ready filters) and the results page. The
  merchant portal, REST v1, Dhru and the console lists keep their Postgres search (machine contracts; personal prices).
- **Postgres is the truth; the index is derived.** Documents hold only what a public visitor may see and no price. Any document
  can be rebuilt from Postgres at any moment; a nightly full rebuild into a new collection with an alias swap, a reconcile every
  15 minutes and an admin "Rebuild index" make a lost or stale index harmless. Synonyms and pins live in Postgres tables and are
  pushed to Typesense; nothing is edited in Typesense by hand. The data volume is not backed up; the API keys are recreated from
  the secret store by an idempotent script (plan §3.3), a required step after any wipe.
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
  page fail. The suggest fallback makes no service query (plan §5.5).
- **Client.** Our own small fetch client over `OutboundHttp` (decision 023: explicit timeouts, no hidden retries;
  `allowPrivateNetwork: true`). The official `typesense` package is not used (it brings axios and its own retry loop). No browser
  talks to Typesense: every request goes through `/store/v1/search*` (one origin, our rate limits, prices joined server-side, the
  key stays on the server).
- **Secrets.** The bootstrap key lives only in the Typesense container and the operator's secret store. The worker uses an
  indexer key, the API a search key (`documents:search`, `aliases:get`, `collections:get`), both with fixed values from the
  secret store, created by `bun scripts/search-keys.ts`, limited to the environment's collection prefix; each container gets only
  its own key.
- **Analytics** are ours, in Postgres, aggregated per day and term with a distinct-visitor estimate (a HyperLogLog over a daily
  salted hash, never an IP), filtered for personal data (plan §5.6). Typesense analytics stay off.

**Why not Meilisearch.** Its built-in analytics are a Cloud feature and sharding/snapshots are in the BUSL edition; Typesense's
server is GPL-3.0 with one edition, synchronous writes (visible when the call returns) and curation with time windows. Meilisearch's
disk-backed index would only matter above about 1M services, far beyond the plan (plan §10).
**Why not Postgres only** (`pg_trgm`, `tsvector`): no prefix-plus-typo ranking per field, no synonym sets or pins, no facet counts
over typo-tolerant matches, and the autocomplete load (a request every 150 ms per typing visitor) would land on the database that
holds the ledger. Postgres stays the fallback (results only; suggest falls back without a service query).
**Rejected.** Typesense Cloud (pay per search; catalog text leaves); embeddings for "nearby" (2-6 GB RAM for a built-in model, or a
paid external call per document; short service names gain little); the browser querying Typesense with a scoped key (bypasses our
limits, needs CORS and a Caddy route, the key's filters are readable); the official JS client (see Client).

**Consequences.** `backend/CLAUDE.md` "Architecture" gets one clause: "Search: Typesense holds derived, public, price-free documents;
writers of indexed facts write an outbox event; never read search results as truth." A Typesense outage degrades search only.

**Engine checks (step 0, 2026-11-16).** Recorded in the plan's §11. The ones that shaped the code: `enable_typos_for_alpha_numerical_tokens`
has no effect in 30.2, so the title is searched with no typos and a digit-free `title_words` copy carries the typo tolerance (no
typo-searched field holds a token with a digit: SM-A525F never finds SM-A526F); the memory refusal flag does not work under a cgroup
limit (the container's memory limit, restart and an alert carry the rule); a disk refusal is a 422 `OUT_OF_DISK`; the engine keeps
no request or slow-search log, because a slow `multi_search` is logged with its body, which holds the typed query.
