# W0 — parallel-safe extension tooling (routes beyond the map, computed counts)

Plan by Fable 5.2 (feature architect), 2026-11-10. **Status: approved for implementation** (section 14). Read `_common.md`
first, but ignore its stale lines about the frontend cwd and Serena (this feature fixes them).

W0 lets features 20-23 run in parallel without editing the same numbers and gives a route the map does not have a home
(lead decisions L1 and L2). It is **tooling, tests and docs only**: no HTTP route, no table, no migration, no runtime
behaviour, no console change. Size: small. Keep it minimal and keep `bun run check` green.

- Worktree: `/home/saifi/gsm-project/backend-w0`, branch `feat/backend-w0` (same commit as `main`, `bd32229`). Work only there.
- Tests: the untracked `.env.test` there (`gsm_w0_test`, Redis DB 10 on both roles). Never run `docker compose`,
  `db:migrate`, `db:seed`, `db:reset`, `setup`, `src/main.ts` or `scripts/ci.sh` in the worktree; never touch :3000, :3100,
  the databases `gsm` and `gsm_storefront`.
- Memory is tight: run targeted files while developing (`bun test --timeout 15000 <files>`), heavy runs through the slot
  lock (`bash scripts/with-slot.sh bun run typecheck`; `bun run lint` and `bun run test` take the slot themselves), and
  `bun run check` once at the end, in the foreground.
- Out of scope: any feature route, the console repo (`../frontend-admin`), the storefront, anything under `reference/`
  (the map is a symlink into the console repo and is read-only), `PROGRESS.md` and B-numbers (the lead's).

## 1. What exists today (inspected in the code; `file:line`)

The whole route pipeline is: map → `scripts/lib/map.mjs` → `scripts/lib/manifest.mjs` (`buildManifest`) →
`docs/route-manifest.json` → everything else reads that JSON.

- `scripts/lib/map.mjs:4-8` imports the map's `routes` statically and re-exports them; `:11` pins
  `EXPECTED = { rows: 274, endpoints: 382, tables: 66, scenarios: 13, surfaces: 9, moneyEvents: 13, accounts: 14 }`;
  `:14` `rowKey = "<s> <m> <p>"`; `:28-47` the auth vocabulary (`ACCESS`); `:55-63` `normaliseAccess` (throws on unknown
  auth text; flags `turnstile`, `idempotencyKey`); `:78-113` `expandRow` (a CRUD row gives one endpoint per ops letter).
- The map's row helper is `R(s, g, m, p, f, a, st, t, extra) => ({ s, g, m, p, f, a, st, t, ...extra })`
  (`reference/gsm-map/data/routes.mjs:53`): surface, group, method, path, Arabic text, auth text, stage, tables, extras
  (`ops`, `r`).
- `scripts/lib/manifest.mjs:56-116` `buildManifest()`: per row exactly one module from the matchers of
  `scripts/module-map.mjs` (`:70-71`, `modulesForRow` at `module-map.mjs:165-167`), an English sentence from
  `scripts/route-descriptions.en.mjs` (`:72`), the console function with the same `@route` tag (`:74`); then the counts
  against `EXPECTED` (`:80`), duplicate endpoint keys (`:81-85`) and **the console-tag check** (`:87`:
  `frontend @route X is not in the map`).
- Readers of the JSON only: `scripts/build-coverage.mjs:72-73`, `scripts/build-contract-docs.mjs:12,65,217`,
  `scripts/gen-contract-pending.mjs:22`, `test/contract/lib/inputs.ts:34-36` (route parity, Turnstile parity, shape
  parity, fixtures). `scripts/build-route-slices.mjs:44` calls `buildManifest()` in memory.
- OpenAPI is built from the contract registry, never from the manifest (`scripts/gen-openapi.ts:47`,
  `src/modules/platform/docs/openapi-documents.ts`; `test/integration/openapi.test.ts:53` "documents every route of the
  contract registry").
- `test/contract/pending.ts:11-20` is empty: all 382 map endpoints are built.
- The contract snapshot already carries `access` and `permission` (`test/contract/lib/snapshot.ts:19-20`,
  `lib/dump-app.ts:41-42`); `route-parity.test.ts:83-104` compares method, path, surface and the Turnstile flag only.
- Nothing tests the generator scripts today (no test imports or spawns `build-route-manifest`, `build-route-slices`,
  `build-coverage` or `build-contract-docs`).

**Where the code contradicts the discovery report (the code wins):**
1. "Every tool keeps working unchanged" is not fully true. Three tools need one small edit each, once, in W0:
   (a) the module matchers would give an addition zero or two owners (`manifest.mjs:70-71`); (b) slices look table owners
   up in the map's tables only (`build-route-slices.mjs:17-29,52`), so an addition that lists a table of
   `additionalTables` would be written as a foreign table with no owner; (c) the endpoint docs print "**Map**" for every
   row (`build-contract-docs.mjs:239`) and take the success status only from an extraction record (`:242`).
2. A plain "contract access = manifest access" test would fail today: three contracts deviate on purpose
   (`POST /admin/auth/2fa`, `POST /admin/auth/2fa/setup`: map `public`, contract `staff-session`, MISMATCHES B1 and B2;
   `POST /client/auth/2fa`: map `public`, contract `merchant-session`, B125).
3. The Schedulers table of `docs/queues.md:489-503` misses **five** schedulers, not two: `fx-refresh`,
   `idempotency-purge` and the three supplier ones (`supplier-poll-tick`, `supplier-price-sync`,
   `supplier-balance-check`; `src/modules/suppliers/jobs/supplier-jobs.module.ts:13-17,34-55`).
4. One more pinned total exists that the report did not list: `test/contract/lib/compare.test.ts:545` (269 console
   functions).
5. LEAD-DECISIONS L1 lists OpenAPI among the tools that must see the additions: it needs no change (registry-driven).

## 2. Requirement → status → evidence

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1a | Additions files, loader appends them | missing | `map.mjs:4-8` static import only; no `scripts/map-additions/` |
| 1b | Counts = map numbers + additions, computed; map numbers pinned | missing | one pinned total, `map.mjs:11`, `manifest.mjs:80` |
| 1c | Module per row named by the row | missing | `manifest.mjs:70-71` uses matchers only |
| 1d | Description from the row | missing | `manifest.mjs:72` |
| 1e | Route parity, Turnstile parity, console-tag check, coverage, pending | follow the manifest once rows are loaded | `inputs.ts:34-36`, `route-parity.test.ts:63-66,96-104,136-144`, `manifest.mjs:87`, `build-coverage.mjs:72-79` |
| 1f | Slices | partial (table owner bug for `additionalTables`) | `build-route-slices.mjs:17-29,50-52` |
| 1g | `endpoints/<module>.md` | partial (label, success status) | `build-contract-docs.mjs:239,242` |
| 1h | OpenAPI | exists (nothing to do) | `gen-openapi.ts:47`, `openapi.test.ts:53` |
| 1i | Shape parity: `successStatus` beside the extraction | missing | `inputs.ts:89-96`; `shape-parity.test.ts:40-42` throws without a status; `fixtures.test.ts:19,65` reads the same loader |
| 1j | New tables through `additionalTables` | exists | `module-map.mjs:8-9,68,83,112`; `structure.test.ts:142`; `db-schema.test.ts:22` |
| 1k | Guards (no duplicate, no override, malformed fails) | missing (only `duplicate endpoint key`, `manifest.mjs:81-85`) | — |
| 1l | Fixture proof per tool; README; no feature rows | missing | — |
| 2 | Computed totals | pinned | `catalog.spec.ts:21` (123), `db-schema.test.ts:29,35,63` (69), `structure.test.ts:139` (12), `:146-149` (69), `queues.test.ts:64-66` (10), `compare.test.ts:545` (269) |
| 3 | Access and permission parity (G2) | missing | `route-parity.test.ts:83-104`; today 3 access deviations and 114 `area:*` rows (section 6) |
| 4 | Small fixes | each present | `lead-decisions.json:125-130` (B181 no `status`; `MISMATCHES.md:200` ends "undefined"); `test/contract/README.md:10`; `docs/briefs/_common.md:5-14,29,45-46`; `CLAUDE.md:71`; `support-templates.ts:1` ("Migration 0012", the spec reads `0016_support_tickets.sql` at `support-templates.spec.ts:86`); `docs/queues.md:489-503` |
| 5 | Docs (CONTRIBUTING section, CLAUDE sources line, decision 035) | missing | `CONTRIBUTING.md:48-87`, `CLAUDE.md:9-10`, `docs/decisions/` ends at 034 |

## 3. Architecture fit (what this feature does not have)

No module, contract (`defineRoute`), use case, transaction, repository, domain function, job, queue, outbox event, cache
key, audit action, setting, seed, permission, error code, migration or API change. No route is added or changed, so
there is nothing to list for request and response shapes, error codes, rate limits, Turnstile, CSRF or map-addition
rows. `src/` changes are one comment line and one spec line. No console change (W0 has no console worktree).

## 4. Design: the additions

### 4.1 The file and the row

One file per feature: `scripts/map-additions/<feature id>.mjs` (`20.mjs`, `21.mjs`; name `^[a-z0-9][a-z0-9-]*\.mjs$`).
It exports `rows`, an array. A row is the map's `R()` row plus four extras:

```js
// scripts/map-additions/20.mjs (example for the README; W0 commits no row)
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R('admin', 'clients', 'POST', '/admin/clients/:id/password-link', 'إرسال رابط تعيين كلمة المرور للتاجر', 'clients:security', 20,
    ['clients', 'auth_tokens', 'audit_logs'],
    { en: 'Send the merchant a link to set a password.', module: 'identity', spec: 'B-TBD merchant-password-link', successStatus: 204 }),
];
```

| Field | Meaning | Rule (a violation is an error naming the file, the row number and the row key) |
|---|---|---|
| `s` | surface | one of `admin`, `client`, `store`, `v1`, `hooks`, `system` (HTTP only; Dhru actions, supplier calls and outgoing events are not additions: events keep `BACKEND_EVENTS`, `route-parity.test.ts:20`) |
| `g` | map group of the surface | an id of `groups[s]` of the map (`routes.mjs:18-51`: `admin`, `client`, `store` have groups); `null` on `v1`, `hooks`, `system`. No new groups |
| `m` | method | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or `CRUD` with `ops` |
| `ops` | CRUD letters | only with `CRUD`: one or more of `L S C U D`, none twice |
| `p` | path | starts with `/`; segments as `define-route.ts:335` (`:name` or `[A-Za-z0-9._~-]+`), no repeated parameter; prefix of the surface (`/admin`, `/client`, `/store/v1`, `/v1`, `/webhooks`; `system` = none of them and not `/api/index.php`), mirroring `src/common/surface.ts:12-19`; a `CRUD` path ends in a fixed segment and has no `:id` |
| `f` | the sentence in Arabic (the map's language) | non-empty, one line |
| `a` | auth text in the map's vocabulary (`map.mjs:28-47`, or `area:action` / `area:*` on `admin`, a scope `area:action` on `v1`) | whatever `normaliseAccess` accepts for the surface; unknown text is an error |
| `st` | stage | whole number ≥ 0; a feature uses its own number (20, 21, …), which becomes its row in COVERAGE "By map stage" |
| `t` | tables touched | names of map tables or of any module's `additionalTables`; none twice; may be empty |
| `en` | the English sentence (what `route-descriptions.en.mjs` holds for map rows) | non-empty, one line |
| `module` | owning module | an id of `scripts/module-map.mjs`. It decides alone: the matchers are not consulted for an addition |
| `spec` | spec decision | `B<n>`, or `B-TBD <slug>` (`^B-TBD [a-z0-9]+(-[a-z0-9]+)*$`) until the lead numbers it at merge |
| `successStatus` | success status the console is promised | optional; required as soon as the console calls the route (section 4.3). Non-CRUD: one of 200, 201, 202, 204, 302 (302 only on `GET`). CRUD: an object keyed by ops letters, e.g. `{ L: 200, S: 200, C: 201, U: 200, D: 204 }` (keys ⊆ `ops`) |

Any other key is an error (it catches `sucessStatus`). A plain object with the same keys is equal to an `R()` call.
The auth vocabulary is not extended: a combination the map never used needs a line in `ACCESS` (`map.mjs:28-47`), named
in that feature's plan.

### 4.2 The loader and the guards

New `scripts/lib/paths.mjs` (no imports but `node:path`):
- `ROOT` (repository root), `docsDir()` = `GSM_DOCS_DIR` or `<ROOT>/docs`, `additionsDirs()` =
  `[<ROOT>/scripts/map-additions]` plus `GSM_MAP_ADDITIONS_EXTRA_DIR` when set. Both variables exist only for the tooling
  test; say so in the file header. The extra directory is loaded **after** the real one, never instead of it (so a
  key a feature leaves in `pending.ts` still exists in a test run).

New `scripts/lib/map-additions.mjs`. **It must never import `map.mjs` or `manifest.mjs`** (addition files import `R`
from it while `map.mjs` awaits them: a cycle would hang the loader); it receives what it needs as arguments.
- `R` (same body as the map's), `ADDITION_SURFACES` (surface → prefix or `null`), `SUCCESS_STATUSES`.
- `async readAdditionFiles(dirs, root)` → `[{ file, rows }]`, `file` relative to `root`. Per directory, entries sorted by
  name: `README.md` is skipped, a `*.mjs` with a valid name is imported (`pathToFileURL`), anything else throws
  (`unexpected file`); a missing directory throws; a module without an array `rows` throws.
- `validateAdditions(files, ctx)` with `ctx = { mapRoutes, groups, tableNames, moduleIds, expandRow, rowKey }` → the
  normalised rows `{ s, g, m, p, f, a, st, t, ops?, addition: { file, en, module, spec, successStatus? } }`. It collects
  every problem and throws once: `map additions problems:\n  <file> row <n> (<row key>): <problem>`.
  Besides the field rules of 4.1 (the auth text is checked by calling `ctx.expandRow(row)` and catching its error, and only
  for a row whose other fields passed: `expandRow` itself crashes on a CRUD row without `ops`):
  - **never a map row:** the row key equals a map row key → `repeats the map row`;
  - **never a map endpoint:** an expanded endpoint key equals a map endpoint key after replacing every `:name` by `:`
    (so `GET /admin/clients/:clientId/api-keys` collides with `GET /admin/clients/:id/api-keys`, and
    `PATCH /admin/staff/:id` with the map's CRUD row) → `its endpoint <key> already exists in the map (row <row key>)`;
  - **never twice:** the same checks between additions, across files → `is also added by <file>`.

`scripts/lib/map.mjs` (keep the rest of the file as it is):
- import the map's rows as `mapRoutes` and export them; drop `routes` from the re-export line (`:8`);
- import `modules` from `../module-map.mjs` (plain data, no cycle);
- at the **bottom** of the file (after `expandRow`, so every constant it uses is initialised):
  `export const checkAdditions = (files) => validateAdditions(files, { mapRoutes, groups, tableNames: <map tables ∪ every module's additionalTables>, moduleIds, expandRow, rowKey })`,
  `export const additions = checkAdditions(await readAdditionFiles(additionsDirs(), ROOT))` (top-level await; the only
  importers are `manifest.mjs:6` and `build-route-slices.mjs:9`, both ES modules run by Bun),
  `export const routes = [...mapRoutes, ...additions]`;
- reword the comment of `EXPECTED` (`:10`): the map's own numbers; additions are counted on top, never here.

So a malformed or duplicate row fails every tool that loads the map (`routes:build`, `routes:check`,
`contract:extract`, slices) with the file and row named.

### 4.3 The manifest (`scripts/lib/manifest.mjs`)

- `ROOT` comes from `paths.mjs` and stays exported (five scripts import it from here).
- Owner and text per row: `row.addition ? [row.addition.module] : modulesForRow(key)` and
  `row.addition ? row.addition.en : descriptions[key]`; use the same owner function in the `byModule` tally (`:109`).
- Endpoints of an addition also carry `addition: { file, spec }` and, when the row gives one, `successStatus` (for a CRUD
  row the status of the endpoint's letter: `list`→`L`, `show`→`S`, `create`→`C`, `update`→`U`, `delete`→`D`). Map
  endpoints get **no new field** (their JSON stays byte-identical).
- New problem: an addition endpoint with a console function (`frontend` found) and no `successStatus` →
  `<key>: the console calls this addition (<file>:<line>); its row needs successStatus (<additions file>)`.
- Counts: compute the map's own numbers from `mapRoutes` (rows; endpoints expanded from map rows; tables, scenarios,
  surfaces, money events, accounts) and compare **those** with `EXPECTED` (`:80`, same message). The manifest's
  `counts.rows` and `counts.endpoints` are the totals (map + additions); add `counts.map: { rows, endpoints }` and
  `counts.additions: { rows, endpoints }`. Add `rules.additions` (one sentence: backend-owned rows beyond the map,
  `scripts/map-additions/<feature>.mjs`, decision 035).
- The console-tag check (`:87`) and the duplicate check (`:81-85`) stay as they are: they already run over every endpoint.

### 4.4 The other tools

| Tool | Change | With zero additions |
|---|---|---|
| `build-route-manifest.mjs` | `OUT = docsDir()` (`:8`); the header line (`:18`) adds "N rows (M endpoints) are backend additions beyond the map (`scripts/map-additions`, decision 035)." only when N > 0; an addition's description cell (`:32`) ends with ` (addition, <spec>)` | `route-manifest.md` unchanged; `.json` gains `counts.map`, `counts.additions`, `rules.additions` |
| `build-route-slices.mjs` | `OUT = join(docsDir(), 'slices')` (`:13`); the owner lookup for `foreignTables` (`:52`) also knows every module's `additionalTables` (owned ones are then not foreign; another module's gets its owner). `ownedTables` stays the map's tables | every slice unchanged (no map row lists such a table: checked) |
| `build-coverage.mjs` | `ROOT` and the docs folder from `paths.mjs` (`:9-10,30,72`); it must not import `manifest.mjs` | `COVERAGE.md` unchanged |
| `build-contract-docs.mjs` | `ROOT`, `docsDir()` from `paths.mjs`: the manifest is read from `docsDir()`, the documents are written to (and `--check` compares) `join(docsDir(), 'contract')`; the hand-written inputs (`frontend-endpoints.json`, `lead-decisions.json`, `extraction/`) stay under `<ROOT>/docs/contract`. In `moduleDoc` (`:239`) the line of an addition starts with **Map addition** and, in parentheses, its spec tag and its additions file, where a map row says **Map**; it ends with `· success <status>` when the row has one. Guard: a `status` that is not a key of `STATUS_WORD` (`:21-28`) in `lead.conflicts`, `lead.extra` or `lead.answers` throws, naming the entry | only `MISMATCHES.md` changes (the B181 fix, section 8) |
| `gen-openapi.ts` | none | unchanged |
| `test/contract/lib/inputs.ts` | `ManifestEndpoint` gains `op`, `access`, `permission`, `successStatus?`, `addition?`; `loadManifest(file = <the committed manifest>)`; `loadSuccessStatuses(manifest = loadManifest())` adds each endpoint's `successStatus` after the extraction's and throws when an extraction record and an addition disagree on one key; reword "the 269 functions" (`:52`) | same statuses as today |
| `scripts/module-map.mjs` | comments only (`:8-11`): rows of `scripts/map-additions` name their module themselves; additions may list `additionalTables` | — |

Shape parity (`shape-parity.test.ts:22,40`) and the fixtures test (`fixtures.test.ts:19`) then find the status of a
console-called addition with no edit; route parity, Turnstile parity, `pending.ts` and coverage read the manifest.

### 4.5 The directory

`scripts/map-additions/README.md` only (no `.mjs`). It holds: what the folder is and decision 035; the example of 4.1;
the field table of 4.1; the auth vocabulary per surface copied from `map.mjs:28-47` with the access each text gives;
"stage = your feature number; 99 belongs to the tooling test"; the guards; what to run (`bun run routes:build`, then
build the route, `bun run contract:docs`, `bun run docs:openapi`, `bun run coverage:build`, `bun run format`); that the
files are formatted by Prettier (they are not in `.prettierignore`); the console steps (section 9, CONTRIBUTING text);
what the lead does at merge (replace `B-TBD <slug>` by the B-number, regenerate).

## 5. Design: computed totals (G8)

Replace a pinned number by a computed equality; never drop the equality itself.

| Where | Today | Becomes |
|---|---|---|
| `src/common/errors/catalog.spec.ts:21` | `documented.size` is 123 | `toBe(Object.keys(ERROR_CATALOG).length)`; the key and status equalities of `:22-23` stay |
| `test/integration/db-schema.test.ts:29,35-36` | 69 tables, title names them | `const expected = await mappedTables()`; no table twice in `expected`; `names` equals `expected`; the Drizzle names equal `names`; title "create exactly the tables of the module map (the map's tables and each module's additionalTables)" |
| `test/integration/db-schema.test.ts:63` | `rowCount` is 69 | `toBe((await mappedTables()).length)` |
| `test/schema/structure.test.ts:139` | 12 modules | `modules.map((m) => m.id).sort()` equals `Object.keys(moduleSchemas).sort()` (a module without its schema import, or the reverse, fails by name) |
| `test/schema/structure.test.ts:146-149` | 69 tables in the barrel | the barrel's names, sorted, equal every module's `tables` + `additionalTables`, sorted; no name twice; title without numbers |
| `test/integration/queues.test.ts:64-66` | "ten queues", `toHaveLength(10)` | drop the length line (the line above already equals `QUEUE_NAMES`, and `queue-definitions.spec.ts:32-47` pins the names); title "each queue of the registry" |
| `test/contract/lib/compare.test.ts:545` | 269 console functions | `document.endpoints.length` equals the file's own `count`, and its distinct keys equal `counts.frontendRoutes` of `docs/route-manifest.json` (both 269 today; a tagged console function the extraction cannot type would otherwise skip shape parity silently) |
| `scripts/lib/map.mjs:11` | total | the map's numbers, compared with map-only counts (section 4.3) |

**Left alone, on purpose:**
- The map's own numbers: `EXPECTED` (274, 382, 66, 13, 9, 13, 14).
- The 12 system ledger accounts (the map's 11 + `owner_capital`, B181): `src/modules/money/domain/reference-data.spec.ts:29,35`,
  `test/integration/first-run.test.ts:157,162,364,862`. One owner (money; feature 21).
- Single-module vocabularies with one owner per wave: order event types 21 (`structure.test.ts:362`, a tripwire for "a new
  type needs a migration"), alert metrics 11 (`metric-registry.spec.ts:7`), countries 12 (`country-currency.spec.ts:13`),
  session setting keys 7 (`session-policy.spec.ts:73`), the queue name list (`queue-definitions.spec.ts:32-47`).
- A floor, not a total: `test/unit/module-load.test.ts:39` (`>= 12`).
- Seed data totals (`test/integration/*-seed.test.ts`, `seed.test.ts`): they mirror the console's mocks; a feature that
  seeds more rows extends its own seed test.
- Append-only lists the lead merges (L2): `ERROR_CATALOG` + `BACKEND_CODES`, `AUDIT_ENTITY_TYPES`, `ADDITIONS` of
  `structure.test.ts:73-126`, cache key families, `docs/queues.md`, `MULTIPART_ROUTES` and its spec.
- The console's own pinned numbers (`frontend-admin/scripts/build-route-manifest.mjs`): its manifest stays the map's (L1).

## 6. Design: access and permission parity (G2)

New pure module `test/contract/lib/manifest-parity.ts` (no app import), used by `route-parity.test.ts` and unit-tested:
- `difference(label, actual, expected)` (moved from `route-parity.test.ts:40-47`), `expectedKeys(manifest, kind, pending)`,
  `rowMismatches(contracts, manifest)` (method, path, surface: today's `:83-93`), `turnstileMismatches(contracts, manifest)`
  (today's `:96-104`). `route-parity.test.ts` calls them; its behaviour does not change.
- `accessMismatches(contracts, manifest, exceptions = ACCESS_EXCEPTIONS)` → one line per wrong contract. For every
  contract that has a manifest row (the Dhru transport has none and is skipped):
  - **access:** equal to the row's, or to the exception's for that key;
  - **permission** (row permission `p`, contract permission `c`):
    - `p` is `null` → `c` must be `null`;
    - `p` is `area:action` → `c === p` (staff permissions and API-key scopes);
    - `p` is `area:*` and the endpoint comes from a CRUD row (`op` is `list`, `show`, `create`, `update`, `delete`) →
      `c === area:<read|read|create|update|delete>` (the console's `crudPermission` uses the same words,
      `frontend-admin/src/lib/auth/permissions.ts:37-41`);
    - `p` is `area:*` on a single route (`op` is `action`) → `c` is `area:*` or one action of the same area.
- `ACCESS_EXCEPTIONS`: `{ 'POST /admin/auth/2fa': { access: 'staff-session', mismatch: 'B1', reason }, 'POST /admin/auth/2fa/setup': { … 'B2' … }, 'POST /client/auth/2fa': { access: 'merchant-session', mismatch: 'B125', reason } }`
  (the map says `public`; the pre-2FA session of the sign-in is mandatory). `staleAccessExceptions(...)` lists an
  exception whose contract is missing or no longer deviates.

Checked against today's code (every operation of `docs/contract/openapi.json` `x-gsm-access` / `x-gsm-permission`
against `docs/route-manifest.json`, plus `GET /admin/queues`, which the document leaves out,
`system-traffic.contracts.ts:113-124`): 367 contracts have a row; 3 differ in access (exactly the exceptions); of the
114 `area:*` endpoints 112 are CRUD endpoints and all use the CRUD word; `POST /admin/content-pages/generate` uses
`storefront:create` under `storefront:*`; `PUT /admin/risk/rules` keeps `risk:*`; every other permission is equal. So
the rule passes today, and `wallet:read` on a `wallet:adjust` row, `staff:update` on a list endpoint, or another area
under `area:*` fails. Additions go through the same rule (an addition is written to equal its contract, so it needs no
exception).

`route-parity.test.ts` gains `describe('access and permission (decision 035)')`:
1. every built contract has the access and the permission of its manifest row (`accessMismatches(...)` is `[]`);
2. each access exception cites an existing B-id (`loadMismatchIds()`) and still deviates (`staleAccessExceptions` is `[]`);
3. every addition of the manifest names its spec decision: an existing B-id, or `B-TBD <slug>`.

## 7. Risks and how the design closes them

- **Security.** G2 closes a real gap: a contract with a weaker permission than its row now fails CI. The loader imports
  `.mjs` files only at development and CI time; `src/` never imports `scripts/lib/map.mjs`, so the API and the worker
  never execute an additions file. The two environment variables only add a directory or redirect generated output.
- **Financial integrity, concurrency:** nothing touched (no ledger, lock, job or idempotency code).
- **Performance:** `routes:check` reads one more folder; no runtime cost.
- **Backward compatibility:** the manifest change is additive (`counts.map`, `counts.additions`, `rules.additions`); no
  consumer outside this repository reads it (the console reads `openapi.json`, the storefront too). With no additions
  every other generated document must stay byte-identical: acceptance criterion of slice A.
- **Top-level await in `map.mjs`:** no `require()` of it exists; `map-additions.mjs` must stay free of `map.mjs`
  imports (rule in its header, proven by the CLI test, which loads an additions file that imports `R`).
- **A feature's row vocabulary:** plans written in parallel may have guessed other field names. The canonical ones are
  `en`, `module`, `spec`, `successStatus`; an unknown key fails loudly with the row named.
- **Generated files in parallel branches** (`route-manifest.*`, `slices/*`, `COVERAGE.md`, `endpoints/*.md`,
  `openapi*.json`) still conflict textually; they are never hand-merged (take `main`, regenerate). That is the lead's
  merge routine, not something W0 can remove.
- **The fixture test starts about ten short Bun processes** (no Nest application, a few hundred milliseconds each).

## 8. Small fixes (requirement 4)

1. `docs/contract/lead-decisions.json:125-130`: add `"status": "decided"` to the last `extra` entry (B181; the eleven
   lead records before it, B170-B180, are `decided`). Then `bun run contract:docs`: `MISMATCHES.md:200` ends
   "decided by the user". Together with the status guard of 4.4 it cannot recur.
2. `test/contract/README.md:10`: the fix for a code on one side only is "add it to `src/common/errors/catalog.ts` and,
   when no console screen references it, to `BACKEND_CODES` in `scripts/build-contract-docs.mjs`; `bun run contract:docs`
   regenerates `error-codes.md`" (not `lead-decisions.json`). Same wording in `CONTRIBUTING.md:61-62` and
   `docs/briefs/_common.md:45-46`. Also in that README: the route-parity row mentions access and permission; "Building a
   route" gains one step for a route beyond the map (row first, `successStatus` when the console calls it).
3. `docs/briefs/_common.md`:
   - `:5-14` "Where you work": the worktree the brief names (`/home/saifi/gsm-project/backend-<id>`, branch
     `feat/backend-<id>`) or the main checkout when it names none, and its `CLAUDE.md`; the shell's directory may reset,
     so use absolute paths or `cd <worktree> && …`; Serena may be bound to another checkout: use it only when its active
     project is your worktree, otherwise Read, Grep, Glob, Edit, Write; never change git state, never spawn agents, never
     edit a repository or worktree the brief does not name (the console's main checkout, the storefront) or `reference/`;
     never run `docker compose`, `db:migrate`, `db:seed`, `db:reset`, `setup`, `src/main.ts` or `scripts/ci.sh` in a
     worktree (no `.env` there: they would hit the owner's development database).
   - `:29`: tests use the instances of the worktree's untracked `.env.test` (`DATABASE_URL_TEST`,
     `REDIS_QUEUE_URL_TEST`, `REDIS_CACHE_URL_TEST`: its own `gsm_<id>_test` and Redis DB number, `test/support/env.ts`);
     only the main checkout falls back to `gsm_test` and Redis DB 1.
4. `CLAUDE.md:71-73`: "Done = `bun run check` green. One branch `feat/backend-<id>` per feature in its own worktree
   (`../backend-<id>`), squash-merged into `main` by the lead: one conventional commit per finished feature (body: routes,
   scenarios, queues/jobs, cache keys). Stage explicit paths. Never `--no-verify`, push, force-push or rewrite history."
5. `src/modules/support/application/support-templates.ts:1`: "Migration 0012" → "Migration `0016_support_tickets`".
6. `docs/queues.md:489-503`, five rows (values read from the code):

   | Scheduler id | Queue | Job | Schedule | Owner |
   |---|---|---|---|---|
   | `fx-refresh` | `maintenance` | `fx_refresh` | every hour at minute 0 | money (`src/modules/money/jobs/`) |
   | `idempotency-purge` | `maintenance` | `idempotency_purge` | daily 04:10 UTC | orders (`src/modules/orders/jobs/`) |
   | `supplier-poll-tick` | `supplier-poll` | `supplier_poll_tick` | every minute | suppliers (`src/modules/suppliers/jobs/`) |
   | `supplier-price-sync` | `supplier-sync` | `price_sync` | every 15 minutes | suppliers (`src/modules/suppliers/jobs/`) |
   | `supplier-balance-check` | `supplier-sync` | `balance_check` | every 30 minutes | suppliers (`src/modules/suppliers/jobs/`) |

## 9. Docs (requirement 5)

- **`CONTRIBUTING.md`**, new subsection after "Add an endpoint end to end" (after `:86`), "Add a route that is not in the
  map (decision 035)":
  1. The map is read-only. Add a row to `scripts/map-additions/<feature id>.mjs` (fields and auth vocabulary:
     `scripts/map-additions/README.md`), then `bun run routes:build`. A row that repeats a map row or endpoint, or is
     malformed, fails with its file and number.
  2. Build it like any endpoint (the steps above): the contract key is the row's endpoint key; `surface`, `access`,
     `permission` and `turnstile` must equal the row (route parity compares them; a CRUD row with `area:*` means
     `area:read|create|update|delete` per endpoint).
  3. New table: `additionalTables` of its module in `scripts/module-map.mjs`. New error code: catalog + `BACKEND_CODES`.
  4. The console calls it: give the row `successStatus`. Once the console change is on the console's main checkout:
     `bun run routes:build && bun run contract:extract && bun run contract:docs`, then `bun run contract:harvest` for a
     console GET route (or an entry in `test/contract/harvest/known-gaps.json`). The console's own manifest stays the
     map's; its coverage report lists the tag as unknown, which is accepted.
  5. Regenerate: `bun run contract:docs`, `bun run docs:openapi`, `bun run coverage:build`, `bun run format`. On a merge
     conflict in a generated file take `main`'s copy and regenerate in that order after `routes:build`.
  6. Never: edit `reference/`; add a `mapConflict` to an extraction record (it renumbers B1-B104); rename an existing
     key (the storefront's types use the `operationId`); change an existing route other than additively.
  Also step 1 of "Add an endpoint" (`:53`) gains "or in `scripts/map-additions`", and `:38` (`routes:check`) "against
  the map and the additions".
- **`CLAUDE.md:9-10`**: "What exists (routes, tables, rules): the map `reference/gsm-map/data/*.mjs` (read-only) plus the
  backend's own rows for routes beyond it, `scripts/map-additions/<feature>.mjs` (decision 035; tables beyond the map:
  `additionalTables` in `scripts/module-map.mjs`). Query …" (rest unchanged).
- **`docs/decisions/035-routes-beyond-the-map.md`** (format of `034-turnstile.md`): `Status: accepted, 2026-11-10 (lead,
  before features 20-23). Builds on decisions 009 (contract tests) and 018 (access).` Context: the map lives in the
  console repository and is read-only; route parity and the console-tag check refused every route outside it; only
  events had an allowance (`BACKEND_EVENTS`); four features need about 40-60 new routes in parallel; one pinned total
  per registry made them conflict. Decision: sections 4-6 of this brief in short (row shape and extras, loader and
  guards, the module named by the row, counts = pinned map numbers + computed additions, `successStatus` as a status
  source, access and permission parity with its three exceptions, computed totals, what stays pinned). Rejected:
  editing the map (read-only, two repositories regenerate), a bare allow-list (loses text, module, slice, coverage, docs).
  Consequences: the console's manifest stays the map's; B-numbers at merge; generated files are regenerated, never
  hand-merged.
- `docs/contract/TESTS.md`: the manifest input row (`:10`) says "every map row and every backend addition"; test 1 gains
  "access and permission equal the manifest row (decision 035)"; the 269 at `:11` loses its number.
- `docs/briefs/_feature.md` build order step 1: one sentence, "a route the map lacks gets its row in
  `scripts/map-additions/<feature>.mjs` first (CONTRIBUTING)". `README.md:230`: "(plus the rows of `scripts/map-additions`)".

## 10. Slices (one implementer, in this order; backend only)

### Slice A — loader, tools, fixture proof (medium)
Creates: `scripts/lib/paths.mjs`, `scripts/lib/map-additions.mjs`, `scripts/map-additions/README.md`,
`test/unit/fixtures/map-additions/sample.mjs`, `test/unit/map-additions.test.ts`.
Edits: `scripts/lib/map.mjs`, `scripts/lib/manifest.mjs`, `scripts/module-map.mjs` (comments), `scripts/build-route-manifest.mjs`,
`scripts/build-route-slices.mjs`, `scripts/build-coverage.mjs`, `scripts/build-contract-docs.mjs`, `test/contract/lib/inputs.ts`.
Regenerates: `docs/route-manifest.json` (`bun run routes:build`).

The fixture (`sample.mjs`, stage 99, imports `R` by relative path) has four rows:
1. `admin` `ops` `POST /admin/w0-sample/:id/ping`, `settings:update`, tables `settings`, `audit_logs`, module `platform`,
   `successStatus: 204` (the fake console calls it);
2. `store` `catalog` `POST /store/v1/w0-sample/check`, `عام + Turnstile`, tables `services`, `listed_prices`, module `catalog`;
3. `admin` `ops` `CRUD /admin/w0-samples`, `ops: 'LC'`, `settings:*`, tables `settings`, module `platform`,
   `successStatus: { L: 200, C: 201 }`;
4. `admin` `clients` `GET /admin/customers/:id/w0-sample`, `wallet:read`, tables `ledger_accounts`, `idempotency_keys`,
   module `money` (the customers matcher `module-map.mjs:128` matches this key: the row's module must win).

Acceptance:
- `bun run routes:check`, `bun run contract:check`, `bun run coverage:check`, `bun run docs:openapi:check` pass.
- `git status --short docs/` after `bun run routes:build && bun run contract:docs && bun run coverage:build` shows
  `docs/route-manifest.json` only (plus, after slice C, `MISMATCHES.md` and the hand-edited docs); `git diff` of the
  manifest shows only `counts.map`, `counts.additions` (`{ rows: 0, endpoints: 0 }`) and `rules.additions`.
- `test/unit/map-additions.test.ts` passes (section 11).

### Slice B — parity and computed totals (small; after A)
Creates: `test/contract/lib/manifest-parity.ts`, `test/contract/lib/manifest-parity.test.ts`.
Edits: `test/contract/route-parity.test.ts`, `test/unit/map-additions.test.ts` (the parity cases over the fixture
manifest), `src/common/errors/catalog.spec.ts`, `test/integration/db-schema.test.ts`, `test/schema/structure.test.ts`,
`test/integration/queues.test.ts`, `test/contract/lib/compare.test.ts`.
Acceptance: `grep -nE "toBe\((123|69|269)\)|toHaveLength\((69|12|10)\)"` over the five edited spec and test files finds
nothing; `bun test --timeout 15000 test/contract` passes; a temporary wrong `permission` in any one contract makes
`route-parity.test.ts` fail naming the key (try it, then revert).

### Slice C — small fixes and docs (small; after A)
Edits: `docs/contract/lead-decisions.json`, `test/contract/README.md`, `docs/briefs/_common.md`, `docs/briefs/_feature.md`,
`CLAUDE.md`, `CONTRIBUTING.md`, `README.md`, `docs/queues.md`, `docs/contract/TESTS.md`,
`src/modules/support/application/support-templates.ts`. Creates: `docs/decisions/035-routes-beyond-the-map.md`.
Regenerates: `docs/contract/MISMATCHES.md` (`bun run contract:docs`).
Acceptance: `grep -c undefined docs/contract/MISMATCHES.md` prints 0 (today 1, line 200); `queue-definitions.spec.ts` still
passes (it reads `docs/queues.md`); `bun run format` then `bun run check` green, in the foreground.

## 11. Tests

No integration, scenario or console test: no route exists to call. Child processes are started as
`test/integration/openapi-generator.test.ts:24-37` does (`Bun.spawn([process.execPath, script], { cwd: ROOT, env })`);
import `.mjs` modules through a variable path with a cast, as `test/schema/structure.test.ts:135-138` does. Give the
tests that start children an explicit timeout (60 s); the default is 15 s.

**`test/unit/map-additions.test.ts`** (no database)
- *The validator* (in process, `checkAdditions` from `map.mjs` with in-memory files): accepts the fixture rows and
  returns them with `addition`; refuses, naming file, row number and key: the map row
  `admin POST /admin/clients/:id/wallet/adjust`; `admin PATCH /admin/staff/:id` (an endpoint of the map's CRUD row);
  `admin GET /admin/clients/:clientId/api-keys` (same route, other parameter name); one endpoint added by two files; a
  surface `dhru` or `events`; an unknown group; a group on `v1`; `/client/x` on surface `admin`; `/admin/x` on surface
  `system`; method `ACTION`; `CRUD` without `ops`, with an unknown letter, `ops` on a `GET`, a CRUD path with `:id`; a
  bad segment; auth text `session`; a missing `en`, `f`, `module`, `spec`; an unknown module; an unknown or repeated
  table; stage `-1` and `1.5`; `spec: 'TBD'` and `'B-TBD'`; status 203, 302 on a `POST`, an object on a `GET`, a letter
  outside `ops`; an unknown key; `rows` that is not an array; a stray `notes.txt` in the folder. Two bad rows give one
  error that lists both.
- *The surface prefixes* of `ADDITION_SURFACES` agree with `surfaceOfPath` (`src/common/surface.ts:30`).
- *The tools pick the sample rows up.* A temporary docs folder `D` and a fake console `F` written by the test
  (`F/src/features/w0-sample/api/sample.ts` with `@route POST /admin/w0-sample/:id/ping` above
  `export async function pingSample`). Environment of the children: `PATH`, `HOME`,
  `GSM_MAP_ADDITIONS_EXTRA_DIR=test/unit/fixtures/map-additions`, `GSM_DOCS_DIR=D`, `FRONTEND_DIR=F`. Run, in order,
  `build-route-manifest.mjs`, `build-route-slices.mjs`, `build-coverage.mjs`, `build-contract-docs.mjs` (all exit 0), then:
  - manifest: `counts.map` equals `EXPECTED` (`rows`, `endpoints`); `counts.additions` is the real additions (imported
    from `map.mjs`) plus 4 rows and 5 endpoints; `counts.rows` and `counts.endpoints` are the sums; the five keys exist
    with `kind: 'http'`, module (`platform`, `catalog`, `platform`, `platform`, `money`), `description` = `en`,
    `descriptionAr` = `f`, normalised access (`staff-permission` + `settings:update`; `public` with `turnstile: true`;
    `settings:*`; `wallet:read`), `stage: 99`, `addition.file` and `addition.spec`, `successStatus` 204 / 200 / 201 /
    absent; the ping's `frontend` is `{ file: 'src/features/w0-sample/api/sample.ts', line, fn: 'pingSample' }`;
    `route-manifest.md` has the additions sentence and the ping line with `(addition, B-TBD …)`;
  - `--check` with the same environment exits 0;
  - **console-tag check:** the manifest script without the extra folder (same `F`, a fresh docs folder) exits 1 with
    `frontend @route POST /admin/w0-sample/:id/ping is not in the map`; with an extra folder (written by the test) whose one
    file holds the ping row as a plain object without `successStatus` it exits 1 with "needs successStatus";
  - slices: `platform.json` lists the ping and both CRUD endpoints and stage 99; `catalog.json` `foreignTables` has no
    `listed_prices`; `money.json` `foreignTables` has `{ table: 'idempotency_keys', owner: 'orders' }`;
  - coverage: `COVERAGE.md` has a `stage 99` row with 5 endpoints, 5 built, and the total grew by 5;
  - contract docs: `D/contract/endpoints/platform.md` has `## POST /admin/w0-sample/:id/ping` with "**Map addition**",
    the spec, the fixture file, the English sentence, staff-permission with `settings:update`, and `success 204`;
  - **guard through the CLI:** an extra folder holding one file whose row (a plain object, so the file needs no import) is
    the map's wallet-adjust row makes the manifest script exit non-zero with `repeats the map row` and the file name.
- *The contract tests pick them up* (slice B; in process, over `D/route-manifest.json`): `loadSuccessStatuses(loadManifest(file))`
  has 204, 200 and 201 for the three sample keys, nothing for the fourth, and still the extraction's `GET /health`;
  `expectedKeys(..., 'http', new Set())` contains the five keys, so `difference('http', [], expected)` says
  "expected but not built" for each (route parity, and through it OpenAPI, which documents every contract);
  `turnstileMismatches` flags a sample contract without `turnstile` and accepts one with it; `accessMismatches` accepts
  `settings:update`, `settings:read` on the list endpoint and `settings:create` on the create endpoint, and flags
  `settings:read` on the ping and `settings:create` on the list endpoint.

**`test/contract/lib/manifest-parity.test.ts`** (hand-written rows and contracts, like `compare-route.test.ts:45-59`):
`difference` both ways; `expectedKeys` minus pending; `rowMismatches`; `turnstileMismatches`; `accessMismatches`: equal
concrete permission passes and another fails; `null` against a permission fails; CRUD words per `op` pass, another word
or another area fails; a single route under `area:*` accepts `area:*` and `area:x`, refuses another area; access differs
→ fails, with its exception → passes; `staleAccessExceptions` names an exception that no longer deviates and one whose
contract is gone.

**`test/contract/route-parity.test.ts`**: the three new tests of section 6; the existing ones call the helpers.

Changed assertions: section 5. Run before the final check:
`bun test --timeout 15000 test/unit/map-additions.test.ts test/contract/lib/manifest-parity.test.ts test/schema/structure.test.ts src/common/errors/catalog.spec.ts src/infra/queues/queue-definitions.spec.ts`,
then `bun test --timeout 15000 test/contract`, then `test/integration/queues.test.ts` and
`test/integration/db-schema.test.ts` (the last one takes minutes: run it once).

## 12. Decisions

**Owner decisions:** none. W0 has no business rule; nothing here needs an L5 default.

**Planner decisions (for the lead to confirm at review):**
1. Additions are HTTP routes only; outgoing events keep `BACKEND_EVENTS`.
2. No new map groups and no new auth vocabulary through an addition; a feature that needs either names the edit of
   `route-descriptions.en.mjs` `groupNames` or `map.mjs` `ACCESS` in its own plan.
3. The row's `module` decides alone; the matchers of `module-map.mjs` are for map rows.
4. `successStatus` is demanded by `routes:check` as soon as the console calls an addition (earlier and clearer than the
   throw in shape parity). For a CRUD row it is an object per ops letter.
5. Stage = the feature number; 99 is the tooling test's.
6. The `area:*` rule of section 6, and three access exceptions tied to B1, B2 and B125.
7. B181's status is `decided`, like the lead records B170-B180.
8. Which totals became computed and which stay pinned (section 5), including the stronger check at `compare.test.ts:545`.
9. No `scripts/map-additions/w0.mjs`: the folder holds the README only (L1 allows "none").
10. Two test-only environment variables (`GSM_MAP_ADDITIONS_EXTRA_DIR`, `GSM_DOCS_DIR`) instead of script flags.

**Spec decision for the lead's B-entry** (one `extra` entry at merge; area "tooling", route "scripts/map-additions/*.mjs
(no HTTP route)", status `decided`): routes beyond the map are backend-owned rows in the map's row shape with their
English sentence, module, spec tag and success status; the map's counts stay pinned and additions are counted on top;
an addition can never repeat or override a map row; contracts must carry the access and permission of their row (CRUD
rows with `area:*` mean the CRUD action; exceptions B1, B2, B125); decision 035.

**Notes for the lead (not implementer work):** after merging a feature that has additions run
`bun run routes:build && bun run contract:docs && bun run docs:openapi && bun run coverage:build` (`merge-prep.sh finish`
does not run the first); replace each `B-TBD <slug>` by the B-number and regenerate; the feature plans must use the
field names of section 4.1.

## 13. Storefront handoff

None. W0 changes no route, field, error, cookie or cache rule, and `docs/contract/openapi.json` is byte-identical. For
later features: a route beyond the map appears in `openapi.json` like any other (its `operationId` comes from the route
key), so the site's type generation needs nothing new.

## 14. Review and approval

Re-checked against the code after writing: the importers of `map.mjs` and `manifest.mjs`; every line number above; the
access and permission rule against all 367 contracts that have a manifest row; that no map row lists an
`additionalTables` table; that `pending.ts` is empty; the 18 schedulers the code registers against the 13 documented;
the 269 distinct console keys in both generated files. No lead decision conflicts with this design.

**Approved by Fable 5.2, 2026-11-10.** Nothing blocks implementation.
