# Suppliers module (`suppliers`)

Map domain C. The suppliers we buy from (the orders it moves belong to an account of either door, decision 064; the supplier flows never read the buyer's rank): supplier accounts, their service catalogs, the links from our services to supplier services, the Dhru supplier client, the dispatch, poll and sync jobs, and the log of every supplier call.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 023 outbound HTTP, 026 Dhru compatibility, 042 real Dhru Fusion suppliers (feature 33), 020 queues and outbox, 019 credential encryption, 021 rate limiting, 025 order state machine, 031 clock, 051 supplier keys, answers and field patterns, 065 one Name per field and the main input flag. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 6, suppliers; quick add added by feature 26): the 13 routes of this module plus the three order routes that move an order to a supplier (`dispatch`, `fetch`, `change-supplier`, owned by the orders map but built here, because they read the supplier tables; they move the order through the orders module's `OrderSupplierMoves`), the Dhru supplier client behind a driver interface, the dispatch, poll and sync jobs, the demo seed and the scenarios `success`, `reject` and `timeout`. Not here: the supplier report (11), the system health supplier view (9, it reuses `supplierHealth`), Dhru for merchants (7a), the outgoing order events (7b). `GET /admin/reports/suppliers` is stage 11.

Structure: `contracts/` (zod contracts: the routes, and the four supplier calls), `controllers/` (thin), `application/` (use cases and the supplier client), `domain/` (pure rules, unit tested), `infra/` (Drizzle queries), `jobs/` (worker processors and schedules), `db/schema.ts`.
Three Nest modules: `SuppliersAdminModule` (routes and use cases, needs the database; listed in `NEEDS_DATABASE_AND_CACHE` of `test/support/app.ts`), `SupplierEngineModule` (client, sync, dispatch, poll, the quick add runner and its outbox, and `DispatchRequests` and `DispatchSweep` of decision 044: no routes, loaded by both processes) and `SupplierJobsModule` (processors and schedules, the sweep's processor and schedule included, worker only).

## The supplier client (decision 026)

`SupplierClient` is the only place that calls suppliers. It decrypts the key for one call (AES-GCM with a key id, AAD `suppliers.api_key_enc`; the hint is a masked form of the key, `••••` and, for a key of 16 or more characters, its last 2 characters (`apiKeyHintOf`, decision 051), written with the ciphertext and never decrypted on read; a saved key is bound to where it is sent: a change of `baseUrl` to another origin, of `username` or of `driver` needs `apiKey` in the same request, or it is `422` on `apiKey`, while a new path on the same origin, a rename or a limit change does not), picks the driver (`dhru`; `rest` answers "REST suppliers are not supported yet" until a REST supplier exists) and calls through `OutboundHttp` (SSRF guard, required timeout `suppliers.timeout_ms`, no redirects). The Dhru request is a form post to `<baseUrl>/api/index.php` with `username`, `apiaccesskey`, `action`, `requestformat=JSON` and `parameters` in the form the supplier's row says (`suppliers.param_format`, decision 042): `dhru_xml` (the default of every Dhru supplier) is the classic XML string `<PARAMETERS><ID>..</ID><IMEI>..</IMEI><QNT>..</QNT></PARAMETERS>` that a Dhru Fusion site reads (`dhruParametersXml`: upper-case keys, `&`, `<`, `>` escaped, characters XML forbids removed), `json` is base64 of a JSON object (the standards v6.1 form of decision 026). `CUSTOMFIELD` is base64 of a JSON object in both. No route sets the form yet. Actions: `accountinfo`, `imeiservicelist`, `placeimeiorder`, `getimeiorder`. Production needs `https`; the setting `suppliers.allowPlainHttp` (editable in the settings screen) is the admin-visible opt-out. Tests provide `SUPPLIER_TARGET_POLICY` to reach a local fake supplier.

Every call returns a record that the caller writes to `supplier_api_logs` (the readable, redacted `request` names the `format` its parameters were sent in): `http_status` (0 without an HTTP answer), `duration_ms` (the time waited), `error` (`''` when fine) and the `outcome` `ok | error | timeout` (`timeout` = no HTTP answer in time; `error` = anything else: network error, HTTP >= 400, unusable body, a Dhru ERROR even on HTTP 200). Credentials and IMEIs are masked in the stored bodies (`redactBody`; a device number keeps its last four characters, counted as whole characters so a character outside the basic plane is never cut in half, decision 051); a service list keeps only its counts (`services` and `skipped`). `SupplierThrottle` applies `max_concurrency` (a semaphore) and `rate_limit_per_min` (the `supplier` limiter).

### Supplier answers (decision 051)

Everything a supplier says is untrusted text and is cleaned and bounded where the driver reads it, so no sink (call log, order events, results, mails) has to remember to do it:

- **Size.** The driver reads at most `SUPPLIER_ANSWER_LIMITS`: 256 KiB for `accountinfo`, `placeimeiorder` and `getimeiorder`, 16 MiB for `imeiservicelist`. A larger answer is an unusable answer (failure kind `invalid`, outcome `error`, status 0, "The supplier's answer is larger than 256 KiB; it was not read.").
- **Cleaning** (`domain/supplier-text.ts`, `cleanSupplierJson`). Every string of the parsed answer, keys included, loses U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+007F-U+009F and lone surrogates and is cut to 20,000 characters; values nested deeper than 32 levels become `null`; a key `__proto__` is dropped. Format characters such as right-to-left marks stay (supplier text in Arabic is data, decision 039).
- **Field bounds** (`supplierLine`, `supplierBlock`): an error message 500 characters, the order result (`CODE`, line breaks kept) 20,000, a reference or service id 200; names, groups, types, times and account details 300. A cut never splits a surrogate pair.
- **Amounts** (`domain/amount-text.ts`). A JSON number is read exactly and text with an exponent is not an amount. A price is used from 0 to 1,000,000,000; a balance from -1,000,000,000 to 1,000,000,000. A service whose price is unreadable or out of range is left out of the list and counted (`ServiceListReading.skipped`), so the sync marks the stored service unavailable; a balance out of range makes `AccountInfo.credit` `null`: the sync goes on and keeps the stored balance, the balance check stores nothing and the connection test answers `ok: false`. One warning line per sync names the counts.
- **The call log never stops the order path.** Dispatch, poll, the sync's two calls and the balance check write the log with `writeCallLogSafely`: the record, else a minimal row (action, status, time, outcome, no bodies, a fixed error text), else one error line with the SQLSTATE alone (the dispatch also hands the error of a record not stored in full to the error reporter, as before). The connection test keeps `writeCallLog` inside its transaction.

## Dispatch, poll and sync

See `docs/queues.md` (`supplier-dispatch`, `supplier-poll`, `supplier-sync`). In short: the dispatch job claims the order with a guarded update before the call and never sends twice; the claim moves it to the dispatch state `dispatching` with `sent_at` (decision 044), so the actions that would change it wait for the answer (`409 ALREADY_SENT`), and the answer applies only to its own claim; a REFERENCEID gives `sent`, a refusal, a timeout or no eligible link gives `needs_attention` with the reason and the hold kept (an order of a service delivered from code stock with no usable supplier reads "No codes in stock and no supplier: deliver it by hand.", `noLinkReason`, decision 069); nothing is re-sent automatically. An acceptance that arrives after the order moved on is recorded in its own transaction (the reference where the order has none, a `review` line, a waiting order moved to `needs_attention`, an error log line and an error report); so is one whose own answer could not be recorded (the order keeps its claim and the original error fails the job), and a call log row that cannot be written is logged and reported without stopping the answer (`writeCallLogSafely`, decision 051). Limits that cannot be read (`SupplierThrottle.admit` answers `unavailable`) count as a busy supplier: the queue retries and the last attempt stops the order in `needs_attention`. The `dispatch_sweep` (maintenance queue, every minute, `DispatchSweep`) moves an order `dispatching` for longer than its supplier's timeout plus 2 minutes to `needs_attention`, and asks again, through the outbox, for a `pending` order whose dispatch request was lost (`DispatchRequests` tells whether a request is still live; at most 3 times, never after 24 hours; an order that never had a request is left alone). One order that cannot be moved does not stop the others: the sweep moves the rest, then throws one error with the counts, so the run is recorded as failed. Choosing another supplier with `change-supplier` always forgets the old reference, and a poll or fetch answer applies only while the order still names the supplier and reference it was asked about. The automatic dispatch never fails over to a link that costs more than the price charged (user rule 9, B117 (6)); a staff `dispatch` or `change-supplier` may (the `supplier_changed` event records `costAbovePrice`). The poll tick (every minute) finds the sent orders that are due and queues a `poll` job each; STATUS 4 completes the order, STATUS 3 rejects it. `price_sync` (every 15 minutes) and `balance_check` (every 30 minutes) go through every supplier that is not disabled; staff's `POST /admin/suppliers/:id/sync` runs the same sync in the worker and waits for its counts (`504 SUPPLIER_TIMEOUT` after `timeout_ms + 5 s`).

Money: a supplier's result settles the order through `OrderTransitions`: the hold becomes revenue and, because the order has `supplier_id` and `supplier_ref`, the cost (`credit x credit_rate`, refreshed on the order when the supplier is chosen) is booked from the prepaid balance at the supplier (B17); a rejection releases the hold with no cost.

Cost basis (user rule 9): no route sets `credit_rate` (it stays 1), so a supplier is kept in the base currency: `POST` and `PATCH /admin/suppliers` refuse another `currency` (`422` on `currency`, `unsupported`), and a sync whose `accountinfo` reports another currency than the supplier's own saves nothing (`SUPPLIER_UNAVAILABLE`; a supplier that reports none syncs). The effective cost of a service (the catalog's `recomputeEffectiveCost`) follows the first link an order can use (switched on, supplier `active`, service still listed), so the sync recomputes every linked service and a change of a supplier's `status` recomputes the services linked to it and moves the catalog price version.

## Lost Quick add jobs (decision 055)

`QuickAddReconcilePass` (kind `quick_add_runs`, in `SupplierJobsModule`) is the Quick add's pass of the platform's `lost_work_reconcile`:
a run `queued` whose newest `supplier.quick_add` request has had no live job for 10 minutes gets the event again
(`QuickAddOutbox.requested` with `reconcile: true`), under the run's lock while it is still `queued`, at most three times. Then nothing is
written: the run reads as stalled and staff start it again (the start closes the old run, so its late job claims nothing). The hand-over
to the bulk publish (`supplier.quick_add_done`) is not asked for again: the Quick add progress offers to prepare the preview by hand.

## Public API (`index.ts`)

Exports the modules (`SuppliersModule`, `SuppliersAdminModule`, `SupplierEngineModule`, `SupplierJobsModule`), the health rules (`supplierHealth`, `healthFromCalls`, `toPageHealth`, `runwayDays`, `isLowBalance`: the system health view of feature 9 reuses them), the link rules (`pickLink`, `linkUnitCost`), the four supplier call contracts (`SUPPLIER_CALLS`), the key hint (`apiKeyHintOf`, `KEY_HINT_MASK`), `SupplierDirectory` (supplier names for other modules), `SupplierReader`, `SupplierDispatch` (and `ANSWER_NOT_RECORDED_REASON`), `DispatchRequests`, `DispatchSweep` (with `DispatchSweepProcessor`, `DISPATCH_SWEEP_JOB`, the sweep's rule constants and `lostRequestAction`, and the result and plan types), `SupplierPoll`, `SupplierSync`, `QuickAddRunner` (feature 26), the vocabularies and row types, and the test policy token. Other modules import only `src/modules/suppliers/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 5 tables (`scripts/module-map.mjs`; `supplier_import_runs` is an `additionalTables` entry, feature 26); other modules call its public services. Schema: `db/schema.ts`. Deviations: the orders module names `supplier_api_logs` in one SQL text (`order-supplier.repository.ts`, the poll candidates) and reads `suppliers` for names; the money module reads `suppliers` for ledger owner names; `foreign-reads.repository.ts` here reads `services`, `service_fields` and `service_categories` (the catalog exports no service or category reader; the category staff pick for an import: decision 063) and `service_checks` is read with a plain select (health exports no reader yet). Writes to the catalog go through the catalog's `ServiceImporter` and `recomputeEffectiveCost`.

| Table | What it holds |
|---|---|
| `suppliers` | Supplier connections and your balance with each one. |
| `supplier_services` | A copy of a supplier's services after a sync. |
| `service_supplier_links` | Links your service to a supplier service, in priority order. `import_run_id` (feature 31) names the quick add run that created the service. |
| `supplier_api_logs` | A log of every request sent to a supplier. |
| `supplier_import_runs` | The record of one quick add (feature 26): scope, counts, progress and heartbeat; one live run per supplier. `publish_mode` (feature 31) says whether it also puts what it creates on the shop. |

## Routes

20 routes are built (the 13 below, the three quick add routes of feature 26, the read of a service's supplier chain of feature 46 and the three order routes). Source: `docs/slices/suppliers.json` (generated from the map; `bun run routes:build`). Contracts are under `contracts/`.

### Admin console

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/suppliers` | staff-permission · `suppliers:read` | Suppliers with health, order counts, runway and balance verdict. | 6 |
| `GET /admin/suppliers/:id` | staff-permission · `suppliers:read` | One supplier with its 24-hour history and linked services. | 6 |
| `POST /admin/suppliers` | staff-permission · `suppliers:create` | Add a supplier (the key is encrypted, the hint stored). | 6 |
| `PATCH /admin/suppliers/:id` | staff-permission · `suppliers:update` | Change a supplier, switch it active, paused or disabled; moving it to another origin, username or driver needs its key again (decision 051). | 6 |
| `DELETE /admin/suppliers/:id` | staff-permission · `suppliers:delete` | Delete a supplier nothing refers to (`409 SUPPLIER_IN_USE`). | 6 |
| `POST /admin/suppliers/:id/test` | staff-permission · `suppliers:update` | Test the connection through `accountinfo`. | 6 |
| `POST /admin/suppliers/:id/sync` | staff-permission · `suppliers:update` | Sync services and balance now (through the worker). | 6 |
| `GET /admin/suppliers/:id/services` | staff-permission · `suppliers:read` | The supplier's services after syncing; filters `imported`, `remoteGroup`, `type`, `isAvailable` (the last three: feature 26, B215). | 6 |
| `POST /admin/suppliers/:id/import/preview` | staff-permission · `catalog:create` | Preview the import: new, matching and changed services with the suggested price. With `status` or `categoryId` (decision 063) every item also says the `status` and `category` a new service would get. | 6 |
| `POST /admin/suppliers/:id/import` | staff-permission · `catalog:create` | Import the selected items as services, fields and links; `createdServiceIds` names the services the call created, in creation order, `[]` when it created none; it is always sent (decision 060). Optional `status` (`active` or `disabled`) and `categoryId` (a category of the type of every new service, else `422` on `categoryId` naming the supplier services that do not fit) say what the new services become (decision 063). | 6 |
| `GET /admin/suppliers/:id/service-groups` | staff-permission · `suppliers:read` | The supplier's service groups with counts, and its latest quick add (beyond the map, B214). | 26 |
| `POST /admin/suppliers/:id/quick-add` | staff-permission · `catalog:create` | Quick add: add the supplier's services by group, or all of them, in the background (`202`; beyond the map, B214). | 26 |
| `GET /admin/suppliers/:id/quick-add/:runId` | staff-permission · `suppliers:read` | The state and progress of a quick add (beyond the map, B214). | 26 |
| `GET /admin/services/:id/supplier-links` | staff-permission · `catalog:read` | The supplier chain of one service in priority order, switched-off links too; `[]` without a link (beyond the map, decision 060, `scripts/map-additions/46.mjs`). | 46 |
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
| `SUPPLIER accountinfo` | Our balance at the supplier (test, sync, balance check). | no `AccoutInfo` (or `AccountInfo`) block with a readable `credit`; an answer over 256 KiB (a balance out of range is read but not saved) |
| `SUPPLIER imeiservicelist` | The supplier's services and their cost, for the sync. | an answer over 16 MiB (a list that cannot be read is empty; a service with a price out of range is left out and counted) |
| `SUPPLIER placeimeiorder+placeimeiorderbulk` | Send the order and store `supplier_ref` (the dispatch job). The bulk variant is described but never sent: one order is one job. | no `REFERENCEID`; an answer over 256 KiB |
| `SUPPLIER getimeiorder+getimeiorderbulk` | Poll the status and the result (the poll job, `fetch`). `STATUS` 4 completed, 3 rejected, 0 and 1 (and 2) running. The bulk variant is described but never sent: one poll job asks about one order. | no known `STATUS`; an answer over 256 KiB |

## Scenarios

Walked end to end by `test/e2e/{success,reject,timeout}.e2e.test.ts` against a fake Dhru supplier served in the test (`test/support/suppliers.ts`); 7a adds the merchant's Dhru steps to the same files. Other scenarios touching this module: `b2c-paid`, `b2c-ticket`, `system-alert` (later features).

## Permissions

Staff permissions the routes need: `suppliers:read`, `suppliers:create`, `suppliers:update`, `suppliers:delete`, `catalog:read` (the chain of one service), `catalog:create`, `catalog:update`, `orders:update`, and `reports:read` for the report of stage 11. They come from the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced: `supplier.quick_add` (queue `imports`, job `supplier_quick_add`, payload `{ runId, supplierId }`, aggregate `supplier_import_runs`; `QuickAddOutbox`, written by `POST /admin/suppliers/:id/quick-add`) and `supplier.quick_add_done` (feature 31: payload `{ runId, supplierId, requestedBy, listed }`, aggregate `supplier_import_runs`; written by the transaction that closes a run that asked to publish and created services; its route and job `publish_from_quick_add` belong to the storefront). Consumed: `order.dispatch_requested` (queue `supplier-dispatch`, payload `{ orderId }`, written by the orders module) and `supplier.quick_add` (queue `imports`, `QuickAddProcessor` in the worker). Audit phrases written (the console prints `<actor> <action> <entityLabel>`): `added supplier`, `edited supplier`, `paused supplier`, `resumed supplier`, `disabled supplier`, `enabled supplier`, `deleted supplier`, `tested connection to`, `synced services from`, `imported services from`, `started quick add from` (the staff member, when the run is queued), `quick added services from` (the system, when the run ends), `changed supplier links of` (entity `service`), `adopted the supplier's input` and `made the supplier's required fields required` (entity `service`, the system, by the sync: feature 33), and on orders `dispatched order`, `changed supplier of`, `fetched supplier result of`.

## Jobs and schedules

| Queue | Job | Schedule | Notes |
|---|---|---|---|
| `supplier-dispatch` | the outbox event `order.dispatch_requested` | event-driven | `SupplierDispatchProcessor` |
| `supplier-poll` | `supplier_poll_tick`, `poll` | tick every minute (`supplier-poll-tick`) | `SupplierPollProcessor` |
| `supplier-sync` | `supplier_sync`, `price_sync`, `balance_check` | every 15 and every 30 minutes (`supplier-price-sync`, `supplier-balance-check`) | `SupplierSyncProcessor`, scheduled runs in `job_runs` |
| `imports` | `supplier_quick_add` (outbox event `supplier.quick_add`) | event-driven | `QuickAddProcessor` calls `QuickAddRunner.run`; recorded in `supplier_import_runs`, not in `job_runs` |
| `maintenance` | `supplier_log_retention` | daily 04:50 UTC (`supplier-log-retention`) | `SupplierLogRetentionProcessor` calls `SupplierLogRetention.run` (decision 053): the call log (`supplier_api_logs`) is kept 90 days; batches of 1000 by id, at most 100 batches a run; recorded in `job_runs` with `processed` and `result.deleted`. The poll reads only the newest `getimeiorder` log of each open order (minutes old), so no live read depends on an old row |

Idempotency keys, retry policies and the claim rule: `docs/queues.md`. Settings read: `catalog.importDefaultSlaMinutes` (default 1440), `orders.poll_slow_after_hours` (default 24), `suppliers.allowPlainHttp` (default off), all editable through `PATCH /admin/settings`; `suppliers.allowPlainHttp` is changed by an Owner only (decision 051).

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
  first field is the box (`mainInputField`: required text with `isMainInput` set, its Name the box's own name from the supplier, the key in
  lower snake case and unique, the regex `^.{min,max}$` from the lengths when the supplier gives a maximum, else none), followed by the
  `Requires.Custom` fields; anything else is `importableType` and `importedFields`. The import, the preview (its `type` tag says `SERVER`
  then) and the quick add read the type from it.
- **Names (decision 065).** A field has one Name (`service_fields.supplier_key`, never empty, unique in its service ignoring letter case)
  and a hidden key. `importedFields` writes the Name as the supplier spells it, the key made from it (`fieldKeyBase`, `_2`, `_3` on a
  clash), the label from the supplier's description (else the Name) and `isMainInput` false; `importShape` flags the box, or, on a service
  that stays `imei`, the first field named IMEI in any letter case (`imeiNamedFieldIndex`), so no form draws a second IMEI box. Two supplier names that differ only in
  letter case cannot both be a Name: the later one gets ` 2` (`Name 2`, `Name 3`, ...; `freeFieldName`). The box's Name is never sent, so
  on a clash with another field the box takes the number and the supplier's field keeps its name.
- The supplier's main box is the field flagged `isMainInput` (decision 065; at most one per service). The dispatch sends its value as the
  `IMEI` parameter when the order has no IMEI of its own, never inside `CUSTOMFIELD`; `orders.imei` already holds it (`mainInputOf` takes
  the flagged field first). Every other value travels in `CUSTOMFIELD` under `supplierFieldName` (`src/common/dhru/main-input-key.ts`): the link's
  `field_map[key]` when it has text, else the field's Name; a stored key that no field has any more keeps its own key as the name. A
  field that its supplier itself names `IMEI` but is not flagged is an ordinary field and travels in `CUSTOMFIELD`.
- A shop checkout opened while a service took an IMEI and paid after an adoption keeps the buyer's value: the store placement puts it
  under the main box field (`carriedImeiInputs`, orders module) when that field has no value of its own.
- **Adoption on sync.** In the sync's transaction, after the services are stored: every live `imei` service whose only active link (in
  all; inactive links do not count) points at a service of this supplier with a main box is adopted, by service id, unless a field is
  already the main input (`isMainInput`; `adoptable`). `adoptMainInput` also leaves a service alone when its key or its Name (ignoring
  letter case) is taken, so the unique indexes are never hit. The
  candidates are locked in id order (the effective cost recompute already locked every linked service in id order, decision 069) and read again. The catalog's `ServiceImporter.adoptMainInput` makes it a `server` service in the
  `server` category of the same name (an existing one is reused as it is, with its own switch and groups; only a category created for
  the move copies the old one's switch and groups) and puts the box first; price,
  cost, status, quantities, SLA, links and listing stay. Each adoption writes the search index's `catalog.services_changed` event and
  one audit row (`adopted the supplier's input`, entity `service`, the system as the actor, `before { type, categoryId }`, `after
  { type, categoryId, field { key, name, label } }`); the catalog price version moves after the commit.
- **Required fields (feature 33, second review round).** A Dhru Fusion site describes a `Requires.Custom` field as `{ type, fieldname,
  fieldtype, description, fieldoptions, required, regexpr, adminonly }` and writes a set flag as `"on"` (an unset one as `""`).
  `isSupplierFlagOn` (`domain/import-plan.ts`) reads a flag: `true`, `1`, or text that is `on`, `1`, `yes`, `true`, `required` or `y`
  (trimmed, any case). `importedFields` makes such a field required, reads `fieldtype` `radio` as a `select` (like `dropdown`, options
  from `fieldoptions`) and leaves out a field marked `adminonly` (the supplier's own staff fill it). `regexpr` is never used (decision
  042: untrusted).
- **Repair on sync.** In the same step and under the same guards as the adoption (live; the only active link in all points at this
  supplier; any type), `fieldsToRequire` lists the service's optional fields (never the main-input field) whose supplier name
  (`supplierFieldName`: the link's `field_map`, else the Name) is the `fieldname` of a field the supplier requires (exactly, then without
  case and spaces) and not `adminonly`; the catalog's `ServiceImporter.requireFields` sets only their `required` (label, type, options,
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
`GET .../quick-add/:runId` (the console polls it). The picker's `POST .../import` and `.../import/preview` take two optional keys of their own
(decision 063, below); the quick add has only its `serviceStatus`.

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

## Import options: the state and the category of the new services (decision 063, B242)

`POST /admin/suppliers/:id/import` and its preview take two optional keys. Without them the routes answer and write exactly what they did
before (the preview items carry no new field, the audit row has no new key).

- **`status`** (`active` by default, or `disabled`). It is handed to `ServiceImporter.create`, which inserts the service in that state: a
  service created `disabled` is never orderable, not even between two statements (the whole import is one transaction). Quick add already
  had `serviceStatus`; both go through `createImportedService`. An updated or unchanged item is never touched by it.
- **`categoryId`**. Every service the call creates goes into that category instead of the one named after the supplier's group. A category
  holds one service type (`service_categories.type`, the composite key of `services`), so the type each new service becomes
  (`importShape`: an IMEI service whose main box is not an IMEI is a `server` service, decision 042) must be the category's; else `422` on
  `categoryId`, code `kind_mismatch`, whose message names the supplier services that do not fit (ten at most, then a count) and nothing is
  imported. An unknown id is `422` on `categoryId`, code `unknown`. Items the call will not create (matching, changed, archived link) are
  not checked. The category is read under a share lock (`findCategoryChoice`), so a rename or a type change waits for the import.
  *How the importer is told:* the catalog's importer finds a category by the supplier's group text first, by (type, name) ignoring case, and
  `service_categories_name_uq` makes that pair unique, so `createImportedService` gives the picked category's name as the group text
  (`categoryName`) and the importer finds exactly it and makes none. One read after the loop proves every created service has the category
  (`categoryIdsOfServices`); a mismatch would roll the transaction back. The audit row `imported services from` gains `serviceStatus` and
  `categoryId`/`categoryName` when the request carried them.
- **The preview** (the same keys): each item also says `status` (what a `new` item would be created as) and `category` (`{ id, name }`,
  named exactly): the picked one, else what the catalog's `ServiceImporter.categoriesForGroups` answers, the category the import finds for
  the supplier's group by the same lookups as its `create` (the group text, then its cleaned name, by type and name ignoring case), else the
  cleaned name the import makes a category under, with `id` `null`. Both are `null` for an item the import would not create. The same
  `422`s as the import.
- **Not done here:** the quick add takes no category (a group is its own unit there), and nothing is published: the console reads
  `createdServiceIds` for that (decision 060).

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
