# Bulk publish (`src/modules/storefront/publish`)

Put services on the shop in bulk (feature 31, decision 040, plan `docs/briefs/31-bulk-publish.md`): staff pick a scope, read a preview
(a **draft** kept on the server), correct it, and apply it; a background job publishes one service per transaction. The draft changes
nothing a visitor or a merchant can see: a preview writes only `listing_publish_runs` and `listing_publish_items` (and, for "Check
again", the audit row of the draft it replaces).

This README describes the draft and what staff do with it: slice B4a (create, read, prepare) and slice B4b (edit a row, change many, apply
with the resume, cancel, the run switch). The engine of apply and of the switch (`PublishRunner`, `PublishSwitch`, `ListingPublisher`) is
slices B3a and B3b.

## Routes (staff; spec B228, `scripts/map-additions/31.mjs`)

| Route | Permission | What |
| --- | --- | --- |
| `POST /admin/publish-runs` | `storefront:create` | `{ scope, listed? }` answers `202`, the run in `preparing`. Scopes: `services` (1 to 500 ids), `category`, `supplier`, `quickAddRun`, `run` ("Check again" from a draft, "Review the rest" from a finished run), `all`. `422` on `scope`: `nothing_to_publish` (also when every ticked service has a listing), `too_many` (more than 5000); `422` with `invalid` on `scope.categoryId`, `scope.supplierId`, `scope.runId`; `409 CONFLICT` for a run that is still working, whose preview was never finished, or whose replacement is alive or was prepared. No audit row, except the `cancelled publishing run` of the draft "Check again" replaces. |
| `GET /admin/publish-runs` | `storefront:read` | the history; filters `status`, `source`, `quickAddRunId`; sorts `id` (default, newest first), `createdAt`. |
| `GET /admin/publish-runs/:id` | `storefront:read` | one run with its live counts. A live run (or switch) without a heartbeat for 5 minutes **reads** `failed`; a read never writes. |
| `GET /admin/publish-runs/:id/items` | `storefront:read` | the rows: filters `state`, `included`, `result` (`pending`), `flag`, `brandKind`, `afterId`; search `q` over title, slug, service name and code; sorts `id` (default), `title`, `cost`. |
| `PATCH /admin/publish-runs/:id/items/:itemId` | `storefront:create` (a price key also needs `pricing:update`) | edit one row of a draft: `title`, `slug` (`''` makes it from the title again), `brand`, `carrier`, `country`, `retailPrice`, `pricing` (`rule`, `keep`), `included`, `reset` (alone); answers `200` with the row judged again. `409` when the run is not a draft or the service is gone; `422` with a field and a code (see Editing a draft). No audit row. |
| `POST /admin/publish-runs/:id/items/bulk` | `storefront:create` | `{ select: { itemIds } or { filter }, set: { included, brand, carrier, country } }` answers `{ changed, refused }`. No audit row. |
| `POST /admin/publish-runs/:id/apply` | `storefront:publish` | `{ listed? }` answers `202`, the run `queued`; a run that failed or stalled resumes. `409 JOB_ALREADY_RUNNING`, `409 CONFLICT`, `422` `nothing_included`. Audited. |
| `POST /admin/publish-runs/:id/cancel` | `storefront:create` (a run that is `queued` or `running` also needs `storefront:publish`) | `{}` answers `200`, the run `cancelled`. `409` for a run that is over. Audited. |
| `POST /admin/publish-runs/:id/listed` | `storefront:publish` | `{ listed }` answers `202`, `switch.status = 'queued'`: take what the run published off the shop, or put it back. Audited. |

## Layers

| Layer | Files |
| --- | --- |
| Contracts | `contracts/publish-runs.contracts.ts` (create, list, show, items; `PublishRunSchema`, `PublishItemSchema` and the scope), `contracts/publish-run-actions.contracts.ts` (edit a row, bulk, apply, cancel, switch) |
| Controllers | `controllers/publish-runs.controller.ts`, `controllers/publish-run-actions.controller.ts` (the second permissions) |
| Application | `application/publish-run-admin.service.ts` (create, list, show, items, apply, cancel, switch), `publish-item-edit.service.ts` (the row `PATCH` and `bulk`), `publish-item-views.ts` (the wire rows), `publish-permissions.ts`, `publish-preparer.ts` (the job), `publish-from-quick-add.ts` (the Quick add hand-over), `publish-scope.ts` (the walk of a scope), `publish-draft-facts.ts` (the facts a row is judged on), `publish-outbox.ts` (events), `publish-runner.ts`, `publish-switch.ts` |
| Domain (pure) | `domain/publish-item.ts` (states, flags, the price of a row, the stall rule), `publish-draft.ts` (what a draft row stores), `publish-edit.ts` (what an edit turns a row into), `publish-moves.ts` (when apply, cancel and the switch are allowed), `publish-view.ts` (the wire row), `publish-run.ts`, `naming/` (title, slug, brand, carrier, country) |
| Infra | `infra/publish.repository.ts` (own tables: claims, guarded writes, the draft's edits), `infra/publish-read.repository.ts` (lists, counts, the selection of a bulk) |
| Jobs | `jobs/publish.processors.ts` (`publish_prepare`, `publish_apply`, `publish_set_listed`, `publish_from_quick_add` on the `imports` queue), `jobs/publish-outbox-routes.ts`, `jobs/publish-reconcile.ts` (the lost-work pass, decision 055) |
| Modules | `publish-engine.module.ts` (API and worker), `publish-http.module.ts` (API: the routes), `publish-worker.module.ts` (worker: the processors) |

## The scope

The rows of a run are the live services of the scope that have no listing (a switched-off listing counts as a listing). With the scope
`services` a ticked service that has a listing is a row too, `blocked: already_listed`, so staff see why. The scope is walked in keyset
pages of 1000 (`catalog/application/publish-sources.ts`), and the POST counts with the same walk the preparer inserts from. The scope
`supplier` is the services linked to any service of the supplier. The scope `quickAddRun` reads `service_supplier_links.import_run_id`
(migration `0045_quick_add_publish`, written by Quick add's `insertFirstLink`): the exact record of the services a Quick add run created.
`GET /admin/publish-runs?quickAddRunId=` finds the automatic run of a Quick add run (`source_run_id`) and a run staff started with that
scope.

## The Quick add hand-over (`publish_from_quick_add`, plan 31 section 6.3)

A Quick add run that asked to publish (`publish: { listed }`) and created at least one service writes the outbox event
`supplier.quick_add_done` (`runId`, `supplierId`, `requestedBy`, `listed`) in the transaction that closes it, succeeded or failed (also the
start that closes a stalled run). The suppliers module never imports the storefront, so `PublishOutboxRoutes` registers the route and
`PublishFromQuickAddProcessor` consumes it: `PublishFromQuickAdd.run` inserts the one automatic run of that Quick add run (`source =
quick_add`, `source_run_id`, scope `{ kind: 'quickAddRun', runId }`, `auto`, `listed`, `requested_by`) with `ON CONFLICT (source_run_id)
WHERE source_run_id IS NOT NULL DO NOTHING` (the conflict target repeats the partial index's predicate) and calls `PublishPreparer.run`. A
second delivery finds the run and does nothing. The close of the preparation queues `storefront.publish_apply` when a row is ticked, so the
ready rows go on the shop at the rules' prices without another click; the rows that need a person wait in the run (`skipped: left_out`),
and the run switch takes the whole run off the shop. A job that dies leaves no run, or one that reads `failed`: the console then offers
the scope `quickAddRun` by hand, and that `POST` closes the automatic run when it stalled while `preparing` (`PREPARE_STALLED_ERROR`), so a
worker that only slept finds nothing to finish and cannot publish beside the run staff started.

## Lost jobs (decision 055)

`PublishReconcilePass` (kind `publish_runs`, in `PublishWorkerModule`) is the bulk publish's pass of the platform's `lost_work_reconcile`.
It watches the three waits of a run, each by itself: a preparation nobody claimed (`preparing` with `prepare_claimed_at` null), a queued
apply (`queued`) and a queued run switch (`switch_status = 'queued'`). When the newest request of that wait has had no live job for 10
minutes it writes the same event again (`PublishOutbox.prepareRequested | applyRequested | switchRequested` with `reconcile: true`; the
switch repeats `switch_listed` and the staff member of the last request), under the run's lock after the same check. After three
re-requests it writes nothing: the run already reads as stalled after five minutes without a heartbeat, and staff resume it. Every job
claims with a guarded update, so a request that arrives after staff moved the run on claims nothing. The Quick add hand-over
(`supplier.quick_add_done`) is not asked for again: the console offers the scope `quickAddRun` by hand (above).

## Prepare (`publish_prepare`)

1. Claim: `prepare_claimed_at` set where the run is `preparing` and unclaimed; no row, nothing to do.
2. The services of the scope, at most 5000 (more: the first 5000 and a note in `error`: `scopeTruncatedError`). The note stays through the
   apply, a resume and a close that succeeds; only a run that fails writes over it.
3. The rows, in batches of 500; a copied row arrives with what it keeps.
4. Detection in memory over the whole run (`nameAll`, `assignSlugs`): the cut of a title and the uniqueness of titles and slugs need every
   title. A service whose type is `imei`, or that has a field that is the supplier's main box (`isMainInputKey(resolvedSupplierKey(field))`),
   is named by the IMEI rules, so a `server` service made by decision 042 keeps its carrier and device brand.
5. Evaluation on the facts of now (`evaluateItem`, `decidePrice` with the row's cost as the cost of now, so `cost_moved` never arises in a
   draft); one `UPDATE ... FROM (VALUES ...)` per 200 rows; a guarded heartbeat after every batch and page.
6. Close, guarded on `preparing`: `total`, `prepared_at`, `draft`; an `auto` run with a ticked row becomes `queued` with the event
   `storefront.publish_apply` and the audit row of the start by `system`.
7. An unexpected error closes the run `failed` with its message and rethrows.

The default tick: `ready` is ticked; `review` (a hard flag) and `blocked` are not. A service that already has a retail price keeps it
(`keep`, flag `price_kept`).

## "Check again" and "Review the rest" (scope `run`)

- From a `draft`: the old run is locked `FOR UPDATE`, cancelled in the same transaction (`replaced_by_run_id`, the audit row), and every
  row is taken. A second press on the old draft is `409` while its replacement is alive or once that was prepared (one live draft, never
  two over the same rows).
- **"Prepare again"**: when the replacement died before its preview was ready (`failed` or `cancelled` with no `prepared_at`, or still
  `preparing` with no heartbeat for five minutes), the console sends the same scope again. The old draft is the only place left that holds
  the staff's edits, so its rows are copied once more and `replaced_by_run_id` moves to the new run. A replacement still stored `preparing` is
  closed `failed` (`PREPARE_STALLED_ERROR`) by the same transaction, so a worker that wakes up cannot finish a second draft. Nothing is
  cancelled here, so no audit row is written. The two run rows are locked older first.
- From a `succeeded`, `failed` or `cancelled` run (or one that stalled): the rows without a `published` result are taken; the old run is
  left as it is. A `preparing`, `queued` or `running` run that is not stalled is `409`, and so is a run whose preview was never finished
  (`prepared_at` is null): its rows are partial.
- A copied row keeps its price choice (never `replaces_price`) and its tick when staff changed it from the default of the row's state; a row
  staff edited keeps its title, its three facts and its detection (`detected`), a typed address stays an address staff typed. Every row is
  evaluated afresh, so a price that fell under the floor reads `blocked: below_floor`, an address a listing took reads `blocked: slug_taken`,
  and a row whose obstacle is gone becomes `ready` and ticked. A service archived or listed meanwhile is not copied.

## Editing a draft (`PATCH` and `bulk`)

Both write only `listing_publish_items`. The locks are those of plan 31 section 6.5: the row `PATCH` takes the run row `FOR SHARE` and checks
that it is a `draft` under that lock, then the item row `FOR UPDATE`, changes the row, judges it on the facts of now (read without the
service lock: a draft decides nothing, apply decides again under it) and writes it with **one** `UPDATE`. Apply, cancel and "Check
again" take the run row `FOR UPDATE`, so an edit and a move of the run never interleave: either the edit commits first and apply publishes
the edited row, or apply moves the run first and the edit answers `409`. A `bulk` takes the run row `FOR UPDATE` itself (one at a time, and
none during an apply).

- **The keys.** `title` (1 to 200, one line), `slug` (a valid address; `''` makes it from the title with the next free suffix against the
  listings and the other rows; an address that was not typed follows an edited title, as a copy of the draft does), `brand` and `carrier`
  (at most 80), `country` (two letters or empty), `retailPrice` (`manual`), `pricing` (`rule`: the rule price, and the typed price the service
  has now is stored as `replaces_price`; `keep`), `included`, `reset` (back to `detected`, alone in the body). Every price key, and `reset`,
  clears what the others set; every evaluation normalises the mode against the price the service has now (`normalisePriceMode`).
- **The answer is the row judged again.** A row the new facts block (the service was disabled since, a typed price under a floor that rose)
  is stored `blocked` and unticked with `200`; leaving `blocked` ticks it by the default of its new state, unless the body sends `included`.
  `included: true` on a row that is blocked after the change is `422` on `included` (`blocked`, the sentence of the reason).
- **`422` and `409`.** `retailPrice`: `invalid` (zero or less), `below_floor` ("Below the storefront floor of $X."), `conflict` (with
  `pricing`); `slug`: `invalid`, `duplicate` (a listing or another row holds it); `pricing`: `invalid` (`keep` with no retail price);
  `reset`: `conflict` with any other key. `409`: the run is not a draft ("This run is no longer a draft."), or the service is gone.
- **The flags.** `reflag` works out again the flags that derive from the edited fields; a reset also gives back the flags of the supplier
  name that an earlier edit dropped (`detectFacts`), each kept only while its field holds the detected value. `title_taken` is asked for a
  changed title only. A `bulk` of the facts does the same for each row, in pages of 500 (`UPDATE ... FROM (VALUES ...)`); a fact never
  blocks or unblocks a row and no tick moves; `changed` counts the rows whose value differed, `refused` the blocked rows that could not take
  `included: true`.
- **The second permission.** A body with `retailPrice` or `pricing` needs `pricing:update` as well, the permission of a retail price on the listing route (decision 046; the controller reads the role with
  `grants`): `403 FORBIDDEN` naming it. So does `reset` on a row that holds a typed price or a rule chosen over a typed price (the use
  case decides it under the row lock): a reset would throw that choice away. A reset of any other row needs only the route's permission.

## Apply, cancel and the run switch

- **Apply** (`storefront:publish`): one transaction with the run row `FOR UPDATE`, then the verdict of its status (`domain/publish-moves.ts`):
  a `draft` with a ticked row is applied; a run that `failed`, or that was `queued` or `running` and stalled (five minutes without a
  heartbeat), **resumes** when its draft was prepared (`prepared_at`): the rows with a result stay, the rows `refused: failed` are set back to
  no result (here, under the run row lock, where no worker can be inside a row), the rest continues; a run that is alive, or whose switch is
  alive, is `409 JOB_ALREADY_RUNNING`; a preview still being prepared or never finished, or a finished run, is `409 CONFLICT`; a draft with no
  ticked row is `422` on `included`. It moves the run to `queued` (guarded: also on `prepared_at IS NOT NULL`), writes `storefront.publish_apply`
  and the audit row `started publishing to the storefront` (`resumed` says which). The worker that claims the run gets the next `attempt`. A
  resume also closes a switch that stalled (`switch_status = 'failed'`, `SWITCH_STALLED_ERROR`): the run and its switch share one heartbeat,
  so the switch would otherwise read alive again, and its late job would claim the run and stop the apply.
- **Cancel** (`storefront:create`; a run that is `queued` or `running` also needs `storefront:publish`, which the use case checks under the
  lock from the role the controller passes): allowed while `preparing`, `draft`, `queued` or `running` (the stored status, so a stalled run
  can still be stopped). The run row `FOR UPDATE` waits for the row in flight; the worker stops before the next one. The counters, `finished_at`
  and the audit row `cancelled publishing run` are written, and the catalog price version moves after the commit when a row was published.
- **The run switch** (`storefront:publish`): the run row `FOR UPDATE`; a finished run that published something is switched (`switch_status =
  'queued'`, the target in `switch_listed` and `listed`, the counters zeroed, the event `storefront.publish_set_listed`, the audit row
  `started switching publishing run`); a `queued` or `running` run that stalled is first closed `failed` by this transaction (`STALLED_ERROR`,
  the counters from the rows, its close audit row, and the price version when it published); a switch that is alive is `409
  JOB_ALREADY_RUNNING`.

## Tables and keys

Owns `listing_publish_runs` and `listing_publish_items` (`scripts/module-map.mjs`); `service_listings` is the storefront's own too.
Reads `services`, `service_categories`, `service_fields` and `staff_users` with plain selects (the DEVIATION note of
`infra/foreign-reads.repository.ts` and `infra/publish-read.repository.ts`), and through the catalog's public reads the retail price
rules and the existence of a category, a supplier and a Quick add run. No cache key.
