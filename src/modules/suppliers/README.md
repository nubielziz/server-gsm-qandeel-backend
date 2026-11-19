# Suppliers module (`suppliers`)

Map domain C. The suppliers we buy from: supplier accounts, their service catalogs, the links from our services to supplier services, the Dhru supplier client, the dispatch, poll and sync jobs, and the log of every supplier call.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 023 outbound HTTP, 026 Dhru compatibility, 042 real Dhru Fusion suppliers (feature 33), 020 queues and outbox, 019 credential encryption, 021 rate limiting, 025 order state machine, 031 clock. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 6, suppliers; quick add added by feature 26): the 13 routes of this module plus the three order routes that move an order to a supplier (`dispatch`, `fetch`, `change-supplier`, owned by the orders map but built here, because they read the supplier tables; they move the order through the orders module's `OrderSupplierMoves`), the Dhru supplier client behind a driver interface, the dispatch, poll and sync jobs, the demo seed and the scenarios `success`, `reject` and `timeout`. Not here: the supplier report (11), the system health supplier view (9, it reuses `supplierHealth`), Dhru and REST v1 for merchants (7a), the outgoing order events (7b). `GET /admin/reports/suppliers` is stage 11.

Structure: `contracts/` (zod contracts: the routes, and the four supplier calls), `controllers/` (thin), `application/` (use cases and the supplier client), `domain/` (pure rules, unit tested), `infra/` (Drizzle queries), `jobs/` (worker processors and schedules), `db/schema.ts`.
Three Nest modules: `SuppliersAdminModule` (routes and use cases, needs the database; listed in `NEEDS_DATABASE_AND_CACHE` of `test/support/app.ts`), `SupplierEngineModule` (client, sync, dispatch, poll, the quick add runner and its outbox: no routes, loaded by both processes) and `SupplierJobsModule` (processors and schedules, worker only).

## The supplier client (decision 026)

`SupplierClient` is the only place that calls suppliers. It decrypts the key for one call (AES-GCM with a key id, AAD `suppliers.api_key_enc`; the hint is the first 5 characters, written with the ciphertext and never decrypted on read), picks the driver (`dhru`; `rest` answers "REST suppliers are not supported yet" until a REST supplier exists) and calls through `OutboundHttp` (SSRF guard, required timeout `suppliers.timeout_ms`, no redirects). The Dhru request is a form post to `<baseUrl>/api/index.php` with `username`, `apiaccesskey`, `action`, `requestformat=JSON` and `parameters` in the form the supplier's row says (`suppliers.param_format`, decision 042): `dhru_xml` (the default of every Dhru supplier) is the classic XML string `<PARAMETERS><ID>..</ID><IMEI>..</IMEI><QNT>..</QNT></PARAMETERS>` that a Dhru Fusion site reads (`dhruParametersXml`: upper-case keys, `&`, `<`, `>` escaped, characters XML forbids removed), `json` is base64 of a JSON object (the standards v6.1 form of decision 026). `CUSTOMFIELD` is base64 of a JSON object in both. No route sets the form yet. Actions: `accountinfo`, `imeiservicelist`, `placeimeiorder`, `getimeiorder`. Production needs `https`; the setting `suppliers.allowPlainHttp` (editable in the settings screen) is the admin-visible opt-out. Tests provide `SUPPLIER_TARGET_POLICY` to reach a local fake supplier.

Every call returns a record that the caller writes to `supplier_api_logs` (the readable, redacted `request` names the `format` its parameters were sent in): `http_status` (0 without an HTTP answer), `duration_ms` (the time waited), `error` (`''` when fine) and the `outcome` `ok | error | timeout` (`timeout` = no HTTP answer in time; `error` = anything else: network error, HTTP >= 400, unusable body, a Dhru ERROR even on HTTP 200). Credentials and IMEIs are masked in the stored bodies (`redactBody`); a service list keeps only its count. `SupplierThrottle` applies `max_concurrency` (a semaphore) and `rate_limit_per_min` (the `supplier` limiter).

## Dispatch, poll and sync

See `docs/queues.md` (`supplier-dispatch`, `supplier-poll`, `supplier-sync`). In short: the dispatch job claims the order with a guarded update before the call and never sends twice; a REFERENCEID gives `sent`, a refusal, a timeout or no eligible link gives `needs_attention` with the reason and the hold kept; nothing is re-sent automatically. The automatic dispatch never fails over to a link that costs more than the price charged (user rule 9, B117 (6)); a staff `dispatch` or `change-supplier` may (the `supplier_changed` event records `costAbovePrice`). The poll tick (every minute) finds the sent orders that are due and queues a `poll` job each; STATUS 4 completes the order, STATUS 3 rejects it. `price_sync` (every 15 minutes) and `balance_check` (every 30 minutes) go through every supplier that is not disabled; staff's `POST /admin/suppliers/:id/sync` runs the same sync in the worker and waits for its counts (`504 SUPPLIER_TIMEOUT` after `timeout_ms + 5 s`).

Money: a supplier's result settles the order through `OrderTransitions`: the hold becomes revenue and, because the order has `supplier_id` and `supplier_ref`, the cost (`credit x credit_rate`, refreshed on the order when the supplier is chosen) is booked from the prepaid balance at the supplier (B17); a rejection releases the hold with no cost.

## Public API (`index.ts`)

Exports the modules (`SuppliersModule`, `SuppliersAdminModule`, `SupplierEngineModule`, `SupplierJobsModule`), the health rules (`supplierHealth`, `healthFromCalls`, `toPageHealth`, `runwayDays`, `isLowBalance`: the system health view of feature 9 reuses them), the link rules (`pickLink`, `linkUnitCost`), the four supplier call contracts (`SUPPLIER_CALLS`), `SupplierDirectory` (supplier names for other modules), `SupplierReader`, `SupplierDispatch`, `SupplierPoll`, `SupplierSync`, `QuickAddRunner` (feature 26), the vocabularies and row types, and the test policy token. Other modules import only `src/modules/suppliers/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 5 tables (`scripts/module-map.mjs`; `supplier_import_runs` is an `additionalTables` entry, feature 26); other modules call its public services. Schema: `db/schema.ts`. Deviations: the orders module names `supplier_api_logs` in one SQL text (`order-supplier.repository.ts`, the poll candidates) and reads `suppliers` for names; the money module reads `suppliers` for ledger owner names; `foreign-reads.repository.ts` here reads `services` and `service_fields` (the catalog exports no service reader) and `service_checks` and `imei_checks` are read with plain selects (health and risk export no reader yet). Writes to the catalog go through the catalog's `ServiceImporter` and `recomputeEffectiveCost`.

| Table | What it holds |
|---|---|
| `suppliers` | Supplier connections and your balance with each one. |
| `supplier_services` | A copy of a supplier's services after a sync. |
| `service_supplier_links` | Links your service to a supplier service, in priority order. `import_run_id` (feature 31) names the quick add run that created the service. |
| `supplier_api_logs` | A log of every request sent to a supplier. |
| `supplier_import_runs` | The record of one quick add (feature 26): scope, counts, progress and heartbeat; one live run per supplier. `publish_mode` (feature 31) says whether it also puts what it creates on the shop. |

## Routes

19 routes are built (the 13 below, the three quick add routes of feature 26 and the three order routes). Source: `docs/slices/suppliers.json` (generated from the map; `bun run routes:build`). Contracts are under `contracts/`.

### Admin console

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/suppliers` | staff-permission · `suppliers:read` | Suppliers with health, order counts, runway and balance verdict. | 6 |
| `GET /admin/suppliers/:id` | staff-permission · `suppliers:read` | One supplier with its 24-hour history and linked services. | 6 |
| `POST /admin/suppliers` | staff-permission · `suppliers:create` | Add a supplier (the key is encrypted, the hint stored). | 6 |
| `PATCH /admin/suppliers/:id` | staff-permission · `suppliers:update` | Change a supplier, switch it active, paused or disabled. | 6 |
| `DELETE /admin/suppliers/:id` | staff-permission · `suppliers:delete` | Delete a supplier nothing refers to (`409 SUPPLIER_IN_USE`). | 6 |
| `POST /admin/suppliers/:id/test` | staff-permission · `suppliers:update` | Test the connection through `accountinfo`. | 6 |
| `POST /admin/suppliers/:id/sync` | staff-permission · `suppliers:update` | Sync services and balance now (through the worker). | 6 |
| `GET /admin/suppliers/:id/services` | staff-permission · `suppliers:read` | The supplier's services after syncing; filters `imported`, `remoteGroup`, `type`, `isAvailable` (the last three: feature 26, B215). | 6 |
| `POST /admin/suppliers/:id/import/preview` | staff-permission · `catalog:create` | Preview the import: new, matching and changed services with the suggested price. | 6 |
| `POST /admin/suppliers/:id/import` | staff-permission · `catalog:create` | Import the selected items as services, fields and links. | 6 |
| `GET /admin/suppliers/:id/service-groups` | staff-permission · `suppliers:read` | The supplier's service groups with counts, and its latest quick add (beyond the map, B214). | 26 |
| `POST /admin/suppliers/:id/quick-add` | staff-permission · `catalog:create` | Quick add: add the supplier's services by group, or all of them, in the background (`202`; beyond the map, B214). | 26 |
| `GET /admin/suppliers/:id/quick-add/:runId` | staff-permission · `suppliers:read` | The state and progress of a quick add (beyond the map, B214). | 26 |
| `PUT /admin/services/:id/supplier-links` | staff-permission · `catalog:update` | Link the service to suppliers in priority order. | 6 |
| `GET /admin/supplier-api-logs` | staff-permission · `suppliers:read` | Log of supplier requests and responses. | 6 |
| `GET /admin/supplier-api-logs/:id` | staff-permission · `suppliers:read` | One call with its masked request and response. | 6 |
| `GET /admin/reports/suppliers` | staff-permission · `reports:read` | Supplier spend, rejection rate and speed. | 11 |

### Order moves (orders map, built here)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `POST /admin/orders/:id/dispatch` | staff-permission · `orders:update` | Staff retry: `pending` and the dispatch job queued. | 6 |
| `POST /admin/orders/:id/fetch` | staff-permission · `orders:update` | Ask the supplier for the result now. | 6 |
| `POST /admin/orders/:id/change-supplier` | staff-permission · `orders:update` | Change the supplier and/or reset the reference. | 6 |

### Supplier calls (outgoing)

These are calls this backend makes, not routes it serves. Each has a contract made with `defineSupplierCall` (`src/common/contract/define-supplier-call.ts`, registry `supplierCallRegistry`) in `contracts/supplier-calls.contracts.ts` (feature 6b): the manifest key, the schema of the decoded `parameters` we send (the driver builds its request as that type), the schema of the `SUCCESS` entry we accept, the shape of an `ERROR` entry and validated examples. The client reads every answer through its contract (`readAccountInfo`, `readServiceList`, `readPlacedOrder`, `readOrderStatus` in `domain/dhru-protocol.ts` call the schema first), so changing what the client reads without changing the contract fails a test. The tolerance did not change: extra fields are ignored, a field of the wrong type counts as missing, and only the fields the client needs can make a call unusable (the credit, the `REFERENCEID`, the `STATUS`); a service of a list that has no id, name or readable price is skipped, never the whole list. The internal OpenAPI document lists the calls in `x-gsm-supplier-calls`; the public one does not.

| Call | What it does | Unusable answer |
|---|---|---|
| `SUPPLIER accountinfo` | Our balance at the supplier (test, sync, balance check). | no `AccoutInfo` (or `AccountInfo`) block with a readable `credit` |
| `SUPPLIER imeiservicelist` | The supplier's services and their cost, for the sync. | none: a list that cannot be read is empty |
| `SUPPLIER placeimeiorder+placeimeiorderbulk` | Send the order and store `supplier_ref` (the dispatch job). The bulk variant is described but never sent: one order is one job. | no `REFERENCEID` |
| `SUPPLIER getimeiorder+getimeiorderbulk` | Poll the status and the result (the poll job, `fetch`). `STATUS` 4 completed, 3 rejected, 0 and 1 (and 2) running. The bulk variant is described but never sent: one poll job asks about one order. | no known `STATUS` |

## Scenarios

Walked end to end by `test/e2e/{success,reject,timeout}.e2e.test.ts` against a fake Dhru supplier served in the test (`test/support/suppliers.ts`); 7a adds the merchant's Dhru steps to the same files. Other scenarios touching this module: `b2c-paid`, `b2c-ticket`, `system-alert` (later features).

## Permissions

Staff permissions the routes need: `suppliers:read`, `suppliers:create`, `suppliers:update`, `suppliers:delete`, `catalog:create`, `catalog:update`, `orders:update`, and `reports:read` for the report of stage 11. They come from the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced: `supplier.quick_add` (queue `imports`, job `supplier_quick_add`, payload `{ runId, supplierId }`, aggregate `supplier_import_runs`; `QuickAddOutbox`, written by `POST /admin/suppliers/:id/quick-add`) and `supplier.quick_add_done` (feature 31: payload `{ runId, supplierId, requestedBy, listed }`, aggregate `supplier_import_runs`; written by the transaction that closes a run that asked to publish and created services; its route and job `publish_from_quick_add` belong to the storefront). Consumed: `order.dispatch_requested` (queue `supplier-dispatch`, payload `{ orderId }`, written by the orders module) and `supplier.quick_add` (queue `imports`, `QuickAddProcessor` in the worker). Audit phrases written (the console prints `<actor> <action> <entityLabel>`): `added supplier`, `edited supplier`, `paused supplier`, `resumed supplier`, `disabled supplier`, `enabled supplier`, `deleted supplier`, `tested connection to`, `synced services from`, `imported services from`, `started quick add from` (the staff member, when the run is queued), `quick added services from` (the system, when the run ends), `changed supplier links of` (entity `service`), `adopted the supplier's input` and `made the supplier's required fields required` (entity `service`, the system, by the sync: feature 33), and on orders `dispatched order`, `changed supplier of`, `fetched supplier result of`.

## Jobs and schedules

| Queue | Job | Schedule | Notes |
|---|---|---|---|
| `supplier-dispatch` | the outbox event `order.dispatch_requested` | event-driven | `SupplierDispatchProcessor` |
| `supplier-poll` | `supplier_poll_tick`, `poll` | tick every minute (`supplier-poll-tick`) | `SupplierPollProcessor` |
| `supplier-sync` | `supplier_sync`, `price_sync`, `balance_check` | every 15 and every 30 minutes (`supplier-price-sync`, `supplier-balance-check`) | `SupplierSyncProcessor`, scheduled runs in `job_runs` |
| `imports` | `supplier_quick_add` (outbox event `supplier.quick_add`) | event-driven | `QuickAddProcessor` calls `QuickAddRunner.run`; recorded in `supplier_import_runs`, not in `job_runs` |

Idempotency keys, retry policies and the claim rule: `docs/queues.md`. Settings read: `catalog.importDefaultSlaMinutes` (default 1440), `orders.poll_slow_after_hours` (default 24), `suppliers.allowPlainHttp` (default off), all editable through `PATCH /admin/settings`.

## Cache keys

None of its own. The per-supplier semaphore and limiter use the general keys of `docs/cache-keys.md` (rate limits); the catalog price version is moved after a sync, an import and a change of a chain (`CatalogPriceVersion.bumpAfterCommit`).

## Supplier quantity rule (feature 25, MISMATCHES B213)

A Dhru supplier states a service's quantity in four fields of its `imeiservicelist` entry: `QNT` (`1` = takes a quantity), `MINQNT`,
`MAXQNT` and `QNTOPTIONS` (pack sizes, comma separated). Every sync already keeps the whole entry in `supplier_services.raw`, so
nothing new is stored. `supplierQuantityRule(raw)` (`domain/supplier-quantity.ts`) reads them and always returns a rule that the
catalog accepts (`quantityRuleProblems`): unreadable values fall back to one per order, repeats are dropped, at most the 50 smallest
packs are kept and a largest above 100000 is capped, so our rule is always a subset of the supplier's. The import copies it **only
when it creates a service** (`ImportedServiceInput.quantity`; the audit row `imported services from` gains `createdWithQuantity`).
A later import, a price sync or a change of the supplier's rule never writes a service's quantities, so staff edits win. The import
preview sends, per item, `minQty`, `maxQty`, `qtyOptions` (the supplier's rule; for a `new` item what the service will get) and
`quantityDiffers` (a live linked service whose own three values differ; `false` for `new` and for an archived link). The REST driver
has no service list, so there is nothing to copy. An order's quantity is still sent to the supplier as `QNT`; a rule staff set wider
than the supplier's is not refused here: the supplier refuses the order and the rejection path refunds it.

## The supplier's main box (feature 33, decision 042)

The classic service list describes the main box of an IMEI service as `CUSTOM: { allow, customname, customlen, maxlength, regex, ... }`:
with `allow` on, the buyer types what `customname` says (an ECID, a serial number) instead of an IMEI, and the value travels as the `IMEI`
parameter; `Requires.Custom` lists the other fields. Our `imei` type keeps its meaning (a real 15-digit IMEI with a Luhn digit).

- `supplierMainInput(raw)` (`domain/supplier-main-input.ts`) reads the box from `supplier_services.raw`: `null` unless `CUSTOM` is an
  object, `allow` is `"1"`, `1` or `true`, and `customname` has text that does not only say IMEI (`imei`, `imeino`, `imeinumber` after
  dropping all but letters and digits). Else the label (spaces collapsed, 120 characters), `maxLength` (`maxlength` 1-500, else `null`),
  `minLength` (`customlen` 1 to the maximum, else 1). The supplier's own `regex` is never used: it is untrusted text that may be written
  for another engine (PHP's `\A`, `[[:alnum:]]`) and match nothing, or backtrack without end on every order check; staff can type a
  pattern on the field later. `isalpha`, `bulk` and `custominfo` are not used either.
- `importShape(row)` (`domain/import-plan.ts`) is what a supplier service becomes: an `imei` one with a main box is a `server` service whose
  first field is the box (`mainInputField`: required text, supplier key `IMEI`, the key in lower snake case and unique, the regex
  `^.{min,max}$` from the lengths when the supplier gives a maximum, else none), followed by the `Requires.Custom` fields; anything else is `importableType` and
  `importedFields` as before. The import, the preview (its `type` tag says `SERVER` then) and the quick add read the type from it.
- One rule says which field is the supplier's main box (`src/common/dhru/main-input-key.ts`): its supplier name resolves as the link's
  `field_map[key]`, else the field's `supplier_key`, else its `key` (`resolvedSupplierKey`), and the box is the one that resolves to
  `IMEI` in any case (`isMainInputKey`). The dispatch sends that value as the `IMEI` parameter when the order has no IMEI of its own
  (the first such field by the service's field order wins), never inside `CUSTOMFIELD`; `orders.imei` already holds it (the first
  required field). **This also changes existing services:** a `server` service with a field whose supplier key (or key, or link map
  value) is `IMEI` is sent that value as the `IMEI` parameter from now on, no longer inside `CUSTOMFIELD`.
- A shop checkout opened while a service took an IMEI and paid after an adoption keeps the buyer's value: the store placement puts it
  under the main box field (`carriedImeiInputs`, orders module) when that field has no value of its own.
- **Adoption on sync.** In the sync's transaction, after the services are stored: every live `imei` service whose only active link (in
  all; inactive links do not count) points at a service of this supplier with a main box is adopted, by service id, unless a field
  (by supplier key, or key when that is empty) or that link's `field_map` already names `IMEI` (the same rule, `adoptable`). The
  candidates are locked in id order (some may already be locked by the effective cost recompute, in no fixed order) and read again. The catalog's `ServiceImporter.adoptMainInput` makes it a `server` service in the
  `server` category of the same name (an existing one is reused as it is, with its own switch and groups; only a category created for
  the move copies the old one's switch and groups) and puts the box first; price,
  cost, status, quantities, SLA, links and listing stay. Each adoption writes the search index's `catalog.services_changed` event and
  one audit row (`adopted the supplier's input`, entity `service`, the system as the actor, `before { type, categoryId }`, `after
  { type, categoryId, field { key, label, supplierKey } }`); the catalog price version moves after the commit.
- **Required fields (feature 33, second review round).** A Dhru Fusion site describes a `Requires.Custom` field as `{ type, fieldname,
  fieldtype, description, fieldoptions, required, regexpr, adminonly }` and writes a set flag as `"on"` (an unset one as `""`).
  `isSupplierFlagOn` (`domain/import-plan.ts`) reads a flag: `true`, `1`, or text that is `on`, `1`, `yes`, `true`, `required` or `y`
  (trimmed, any case). `importedFields` makes such a field required, reads `fieldtype` `radio` as a `select` (like `dropdown`, options
  from `fieldoptions`) and leaves out a field marked `adminonly` (the supplier's own staff fill it). `regexpr` is never used (decision
  042: untrusted).
- **Repair on sync.** In the same step and under the same guards as the adoption (live; the only active link in all points at this
  supplier; any type), `fieldsToRequire` lists the service's optional fields whose supplier name (`resolvedSupplierKey`: the link's
  `field_map`, else the supplier key, else the key) is the `fieldname` of a field the supplier requires (exactly, then without case
  and spaces) and not `adminonly`; the catalog's `ServiceImporter.requireFields` sets only their `required` (label, type, options,
  pattern, sort and key stay), like a staff save of the fields (nothing for the shop or the search index, no price version). One audit
  row per changed service (`made the supplier's required fields required`, entity `service`, the system, `before { optionalFields }`,
  `after { requiredFields }`). A service adopted in the same sync has its other fields checked after the adoption. **A field is never
  made optional by the sync**: staff who make such a field optional again will see the next sync make it required again, because the
  supplier refuses the order without it.
- `SyncResult.adopted` (and the `synced services from` row) counts the services the sync brought in line with what their supplier asks
  for, each once: the main box adopted, required fields raised, or both. A second sync changes nothing.

## Quick add (feature 26, B214)

Staff add a supplier's services to the catalog by whole group, or all of them, without ticking rows in the import picker. Three routes
beyond the map (`scripts/map-additions/26.mjs`): `GET .../service-groups` (one row per group, a group is the pair `(type, remoteGroup)`
as `supplier_services` stores it; every service is counted once as `imported`, `unavailable`, `unsupported` or `addable`, in that
order; the supplier's newest run rides along as `latestRun`), `POST .../quick-add` (`202`, body = a scope, never ids) and
`GET .../quick-add/:runId` (the console polls it). The picker's `POST .../import` and `.../import/preview` are unchanged.

- **What it takes.** The candidates of the scope: not imported (no link row, an archived service counts as imported), available and
  of an importable type (imei, server, remote, file; `lower(btrim(type))`). Everything else is counted and left out, never refused.
  It only creates: the category by type and group (`Imported` for an empty group), the code `IMP-<id>`, the suggested price, the
  fields and the supplier's quantity rule, exactly as the import does (`application/imported-service.ts` is shared by both). A
  service already in the console is never touched. The services start `active`, or `disabled` when the request says so.
- **The start** (`QuickAddService.start`, one transaction): the supplier row is locked first (as the import and the sync); a
  `disabled` supplier is `409 SUPPLIER_DISABLED` (a paused one is accepted); a live run (`queued` or `running`) that is not stalled is
  `409 JOB_ALREADY_RUNNING`, a stalled one is closed first; no candidate is `422` on `scope` with code `nothing_to_add` and no run;
  else it inserts the `supplier_import_runs` row, the outbox event and the audit row `started quick add from`. Because the start is
  one transaction, a `422` also rolls back the close of a stalled run: that row stays `running` (every read shows it `failed`) until
  a start that has candidates closes it. The partial unique
  index `supplier_import_runs_active_uq` keeps one live run per supplier in the database.
- **The run** (`QuickAddRunner.run`, the worker): claims the run (`queued` to `running`, so a second delivery does nothing), builds
  the list of candidate ids, then adds them in chunks of 100, each chunk in one transaction that locks the supplier row, re-reads
  the links and the rows, creates what is still a candidate, recomputes the effective cost, and advances the run with a guarded
  update (a run closed by a newer start makes the chunk roll back and the runner stop). A chunk that throws is retried item by item;
  an item that throws again is counted `failed` (the first 20 are listed with a reason: the constraint name, never SQL) and 20 failed
  items end the run `failed`. The close writes the audit row `quick added services from` (actor `system`, with the counts).
- **Stalled runs.** Every chunk moves `heartbeat_at`. A live run without a heartbeat for five minutes reads as `failed` (reading
  never writes); the next start closes it. Nothing is retried automatically (`imports`: 1 attempt, no stalled re-run); pressing
  Quick add again with the same scope continues with what is left.
- **Files.** `domain/quick-add.ts` (constants and pure rules, with a spec), `infra/quick-add.repository.ts`,
  `application/quick-add.service.ts`, `application/quick-add-runner.ts`, `application/quick-add-outbox.ts`,
  `jobs/quick-add.processor.ts`, `contracts/quick-add.contracts.ts`, `controllers/quick-add.controller.ts`. `GET .../services` gained
  the filters `remoteGroup`, `type` (exact text) and `isAvailable` (B215).

### Quick add also publishes (feature 31, decision 040, plan 31 sections 4.3, 5.5 and 6.3)

- **The body** takes `publish?: { listed: boolean }`. The run stores `publish_mode` (`none`, `listed`, `unlisted`) and every run view
  carries it as `publish` (also inside `service-groups.latestRun`). A staff member without `storefront:publish` gets `403 FORBIDDEN`
  naming it (the controller checks with `grants`; the route's own permission stays `catalog:create`). `422` on `publish`: code
  `needs_active` when `serviceStatus` is `disabled` ("Services added switched off cannot go on the shop."), code `no_rule` when no retail
  price rule is active ("Set a retail pricing rule first."). Both are decided before the first write.
- **What a run made.** `createImportedService` passes the run's id to `insertFirstLink`, which writes `service_supplier_links.import_run_id`:
  the exact record of what the run created (the storefront's scope `quickAddRun` reads it through the catalog). `replaceChain` keeps the
  `import_run_id` of a link that stays, or saving a chain would drop the service from its run.
- **The hand-over.** A run that asked to publish and has `created_count > 0` writes `supplier.quick_add_done` (ids and `listed` only) in the
  transaction that closes it: the runner's `close` (succeeded or failed) and the start that closes a stalled run. The storefront's
  `publish_from_quick_add` job makes the one automatic publish run of it and prepares it; the suppliers module never imports the storefront.
  A run that created nothing, or did not ask, writes no event.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `catalog-1`, `catalog-2`, `catalog-9`: the effective cost, and the suggested price of an import
- `orders-suppliers-3` · GET /admin/supplier-api-logs, GET /admin/supplier-api-logs/:id
- `orders-suppliers-4` · GET /admin/suppliers, GET /admin/suppliers/:id
- `orders-suppliers-5` · GET /admin/suppliers, GET /admin/suppliers/:id
- `orders-suppliers-6` · POST /admin/suppliers/:id/sync
- `orders-suppliers-7` · GET /admin/suppliers
- `orders-suppliers-8` · DELETE /admin/suppliers/:id
- `orders-suppliers-9` · POST /admin/suppliers
- `orders-suppliers-10` · POST /admin/suppliers/:id/import
- `orders-suppliers-11`, `-12`, `-17`, `-19` · the order moves (dispatch, fetch, change-supplier)
- `orders-suppliers-13` · GET /admin/suppliers/:id
- `orders-suppliers-15`: the event types written by the supplier flows (`dispatch`, `ack`, `review`, `retry`, `fetch`, `supplier_changed`)
- `orders-suppliers-16` · GET /admin/suppliers, GET /admin/suppliers/:id
- `orders-suppliers-20` · GET /admin/suppliers
- `health-commissions-8`: the call outcome and `prices_synced_at`
