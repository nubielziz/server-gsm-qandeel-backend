# Feature 26: Supplier quick add (add a supplier's services by whole group, or all of them, in the background)

Plan by Fable 5.2 (planner), 2026-11-11, against backend `main` @ `a982328` and console `main` @ `272f0a3`. Owner request
(2026-11-11): "Quick add": add services from a supplier more easily, by copying a whole group or all of them. Two slices, two
Sonnet 5.5 implementers, in parallel: **B** backend (`../backend-26`, `feat/backend-26`, test database `gsm_26_test`, Redis DB 7
in the worktree's `.env.test`) and **C** console (`../frontend-admin-26`, `feat/console-26`). Read first: `backend/CLAUDE.md`,
`docs/briefs/_common.md`, `_feature.md`; slice C also `frontend-admin/CLAUDE.md`. Paths are backend-relative; `FA/` = the console
worktree. No agent commits, runs git that changes state, or spawns agents. Money, orders and the storefront are not touched.

## 1. What exists (verified in the code)

| # | Fact | Evidence |
|---|---|---|
| 1 | The import takes `{ supplierServiceIds }` (1 to 500), runs inline in **one** transaction, about 6 statements per new item | `suppliers/contracts/suppliers.contracts.ts:465-470`, `application/supplier-catalogue.service.ts:184-265` |
| 2 | It takes the supplier row `FOR UPDATE` first, then reads the links; the sync takes the same lock. Two imports of one supplier therefore run one after the other and the second sees the first's links: **no duplicate services today** | `supplier-catalogue.service.ts:191-200`, `infra/supplier.repository.ts:94`, `docs/queues.md` (supplier-sync, Idempotency) |
| 3 | A category is unique on `(type, lower(name))`, so two imports of **different** suppliers that create the same category at once make the second fail on the index (never a duplicate category) | `catalog/db/schema.ts:212`, `application/service-importer.ts:139-155` |
| 4 | An import of a `new` item with a type other than imei, server, remote, file refuses the whole request (`422 unsupported_type`); availability is not checked | `supplier-catalogue.service.ts:206-214`, `domain/import-plan.ts:71-81` |
| 5 | `supplier_services` keeps `remote_group`, `type` (the Dhru `GROUPTYPE`, else `SERVICETYPE`, else `IMEI`), `is_available`, `raw`; "imported" = a `service_supplier_links` row exists (an archived service counts) | `db/schema.ts:127-157`, `domain/dhru-protocol.ts:200-218`, `infra/supplier-catalogue.repository.ts:24-27` |
| 6 | The queue `imports` is reserved for this: "bulk imports started by staff", concurrency 2, **1 attempt, no stalled re-run**, "an import records its progress and can be started again by staff" | `src/infra/queues/queue-definitions.ts:94-99`, `docs/queues.md` (imports) |
| 7 | `job_runs` cannot carry this run: no supplier, scope or progress column, its overlap guard is per job name, it is closed only at the end, and `docs/queues.md` says event-driven jobs are recorded by their own tables | `health/db/schema.ts:411-441`, `health/job-runs/job-runs.service.ts`, `docs/queues.md` ("Runs are recorded") |
| 8 | An audit row written in the worker has the actor `system` (no request context); a staff `POST` must write an audit row in the request | `platform/audit/audit.service.ts:79-83`, `common/contract/define-route.ts:214,531` |
| 9 | The worker does not load `CatalogModule`; `ServiceImporter` has no dependencies; `SupplierEngineModule` is loaded by both processes and already lists `AuditService` directly | `src/worker.module.ts`, `suppliers/supplier-engine.module.ts`, `catalog/application/service-importer.ts` |
| 10 | A list filter with an empty value is skipped by the parser | `common/contract/list-query.ts:421-423` |
| 11 | A new active service is visible to merchants at once (Dhru, REST v1, portal) but **not on the site**: the store sells only what staff priced for the retail group | `catalog/infra/storefront-services.repository.ts:108` |
| 12 | The console has no bulk "switch on" for services (only the bulk price change) | `FA/src/features/services/components/SelectionBar.tsx` |
| 13 | Console: `ImportDialog` (picker, preview, import); the group is a small line under the name; no group filter | `FA/src/features/suppliers/components/Import*.tsx` |

## 2. Design

### 2.1 Scopes and what a quick add takes

- Two scopes: `all` (every service of the supplier) and `groups` (1 to 500 groups). A **group** is the pair `(type, remoteGroup)`
  exactly as stored (two types may share a group name; the catalog's category is also per type).
- A quick add takes only **candidates**: services of the scope that are (a) not imported (no link row), (b) available
  (`is_available`), (c) of an importable type (`lower(btrim(type))` in imei, server, remote, file). Everything else is left out
  and counted, never refused.
- It **only creates**. A service already in the console is never touched: no cost update, no quantity, no price. A changed cost
  already reaches the floor through the sync (effective cost); the `services.cost` refresh of a "changed" item stays in the
  picker's import, which is unchanged.
- The client sends the scope, never ids. The server builds the work list from `supplier_services` when the run starts in the
  worker, and re-checks every item inside the transaction that creates it.
- No cap on the number of services (the job works in chunks). `groups` is capped at 500 per request; more is `all`.

### 2.2 Routes and wire

Three new routes (rows in `scripts/map-additions/26.mjs`, §4) and three new filters on one map route. The picker's
`POST .../import/preview` and `POST .../import` keep `{ supplierServiceIds }` (1 to 500), inline, **unchanged**.

**`GET /admin/suppliers/:id/service-groups`** (`suppliers:read`) → `200`
```json
{ "groups": [{ "remoteGroup": "Apple iPhone", "type": "IMEI", "total": 120, "addable": 80, "imported": 30, "unavailable": 8, "unsupported": 2 }],
  "totals": { "total": 120, "addable": 80, "imported": 30, "unavailable": 8, "unsupported": 2 },
  "latestRun": null }
```
Every service is in exactly one bucket, tested in this order: `imported` (a link exists), `unavailable` (not `is_available`),
`unsupported` (type not importable), else `addable`; `total` is the sum. One row per `(type, remote_group)`, ordered by
`lower(type), lower(remote_group), type, remote_group`; not paged. `remoteGroup` may be `''` (the import names that category
`Imported`). `latestRun` is the supplier's newest run (`QuickAddRun` below) or `null`. Errors: `UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`.

**`POST /admin/suppliers/:id/quick-add`** (`catalog:create`) → `202` `QuickAddRun`
```json
{ "scope": "groups", "groups": [{ "type": "IMEI", "remoteGroup": "Apple iPhone" }], "serviceStatus": "active" }
{ "scope": "all" }
```
Body = `z.discriminatedUnion('scope', [...])` (as `MaintenanceBody` does): `all` takes no `groups`; `groups` needs
`groups`: `.min(1, 'Pick at least one group.').max(500, 'Pick at most 500 groups, or add all.')`, each
`{ type: z.string().max(60), remoteGroup: z.string().max(300) }` (not trimmed: they must equal the stored text; exact repeats are
dropped). `serviceStatus`: `'active' | 'disabled'`, optional, default `'active'`. Errors: `UNAUTHORIZED`, `FORBIDDEN`,
`CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED`, `SUPPLIER_DISABLED`, `JOB_ALREADY_RUNNING`. Refusals:

| When | Answer |
|---|---|
| the supplier is `disabled` (paused is allowed, as for a sync) | `409 SUPPLIER_DISABLED` |
| a run of this supplier is `queued` or `running` and not stalled (§2.4) | `409 JOB_ALREADY_RUNNING`, detail `A quick add for this supplier is already running.` |
| the scope has no candidate now | `422 VALIDATION_FAILED`, field `scope`, code `nothing_to_add`, message `Nothing to add: every service in this scope is already in the console, no longer available or of a type that cannot be imported.` No run is created |

**`GET /admin/suppliers/:id/quick-add/:runId`** (`suppliers:read`) → `200` `QuickAddRun`; `404 NOT_FOUND` for an unknown run or a
run of another supplier.

**`QuickAddRun`** (all keys always sent):
```ts
{ id: Id; supplierId: Id; scope: 'all' | 'groups'; groups: { type: string; remoteGroup: string }[]; // [] for `all`
  serviceStatus: 'active' | 'disabled'; status: 'queued' | 'running' | 'succeeded' | 'failed';
  total: number; processed: number; created: number; skipped: number; failed: number; // processed = created + skipped + failed
  categoriesCreated: number;
  failures: { supplierServiceId: Id; name: string; reason: string }[]; // at most 20
  error: string | null; requestedBy: Id | null;
  createdAt: IsoDateTime; startedAt: IsoDateTime | null; finishedAt: IsoDateTime | null }
```

**`GET /admin/suppliers/:id/services`**: add the filters `remoteGroup` (`string`, `ops: ['eq']`), `type` (`string`, `ops: ['eq']`)
and `isAvailable` (`boolean`); add `type` and `isAvailable` to `COLUMNS` of `infra/supplier-catalogue.repository.ts`. Rows, sorts
and search do not change. The group without a name cannot be filtered (fact 10): the console's filter does not offer it.

### 2.3 The run record and the job

**Table `supplier_import_runs`** (suppliers module; `additionalTables: ['supplier_import_runs']` on the `suppliers` entry of
`scripts/module-map.mjs`; in `suppliers/db/schema.ts`; `bun run db:generate --name supplier_import_runs`, generated
`drizzle/0030_*` + snapshot + journal, **the lead renumbers at merge**; it must only create this table):

| Column | Type |
|---|---|
| `id` | `pk()` |
| `supplier_id` | fk `suppliers.id` cascade, not null |
| `scope` | text, check in `('all','groups')` |
| `groups` | `jsonList()`: `[{ type, remoteGroup }]`, `[]` for `all` |
| `service_status` | text, check in `('active','disabled')` |
| `status` | text, default `'queued'`, check in `('queued','running','succeeded','failed')` |
| `total`, `created_count`, `skipped_count`, `failed_count`, `categories_created`, `created_with_quantity` | integer not null default 0, one check: all `>= 0` |
| `failures` | `jsonList()`: `[{ supplierServiceId, name, reason }]`, at most 20 |
| `error` | text null |
| `requested_by` | fk `staff_users.id` (as `job_runs.triggered_by`), null |
| `started_at`, `finished_at` | timestamptz null |
| `heartbeat_at` | timestamptz not null (set at insert, at the claim and by every chunk) |
| `created_at`, `updated_at` | the usual helpers |

Indexes: `supplier_import_runs_supplier_idx (supplier_id, id desc)`, `supplier_import_runs_requested_by_idx (requested_by)`, and
the guard `uniqueIndex('supplier_import_runs_active_uq').on(supplier_id).where(status in ('queued','running'))`: **one live run
per supplier**, in the database.

**Job.** Queue `imports` (fact 6: 1 attempt, no stalled re-run), job name `supplier_quick_add`, started by the outbox event
`supplier.quick_add` (aggregate `supplier_import_runs`, id = the run, payload `{ runId, supplierId }`; job id `outbox-<event id>`).
`QuickAddOutbox` registers `{ type: 'supplier.quick_add', queue: 'imports', jobName: 'supplier_quick_add' }` in `onModuleInit`
and is provided by `SupplierEngineModule` (both processes, as `RefundOutbox`). `QuickAddProcessor`
(`@QueueProcessor('imports', SUPPLIER_QUICK_ADD_JOB)`, in `SupplierJobsModule`) calls `QuickAddRunner.run(job.data.aggregateId)`.
The run is recorded in `supplier_import_runs`, **not** in `job_runs` (fact 7). No scheduler. No cache key.

### 2.4 Use cases

Constants in `domain/quick-add.ts` (pure, with spec): `QUICK_ADD_CHUNK = 100`, `QUICK_ADD_STALE_MS = 5 * 60_000`,
`MAX_QUICK_ADD_GROUPS = 500`, `MAX_ITEM_FAILURES = 20`, `STALLED_ERROR = 'The run stopped before it finished. Start it again: it
continues with what is left.'`; `uniqueGroups(groups)`, `isStalled(run, nowMs)` (`queued` or `running` and `heartbeat_at` older
than the limit), `runView(run, nowMs)` (a stalled run is **shown** as `failed` with `STALLED_ERROR` and `finishedAt: null`; the
row is not written by a read), `chunksOf(ids, size)`, `failureReason(error)` (the Postgres constraint name when the error has
one, else `unexpected error`; the full error goes to the log only).

**`QuickAddService`** (`application/quick-add.service.ts`, `SuppliersAdminModule`):
- `groups(supplierId)`: `404` when no supplier; one grouped query (`count(*) filter (where ...)` per bucket of §2.2) plus the
  newest run.
- `start(supplierId, body, staffId)`, one transaction, in this order:
  1. `lockSupplier` (`404`; `disabled` → `SUPPLIER_DISABLED`).
  2. The live run of the supplier (`queued`/`running`, `FOR UPDATE`): not stalled → `JOB_ALREADY_RUNNING`; stalled → close it
     (`failed`, `STALLED_ERROR`, `finished_at`) and go on.
  3. Count the candidates of the scope (§2.1); zero → `422 nothing_to_add`.
  4. Insert the run (`queued`, `total` = that count, `requested_by`, `heartbeat_at` = `clock.now()`).
  5. `QuickAddOutbox.requested(tx, runId, supplierId)`.
  6. Audit (§2.6). Return `runView`.
- `show(supplierId, runId)`: `404` unless the run belongs to the supplier.

**`QuickAddRunner.run(runId)`** (`application/quick-add-runner.ts`, `SupplierEngineModule`, which adds `ServiceImporter` and
`QuickAddOutbox` to its providers; fact 9):
1. **Claim**: `UPDATE ... SET status='running', started_at, heartbeat_at WHERE id = $1 AND status = 'queued'`. No row → return
   (a second delivery, or the run was closed): the job is idempotent.
2. Read `catalog.importDefaultSlaMinutes` (as the import does). `ids` = the candidate ids of the scope, `ORDER BY id` (one
   query, ids only); write `total = ids.length` (guarded on `running`).
3. For each chunk of 100 ids, **one transaction**: `lockSupplier` (lock order: the supplier row first, as the import and the
   sync) → `supplierServicesByIds` → `linkedServicesOf` → for each id: a row that is gone, linked, unavailable or not
   `importableType` is `skipped`; else create it (below) → `recomputeEffectiveCost(tx, createdIds)` →
   `priceVersion.bumpAfterCommit(work)` when something was created → **progress**: `UPDATE ... SET created_count = created_count
   + $c, skipped_count = ..., categories_created = ..., created_with_quantity = ..., heartbeat_at = $now WHERE id = $1 AND status
   = 'running'`. When that update matches no row the run was closed by a newer start: throw, so the chunk rolls back, and stop
   quietly.
4. A chunk that throws anything else is retried **item by item**, each in its own transaction of step 3. An item that throws
   again is `failed`: add 1 to `failed_count`, append `{ supplierServiceId, name, reason }` to `failures` (first 20), log the
   error. This also absorbs the category race of fact 3 (the retry finds the category). At `MAX_ITEM_FAILURES` failed items the
   run ends `failed` with `error = 'Too many services could not be added (20). The rest was not tried.'`.
5. **Close** (one transaction): `UPDATE ... SET status = 'succeeded', finished_at WHERE id = $1 AND status = 'running'` and the
   end audit row (§2.6). Any unexpected error outside the chunks closes the run `failed` with the message (at most 500
   characters) the same way, then rethrows so the job shows in the queue's failed list (a retry from the console finds the run
   not `queued` and does nothing).

**Creating one service** is shared with the picker's import: new `application/imported-service.ts`,
`createImportedService(tx, importer, { row, cost, defaultSla, status })` → `{ serviceId, categoryCreated, withQuantity }`
(`importer.create` with the fields `SupplierCatalogueService.import` passes today plus `status`, then `insertFirstLink`; the
private `suggestedPrice` moves here and is exported for the preview; `cost` is `linkUnitCost({ credit, creditRate })`).
`SupplierCatalogueService.import` calls it with `status: 'active'`; its behaviour, refusals, answer and audit row do not change.
`ServiceImporter` (catalog): `ImportedServiceInput` gains `readonly status?: ServiceStatus` (default `'active'`), and `create`
returns `categoryCreated: boolean` as well.

**Failure halfway.** Every committed chunk stays. A failed or stalled run reports its counts; staff press Quick add again with
the same scope and the new run takes what is left (the candidates are "not imported yet"). A worker that dies leaves the run
`running`: after 5 minutes without a heartbeat every read shows it `failed`, and the next start closes it. Nothing is retried
automatically (fact 6).

### 2.5 Safety

| Risk | Closure |
|---|---|
| Two quick adds of one supplier | the partial unique index and step 2 of `start` under the supplier lock |
| Quick add against a picker import or a sync of the same supplier | all three take the supplier row lock first; each chunk re-reads the links inside its transaction, so a supplier service gets one service |
| The job delivered twice, or two runners | the claim (`queued` → `running`) and the guarded progress update |
| A group with hundreds, a supplier with thousands | chunks of 100, about 1 s each; the API only inserts a row and an outbox event |
| Thousands of services on sale by mistake | the review step states the number; above 500 a tick box is required (§3); `serviceStatus: 'disabled'` adds them switched off |
| One bad supplier entry | item-by-item retry; at most 20 failures, then the run stops |
| Prices | no new rule: the suggested price (cost plus the default minimum profit), as the import; staff use Bulk price change afterwards |
| Categories | found or created by `(type, group name)`, `Imported` for an empty name, as the import; the run counts `categoriesCreated` |
| Money, orders, holds, the ledger | not read, not written |

**Active or switched off.** Default **active**, the import's rule (orders-suppliers-10, B24), because the console cannot switch
services on in bulk (fact 12); staff may choose "Switched off" per run. Not an owner question.

### 2.6 Audit (entity `supplier`, label = the supplier's name)

| Row | Written by | `after` |
|---|---|---|
| `started quick add from` | the `POST`, actor = the staff member | `{ runId, scope, groups: <count>, groupNames: <first 20 "TYPE: name">, total, serviceStatus }`, plus `closedStalledRun: { runId, created, skipped, failed, total }` when step 2 closed one |
| `quick added services from` | the worker at the close, actor `system` (fact 8) | `{ runId, requestedBy, scope, status, total, created, skipped, failed, categoriesCreated, createdWithQuantity, serviceStatus }`, plus `error` when failed |

One pair per run. `GET` routes write none. No row per service (as the import).

## 3. Console (slice C; rules of `FA/CLAUDE.md`; every component under ~200 lines)

- **Entry.** `SupplierServices.tsx`: a second button before "Import services…", in the header and in the empty state:
  icon `bolt`, label `Quick add…`, the same `catalog:create` lock; new prop `onQuickAdd`. `supplierDialogState.ts` gains
  `{ kind: 'quick-add'; supplier: Supplier }`; `SupplierDetailPanel.tsx` and `SupplierDialogs.tsx` wire it to `QuickAddDialog`.
- **API** `api/quickAdd.ts` (exported from `api/index.ts`; JSDoc with `@route`, "backend addition, B214"):
  `listServiceGroups(id)`, `startQuickAdd(id, body)`, `getQuickAddRun(id, runId)`. **Types** `types/quickAdd.ts` (re-exported
  from `types/index.ts`): `ServiceGroup`, `ServiceGroupTotals`, `ServiceGroups`, `QuickAddBody`, `QuickAddRun`, `QuickAddFailure`.
- **Hooks** `hooks/useQuickAdd.ts`: `useServiceGroups(supplierId, enabled)` (key `SUPPLIER_GROUPS_KEY = ['api', 'suppliers',
  'service-groups']`), `useStartQuickAdd(supplierId)` (no error toast), `useQuickAddRun(supplierId, runId)` with
  `refetchInterval: 1500` while the run is `queued` or `running`, else `false`. When a run finishes: invalidate
  `staleSupplier(id)`, `{ resource: 'services' }`, `SUPPLIER_CATALOGUE_KEY`, `SUPPLIER_GROUPS_KEY`, `SUPPLIER_STALE_KEYS`.
- **Pure** `lib/quickAdd.ts` (+ test): `groupKey(group)` (`type` + `'\u0000'` + `remoteGroup`), `pickedTotals(groups, picked)`,
  `quickAddBody(groups, picked, serviceStatus)` (**`{ scope: 'all' }` when every group with `addable > 0` is picked**, else
  `groups`), `isLive(run)`, `progressRatio(run)`, `resultLines(run)`.
- **`QuickAddDialog.tsx`** (`Modal`, `size="lg"`, title `Quick add from <supplier>`), three steps. It opens on step 3 when
  `latestRun` is `queued` or `running`.
  1. **Groups** (`QuickAddGroups.tsx`). Sub: `Add whole groups of this supplier's services at once. Only services that are not
     in the console yet are added.` A `SearchInput` `Search groups` (filters the rows in the browser; Enter does not submit). A
     table (`max-h-[360px]`, caption `Supplier groups`): a header tick box `Select all groups` (ticks every shown row with
     something to add; indeterminate when some), then per row a tick box (disabled when `addable` is 0), `Group` (the name, `No
     group` when empty, and the `TypeTag`), `To add` (`addable`), `In console` (`imported`), `Cannot add` (`unavailable +
     unsupported`, `–` when 0, title `<n> no longer listed by the supplier, <m> of a type the console cannot sell`). Under it,
     `aria-live`: `<n> groups picked, <sum> services to add`. A `RadioGroup` `Add them as`: `active` `On sale` / `Merchants can
     order them at once, at the suggested price.`; `disabled` `Switched off` / `Check them on the Services page and switch them
     on yourself.` (default `active`). When `latestRun` is finished, one muted line: `Last quick add <time ago>: <created>
     added` or `Last quick add <time ago> stopped: <error>`. Footer: `Cancel`, primary `Review` (disabled with nothing picked).
     More than 500 groups picked and not all: error `Pick at most 500 groups, or select all.` States: loading skeleton;
     `ErrorState` `Could not load the supplier's groups`; no groups: `EmptyState` `No services yet` / `Sync the supplier to copy
     its service list.`; `totals.addable` 0: `EmptyState` `Nothing to add` / `Everything this supplier lists is already in the
     console, or cannot be added.`
  2. **Review** (`QuickAddReview.tsx`). `This adds <sum> services from <n> groups of <supplier>.` (`from all its groups` for
     `all`). Lines: `Each becomes a service in a category named after its group. Missing categories are created.` · `Price: the
     supplier's cost plus the default minimum profit. Use Bulk price change on the Services page afterwards.` · `Order fields
     and quantities are copied from the supplier.` · `Services already in the console are not changed.` · `They are added on
     sale.` / `They are added switched off.` Then the picked groups with their counts (the first 10, then `+<n> more`). Above
     500 services a `CheckboxField` `I checked the groups. Add <sum> services.` must be ticked. Footer: `Back`, primary `Add
     <sum> services`.
  3. **Progress** (`QuickAddProgress.tsx`). `queued`: `Waiting to start…`. `running`: a `Meter` (label `Quick add progress`) and
     `<processed> of <total> services, <created> added`. The footer has only `Close`, with the note `It keeps running after you
     close this. Open Quick add again to see it.` `succeeded`: `<created> services added`, and when not 0 `<skipped> skipped
     (already in the console or no longer available)`, `<categoriesCreated> categories created`, `<failed> could not be added`
     with the names from `failures`; a success toast `<created> services added from <supplier>`; footer `Add more` (back to
     step 1, groups refetched) and `Close`. `failed`: the `error`, the same counts, `Start it again: it continues with what is
     left.`, footer `Back to groups` and `Close`.
- **Errors of `POST`**: `JOB_ALREADY_RUNNING` → refetch the groups and show step 3 for `latestRun`; `422` (`nothing_to_add`) →
  the server's message in the dialog's error slot and the groups refetched; anything else → `errorText` in the error slot.
- **Picker** (`ImportPicker.tsx`): a `SelectField` `Group` before the tick box filter: `All groups`, then every named group as
  `<name> (<TYPE>)` from `useServiceGroups`; choosing one sends the filters `remoteGroup` and `type` (`useSupplierCatalogue`
  gains `group?: { type: string; remoteGroup: string }`, part of the query key) and goes to page 1. The existing header tick
  box then ticks the page of that group. No "tick the whole group" there: that is what Quick add is for.
- **Mocks**: `mocks/quickAddRoutes.ts` (registered in `mocks/handlers.ts`): the three routes over the seed catalogue with the
  bucket rule of §2.2; `POST` applies the refusals of §2.2, creates the services at once through the creation code of
  `mocks/catalogueRoutes.ts` (move it to a shared `createFromItem` there) and stores the run; the first `GET` of a run answers
  `running` with half the count, the next `succeeded` (so the progress step is seen). The mock services list needs nothing new
  (`applyListQuery` already filters any row key). The seed must hold at least three groups, one of them fully imported and one
  with an unavailable item.
- `FA/docs/MISMATCHES.md`: one line under M10 (`M10b`): the Quick add routes and the three list filters are backend additions
  (B214, B215).
- **Tests**: `lib/quickAdd.test.ts` (keys, totals, `all` versus `groups`, lines); `api/suppliers.test.ts` (the three functions:
  method, path, body); new `pages/SupplierQuickAdd.test.tsx` (the button and its permission lock; groups with counts and
  disabled rows; search; select all sends `{ scope: 'all' }`; two groups send `groups`; `Switched off` sends `serviceStatus:
  'disabled'`; the tick box above 500; progress then result; a failed run; reopening on a running `latestRun`; the `409` and
  `422` paths; empty states); `pages/SupplierServices.test.tsx` (the picker's group filter sends both filters and resets the
  page).

## 4. Contract and docs

- **`scripts/map-additions/26.mjs`** (group `suppliers`, module `suppliers`, stage 26, spec `B-TBD supplier-quick-add`):

  | Row | `a` | `t` | `successStatus` | `f` / `en` |
  |---|---|---|---|---|
  | `GET /admin/suppliers/:id/service-groups` | `suppliers:read` | `supplier_services`, `service_supplier_links`, `supplier_import_runs` | 200 | `مجموعات خدمات المورد مع الأعداد وآخر إضافة سريعة` / `The supplier's service groups with counts and the latest quick add.` |
  | `POST /admin/suppliers/:id/quick-add` | `catalog:create` | `supplier_import_runs`, `outbox_events`, `audit_logs` | 202 | `إضافة سريعة: إضافة خدمات المورد حسب المجموعة أو كلها في الخلفية` / `Quick add: add the supplier's services by group, or all of them, in the background.` |
  | `GET /admin/suppliers/:id/quick-add/:runId` | `suppliers:read` | `supplier_import_runs` | 200 | `حالة الإضافة السريعة وتقدّمها` / `The state and progress of a quick add.` |

- Slice B runs `bun run routes:build`, `contract:docs`, `docs:openapi`, `coverage:build`, `format` and includes the regenerated
  files. The three routes are built in the slice, so `test/contract/pending.ts` gets no entry; no allowlist entry; no
  optional-until key (the routes are new, the list change is query-only). Each contract has a request and a response example.
- `docs/queues.md`: replace the "none yet" lines of **imports** with §2.3 (job, payload, the claim and the guarded progress,
  "recorded in `supplier_import_runs`", 1 attempt, the 5-minute stall rule, start again = resume) and add the row
  `supplier.quick_add` | `imports` | `supplier_quick_add` | `runId`, `supplierId` (aggregate: `supplier_import_runs`) | suppliers
  (`QuickAddOutbox`, loaded by the API and the worker), written by `POST /admin/suppliers/:id/quick-add` to the outbox table.
  `docs/cache-keys.md`: no change.
- READMEs: `suppliers/README.md` (routes table, owned tables 4 → 5, a "Quick add (feature 26, B214)" section, the job row, the two
  audit phrases, the consumed event); `catalog/README.md` (`ServiceImporter`: `status`, `categoryCreated`).
- Lead, after **both** merges: replace `B-TBD supplier-quick-add` by `B214`; append B214 and B215 to `extra` of
  `docs/contract/lead-decisions.json` (positional: indexes 109 and 110); `bun run routes:build && bun run contract:extract &&
  bun run contract:harvest` (the two new console `GET` routes are harvested or get a `known-gaps.json` entry) `&& bun run
  contract:docs && bun run docs:openapi && bun run coverage:build && bun run check`; console `npm run mocks:live`; `db:migrate`
  on the owner's database.
- **B214 (proposal).** area `suppliers`; route `GET /admin/suppliers/:id/service-groups, POST /admin/suppliers/:id/quick-add,
  GET /admin/suppliers/:id/quick-add/:runId`; conflict: "The map has only the import of picked services (at most 500 ids, done
  inside the request). The owner asked on 2026-11-11 to add a supplier's services by whole group, or all of them."; decision:
  "Lead record (feature 26, decision 035). Three routes beyond the map. A group is the pair (type, remoteGroup). The listing
  counts each service once: imported, unavailable, unsupported or addable, and carries the latest run. A quick add takes a scope
  (all, or 1 to 500 groups), never ids; the server builds the list. It only creates: services not imported yet, still available
  and of an importable type, with the import's rules (category by type and group, suggested price, fields, quantity rule), on
  sale by default or switched off when asked; it never changes a service that exists. It answers 202 and runs in the worker
  (queue imports, outbox event supplier.quick_add) in chunks of 100 under the supplier row lock; the run is the new table
  supplier_import_runs (one live run per supplier, a unique index), which the console polls. Refusals: 409 SUPPLIER_DISABLED,
  409 JOB_ALREADY_RUNNING, 422 nothing_to_add on scope. A run without a heartbeat for 5 minutes reads as failed and the next
  start closes it; starting again continues with what is left; an item that cannot be created is reported (at most 20, then the
  run stops). Two audit rows per run: started quick add from (the staff member) and quick added services from (the system, with
  the counts)."; status `decided`.
- **B215 (proposal).** area `suppliers`; route `GET /admin/suppliers/:id/services`; conflict: "The list could not be narrowed to
  one supplier group, so the import picker showed the group only as text."; decision: "Lead record (feature 26). Three filters
  are added: remoteGroup and type (exact text) and isAvailable (boolean). An empty value is skipped, so the group without a name
  cannot be filtered. Rows, sorts and search are unchanged."; status `decided`.

## 5. Slices (parallel; no shared file)

**B. Backend** (`../backend-26`). Create `scripts/map-additions/26.mjs`; in `src/modules/suppliers/`: `domain/quick-add.ts`
(+ `.spec.ts`), `infra/quick-add.repository.ts`, `application/imported-service.ts`, `application/quick-add.service.ts`,
`application/quick-add-runner.ts`, `application/quick-add-outbox.ts`, `contracts/quick-add.contracts.ts`,
`controllers/quick-add.controller.ts` (the staff id from `@CurrentStaff()`), `jobs/quick-add.processor.ts`;
`test/integration/supplier-quick-add.test.ts`. Edit `scripts/module-map.mjs`; `suppliers/db/schema.ts`,
`supplier-engine.module.ts`, `suppliers-admin.module.ts`, `jobs/supplier-jobs.module.ts`, `index.ts`,
`application/supplier-catalogue.service.ts`, `infra/supplier-catalogue.repository.ts`, `contracts/suppliers.contracts.ts`,
`README.md`; `catalog/application/service-importer.ts`, `catalog/README.md`; `docs/queues.md`;
`test/integration/suppliers-admin.test.ts`; generated `drizzle/0030_*`, `docs/route-manifest.*`, `docs/slices/*`,
`docs/contract/endpoints/suppliers.md`, `docs/contract/openapi*.json`, `docs/COVERAGE.md`. Not touched: orders, money, customers,
storefront, the sync, the drivers, the seed, the health module. Acceptance: §2 as written; every existing test passes
unchanged; `bun run format`, then `bun run check` green (heavy runs through `bash scripts/with-slot.sh …`). Report: files by
folder, the migration name, anything in §2 the code forced to differ.

**C. Console** (`../frontend-admin-26`). Create `src/features/suppliers/api/quickAdd.ts`, `types/quickAdd.ts`,
`hooks/useQuickAdd.ts`, `lib/quickAdd.ts` (+ test), `components/QuickAddDialog.tsx`, `QuickAddGroups.tsx`,
`QuickAddReview.tsx`, `QuickAddProgress.tsx`, `mocks/quickAddRoutes.ts`, `pages/SupplierQuickAdd.test.tsx`. Edit `api/index.ts`,
`types/index.ts`, `hooks/keys.ts`, `hooks/useSupplierCatalogue.ts`, `components/SupplierServices.tsx`,
`SupplierDetailPanel.tsx`, `SupplierDialogs.tsx`, `supplierDialogState.ts`, `ImportPicker.tsx`, `mocks/handlers.ts`,
`mocks/catalogueRoutes.ts`, the seed files when a group is missing, `api/suppliers.test.ts`,
`pages/SupplierServices.test.tsx`; `docs/MISMATCHES.md`. Acceptance: `npm run typecheck`, `npm run lint`,
`VITE_API_MOCKS=false npm run build`, `npm test`, all green.

Order: B and C start together (C works against its mocks). The lead reviews and squash-merges B, then C, then runs §4's
post-merge step, then §7.

## 6. Tests

| File | Covers |
|---|---|
| `suppliers/domain/quick-add.spec.ts` (new) | `uniqueGroups`; `isStalled` at the limit, for `queued` and `running`, never for a finished run; `runView` (`processed` = the three counts, a stalled run reads `failed` with `STALLED_ERROR`); `chunksOf`; `failureReason` |
| `test/integration/supplier-quick-add.test.ts` (new), with a `TestClock`; the job is run by calling `QuickAddRunner.run(runId)` and once through `QuickAddProcessor.process` with an outbox-shaped job | **Groups**: one row per `(type, group)`, each bucket, the totals, the order, `latestRun`; `404`; `403` without `suppliers:read`. **Start**: `202` with a `queued` run and its `total`, one `outbox_events` row `supplier.quick_add`, the `started quick add from` row with the actor; `403` without `catalog:create`; each body refusal (no groups, 501 groups, an unknown `scope`); `nothing_to_add`; `SUPPLIER_DISABLED`; a paused supplier is accepted. **Run, scope groups**: only the candidates of the picked groups become services (category by type and group, `IMP-<id>`, suggested price, fields, link of priority 1, the supplier's quantity rule), imported, unavailable and unsupported ones are not touched, other groups are not touched; counts, `categoriesCreated`, `succeeded`, the `quick added services from` row with actor `system`; the catalog version moved. **Scope all**: 250 candidates → 250 services in 3 chunks, `total` 250. **`serviceStatus: 'disabled'`**: the services are switched off. **Twice**: `run` called again does nothing; two `run` calls in parallel create each service once. **Concurrency**: two `POST`s in parallel → one `202`, one `409`, one live row; a run in parallel with `POST .../import` of the same ids → one service and one link per supplier service. **Item failure**: a supplier service written with credit `-1.0000` is `failed` with a `failures` entry while the rest of its chunk is created; 20 such rows end the run `failed`. **Stall and resume**: a `running` run, the clock moved 6 minutes → `GET` reads `failed` with `STALLED_ERROR`; a new `POST` closes it and its audit row has `closedStalledRun`; the old runner's next chunk rolls back; the new run adds only what is left. **Show**: `404` for a run of another supplier |
| `test/integration/suppliers-admin.test.ts` (extend) | the list filters `remoteGroup`, `type`, `isAvailable` (alone and together, with `x-total-count`); the picker import still answers and audits as before (unchanged assertions) |
| Contract suite | route, access and permission parity with the three rows; OpenAPI examples validate; no allowlist entry |
| Console | §3 "Tests" |

## 7. Storefront note (for the lead's handoff files)

The site is **not affected**: no `/store/v1` or `/client` route, key or code changes, and a service added by Quick add has no
retail price, so it is not on the site until staff price it (fact 11). Merchants' lists (`/client/services`, `/v1/services`,
Dhru `imeiservicelist`) simply gain the services added on sale. One line in `STOREFRONT-BACKEND-HANDOFF.md`'s status table; no
new section.

## 8. Decisions

Taken here (no owner input needed): the two scopes and the candidate rule; create-only; a scope, never ids; a background job on
`imports` for every quick add (one code path, also for a small group); the run table instead of `job_runs`; no automatic
retry, resume by starting again; chunks of 100; the 5-minute stall rule; 20 item failures stop a run; on sale by default with
a per-run "Switched off"; the suggested price; the group filter in the picker. Left out on purpose: a per-item preview of a
scope (the groups listing and the review step are the preview; the picker still previews items), a stop button (a run of 5000
lasts about a minute), updating changed costs by scope, re-adding a supplier service whose only link is an archived service, a
bulk "switch on" in the Services page.

**For the owner (not blocking):** "extract them all" is read as "add all of the supplier's services to the catalog". If a
downloadable list (CSV) of a supplier's services was meant as well, that is a separate small feature.

## 9. Review against the code, and approval

Checked in the code: the import, its lock and its refusals; `ServiceImporter` (category lookup, code, no dependencies);
`supplier_services` and its indexes; the list contract, its `COLUMNS` and the filter parser (empty values); the sync's lock;
the `imports` queue definition and its section in `docs/queues.md`; the outbox registration pattern (`RefundOutbox`) and the
job data shape; `JobRunsService` and `job_runs` (why they do not fit); `AuditService` (actor from the request context) and the
audit duty of `defineRoute`; the worker's module list; `module-map.mjs` (`additionalTables`) and the schema structure test;
the map-additions rules (groups, `successStatus`, static against parameter segments: none collides); `lead-decisions.json`
(`extra` has 109 entries, the last is B213); the error catalog (`JOB_ALREADY_RUNNING`, `SUPPLIER_DISABLED` exist; no new code);
the store's visibility rule; the console's dialog state, picker, hooks, keys, mocks (`applyListQuery`), `Meter`, `RadioGroup`,
`useRowSelection`, the `bolt` icon. Not verified: how long a real supplier's list of several thousand services takes on the
production database (the estimate of about 1 s per chunk is from the statement count), and the exact `createTestApp` wiring a
direct `QuickAddRunner` call needs (the implementer follows `test/support/campaigns.ts`).

**Approved by Fable 5.2 (2026-11-11)**
