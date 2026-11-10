# 035: Routes beyond the map

Status: accepted, 2026-11-10 (lead, before features 20-23). Builds on decisions 009 (contract tests) and 018 (access).

**Context.** The API design map (`reference/gsm-map/data/*.mjs`) lives in the console repository and is read-only: two
repositories regenerate their documents from it. Route parity, the console-tag check of `routes:check` and the pending list
refused every route outside the map; only outgoing events had an allowance (`BACKEND_EVENTS` in
`test/contract/route-parity.test.ts`). Four features (20-23: merchant management, customer wallet, notification centre and
the rest of the website's needs) add about 40-60 routes between them and run in parallel. One pinned total per registry
(274 rows, 382 endpoints, 123 error codes, 69 tables, 12 modules, ten queues, 269 console functions) made every one of them
edit the same numbers and conflict with the others.

**Decision.**
- **Rows, not an allow-list.** A route the map lacks is a row in the map's own row shape, in
  `scripts/map-additions/<feature id>.mjs` (`export const rows = [R(...)]`, `R` from `scripts/lib/map-additions.mjs`). Beside
  the map's fields (surface, group, method, path, Arabic sentence, auth text, stage, tables, `ops` for CRUD) a row carries
  `en` (the English sentence), `module` (the owning module), `spec` (`B<n>`, or `B-TBD <slug>` until the lead numbers it at
  merge) and, when the console calls the route, `successStatus` (an object per ops letter for a CRUD row). Additions are HTTP
  routes only; outgoing events keep `BACKEND_EVENTS`. The stage is the feature's number; 99 belongs to the tooling test.
- **One loader, guards at load time.** `scripts/lib/map.mjs` appends the validated additions to the map's rows
  (`routes = [...mapRoutes, ...additions]`), so every tool that reads the map sees them: manifest, slices, coverage,
  contract documents, route parity, Turnstile parity, `pending.ts`, the console-tag check and, through the contract
  registry, OpenAPI. A malformed row fails with its file, row number and row key. An addition can never repeat a map row,
  override a map endpoint (parameter names do not matter: `:id` and `:clientId` are one route) or be added twice. No new groups
  and no new auth vocabulary: a combination the map never used needs a line in `ACCESS` named in the feature's plan.
- **The row names its module.** The matchers of `scripts/module-map.mjs` decide for map rows only; a row's `module` decides
  alone. A table beyond the map is an `additionalTables` entry of its module, and a row may list it.
- **Counts.** The map's own numbers stay pinned (`EXPECTED` in `scripts/lib/map.mjs`, compared with map-only counts);
  additions are counted on top. The manifest keeps `counts.rows` and `counts.endpoints` as totals and adds `counts.map` and
  `counts.additions`. With no additions every other generated document is byte-identical.
- **`successStatus` is a status source.** The console accepts any 2xx, so the success status of a route the extraction has no
  record for comes from its row (`loadSuccessStatuses` reads both and refuses a disagreement). `routes:check` demands it as
  soon as a console function carries the route's `@route` tag.
- **Access and permission parity.** A built contract must have the access and the permission of its manifest row
  (`test/contract/lib/manifest-parity.ts`): a concrete permission is equal, no permission stays none, `area:*` on a CRUD
  endpoint means `area:read|create|update|delete` by operation (the console's `crudPermission` uses the same words), and on a
  single route `area:*` or one action of that area. Three contracts deviate in access on purpose and are listed with their
  B-entries: `POST /admin/auth/2fa` and `POST /admin/auth/2fa/setup` (B1, B2) and `POST /client/auth/2fa` (B125); the map says
  `public`, the pre-2FA session is mandatory. A stale exception fails.
- **Computed totals.** A pinned number that several features change becomes an equality with its source: the error catalog
  against `error-codes.md`, the tables of the migrations and of the Drizzle barrel against the module map, the modules against
  their schema imports, the queues against `QUEUE_NAMES`, the console functions against the extraction's own count and the
  manifest's `frontendRoutes`. Left pinned on purpose: the map's numbers, the 12 system ledger accounts (one owner), the
  single-module vocabularies (order event types, alert metrics, countries, session setting keys, queue names) and the
  append-only lists the lead merges (error catalog and `BACKEND_CODES`, `AUDIT_ENTITY_TYPES`, `ADDITIONS` of the schema test,
  cache key families, `docs/queues.md`, `MULTIPART_ROUTES`).
- **Tests of the tooling.** `test/unit/map-additions.test.ts` runs the generators over sample rows
  (`test/unit/fixtures/map-additions/sample.mjs`, stage 99) in a temporary docs folder and a fake console. The two environment
  variables it uses (`GSM_MAP_ADDITIONS_EXTRA_DIR`, `GSM_DOCS_DIR`, read in `scripts/lib/paths.mjs`) exist only for it.

**Rejected.** Editing the map: read-only, and two repositories regenerate from it. A bare allow-list of keys in the parity
test: it loses the English text, the module, the slice, the coverage row and the endpoint document, and lets a route differ
from the contract silently.

**Consequences.** The console's own manifest stays the map's (its coverage report lists a tag of an addition as unknown, which
is accepted). B-numbers are given at merge: the lead replaces each `B-TBD <slug>` and regenerates. Generated files
(`route-manifest.*`, `slices/*`, `COVERAGE.md`, `contract/endpoints/*.md`, `openapi*.json`) still conflict textually between
branches; they are never hand-merged: take `main`'s copy and regenerate (`bun run routes:build`, `contract:docs`,
`docs:openapi`, `coverage:build`). `src/` never imports the loader, so the API and the worker never execute an additions file.
Never edit `reference/`, add a `mapConflict` to an extraction record (it renumbers B1-B104) or rename an existing key (the
storefront's types use the `operationId`).
