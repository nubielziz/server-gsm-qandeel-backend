# Suppliers module (`suppliers`)

Map domain C. The suppliers we buy from: supplier accounts, their service catalogs, the links from our services to supplier services, the Dhru supplier client, the dispatch, poll and sync jobs, and the log of every supplier call.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 023 outbound HTTP, 026 Dhru compatibility, 020 queues and outbox, 019 credential encryption, 021 rate limiting, 025 order state machine, 031 clock. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 6, suppliers): the 13 routes of this module plus the three order routes that move an order to a supplier (`dispatch`, `fetch`, `change-supplier`, owned by the orders map but built here, because they read the supplier tables; they move the order through the orders module's `OrderSupplierMoves`), the Dhru supplier client behind a driver interface, the dispatch, poll and sync jobs, the demo seed and the scenarios `success`, `reject` and `timeout`. Not here: the supplier report (11), the system health supplier view (9, it reuses `supplierHealth`), Dhru and REST v1 for merchants (7a), the outgoing order events (7b). `GET /admin/reports/suppliers` is stage 11.

Structure: `contracts/` (zod contracts: the routes, and the four supplier calls), `controllers/` (thin), `application/` (use cases and the supplier client), `domain/` (pure rules, unit tested), `infra/` (Drizzle queries), `jobs/` (worker processors and schedules), `db/schema.ts`.
Three Nest modules: `SuppliersAdminModule` (routes and use cases, needs the database; listed in `NEEDS_DATABASE_AND_CACHE` of `test/support/app.ts`), `SupplierEngineModule` (client, sync, dispatch, poll: no routes, loaded by both processes) and `SupplierJobsModule` (processors and schedules, worker only).

## The supplier client (decision 026)

`SupplierClient` is the only place that calls suppliers. It decrypts the key for one call (AES-GCM with a key id, AAD `suppliers.api_key_enc`; the hint is the first 5 characters, written with the ciphertext and never decrypted on read), picks the driver (`dhru`; `rest` answers "REST suppliers are not supported yet" until a REST supplier exists) and calls through `OutboundHttp` (SSRF guard, required timeout `suppliers.timeout_ms`, no redirects). The Dhru request is a form post to `<baseUrl>/api/index.php` with `username`, `apiaccesskey`, `action`, `requestformat=JSON` and `parameters` = base64 of a JSON object (`CUSTOMFIELD` is base64 JSON again). Actions: `accountinfo`, `imeiservicelist`, `placeimeiorder`, `getimeiorder`. Production needs `https`; the setting `suppliers.allowPlainHttp` (editable in the settings screen) is the admin-visible opt-out. Tests provide `SUPPLIER_TARGET_POLICY` to reach a local fake supplier.

Every call returns a record that the caller writes to `supplier_api_logs`: `http_status` (0 without an HTTP answer), `duration_ms` (the time waited), `error` (`''` when fine) and the `outcome` `ok | error | timeout` (`timeout` = no HTTP answer in time; `error` = anything else: network error, HTTP >= 400, unusable body, a Dhru ERROR even on HTTP 200). Credentials and IMEIs are masked in the stored bodies (`redactBody`); a service list keeps only its count. `SupplierThrottle` applies `max_concurrency` (a semaphore) and `rate_limit_per_min` (the `supplier` limiter).

## Dispatch, poll and sync

See `docs/queues.md` (`supplier-dispatch`, `supplier-poll`, `supplier-sync`). In short: the dispatch job claims the order with a guarded update before the call and never sends twice; a REFERENCEID gives `sent`, a refusal, a timeout or no eligible link gives `needs_attention` with the reason and the hold kept; nothing is re-sent automatically. The automatic dispatch never fails over to a link that costs more than the price charged (user rule 9, B117 (6)); a staff `dispatch` or `change-supplier` may (the `supplier_changed` event records `costAbovePrice`). The poll tick (every minute) finds the sent orders that are due and queues a `poll` job each; STATUS 4 completes the order, STATUS 3 rejects it. `price_sync` (every 15 minutes) and `balance_check` (every 30 minutes) go through every supplier that is not disabled; staff's `POST /admin/suppliers/:id/sync` runs the same sync in the worker and waits for its counts (`504 SUPPLIER_TIMEOUT` after `timeout_ms + 5 s`).

Money: a supplier's result settles the order through `OrderTransitions`: the hold becomes revenue and, because the order has `supplier_id` and `supplier_ref`, the cost (`credit x credit_rate`, refreshed on the order when the supplier is chosen) is booked from the prepaid balance at the supplier (B17); a rejection releases the hold with no cost.

## Public API (`index.ts`)

Exports the modules (`SuppliersModule`, `SuppliersAdminModule`, `SupplierEngineModule`, `SupplierJobsModule`), the health rules (`supplierHealth`, `healthFromCalls`, `toPageHealth`, `runwayDays`, `isLowBalance`: the system health view of feature 9 reuses them), the link rules (`pickLink`, `linkUnitCost`), the four supplier call contracts (`SUPPLIER_CALLS`), `SupplierDirectory` (supplier names for other modules), `SupplierReader`, `SupplierDispatch`, `SupplierPoll`, `SupplierSync`, the vocabularies and row types, and the test policy token. Other modules import only `src/modules/suppliers/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 4 tables (`scripts/module-map.mjs`); other modules call its public services. Schema: `db/schema.ts`. Deviations: the orders module names `supplier_api_logs` in one SQL text (`order-supplier.repository.ts`, the poll candidates) and reads `suppliers` for names; the money module reads `suppliers` for ledger owner names; `foreign-reads.repository.ts` here reads `services` and `service_fields` (the catalog exports no service reader) and `service_checks` and `imei_checks` are read with plain selects (health and risk export no reader yet). Writes to the catalog go through the catalog's `ServiceImporter` and `recomputeEffectiveCost`.

| Table | What it holds |
|---|---|
| `suppliers` | Supplier connections and your balance with each one. |
| `supplier_services` | A copy of a supplier's services after a sync. |
| `service_supplier_links` | Links your service to a supplier service, in priority order. |
| `supplier_api_logs` | A log of every request sent to a supplier. |

## Routes

16 routes are built (the 13 below and the three order routes). Source: `docs/slices/suppliers.json` (generated from the map; `bun run routes:build`). Contracts are under `contracts/`.

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
| `GET /admin/suppliers/:id/services` | staff-permission · `suppliers:read` | The supplier's services after syncing. | 6 |
| `POST /admin/suppliers/:id/import/preview` | staff-permission · `catalog:create` | Preview the import: new, matching and changed services with the suggested price. | 6 |
| `POST /admin/suppliers/:id/import` | staff-permission · `catalog:create` | Import the selected items as services, fields and links. | 6 |
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

Walked end to end by `test/scenarios/{success,reject,timeout}.e2e.test.ts` against a fake Dhru supplier served in the test (`test/support/suppliers.ts`); 7a adds the merchant's Dhru steps to the same files. Other scenarios touching this module: `b2c-paid`, `b2c-ticket`, `system-alert` (later features).

## Permissions

Staff permissions the routes need: `suppliers:read`, `suppliers:create`, `suppliers:update`, `suppliers:delete`, `catalog:create`, `catalog:update`, `orders:update`, and `reports:read` for the report of stage 11. They come from the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced: none. Consumed: `order.dispatch_requested` (queue `supplier-dispatch`, payload `{ orderId }`, written by the orders module). Audit phrases written (the console prints `<actor> <action> <entityLabel>`): `added supplier`, `edited supplier`, `paused supplier`, `resumed supplier`, `disabled supplier`, `enabled supplier`, `deleted supplier`, `tested connection to`, `synced services from`, `imported services from`, `changed supplier links of` (entity `service`), and on orders `dispatched order`, `changed supplier of`, `fetched supplier result of`.

## Jobs and schedules

| Queue | Job | Schedule | Notes |
|---|---|---|---|
| `supplier-dispatch` | the outbox event `order.dispatch_requested` | event-driven | `SupplierDispatchProcessor` |
| `supplier-poll` | `supplier_poll_tick`, `poll` | tick every minute (`supplier-poll-tick`) | `SupplierPollProcessor` |
| `supplier-sync` | `supplier_sync`, `price_sync`, `balance_check` | every 15 and every 30 minutes (`supplier-price-sync`, `supplier-balance-check`) | `SupplierSyncProcessor`, scheduled runs in `job_runs` |

Idempotency keys, retry policies and the claim rule: `docs/queues.md`. Settings read: `catalog.importDefaultSlaMinutes` (default 1440), `orders.poll_slow_after_hours` (default 24), `suppliers.allowPlainHttp` (default off), all editable through `PATCH /admin/settings`.

## Cache keys

None of its own. The per-supplier semaphore and limiter use the general keys of `docs/cache-keys.md` (rate limits); the catalog price version is moved after a sync, an import and a change of a chain (`CatalogPriceVersion.bumpAfterCommit`).

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
