# Suppliers module (`suppliers`)

Map domain C. The suppliers we buy from: supplier accounts, their service catalogs, the links from our services to supplier services, the Dhru supplier client and the log of every supplier call.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 023 outbound HTTP, 026 Dhru compatibility. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Not built yet: the module is an empty shell (`suppliers.module.ts`, `index.ts`). Its feature adds controllers, services, repositories and the owned tables.

## Public API (`index.ts`)

Exports `SuppliersModule` only. Add the services other modules may call here, and nothing else: other modules import only `src/modules/suppliers/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 4 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `suppliers` | Supplier connections and your balance with each one. |
| `supplier_services` | A copy of a supplier's services after a sync. |
| `service_supplier_links` | Links your service to a supplier service, in priority order. |
| `supplier_api_logs` | A log of every request sent to a supplier. |

## Routes

18 endpoints (admin 14, supplier 4). Source: `docs/slices/suppliers.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (14)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/suppliers/:id` | staff-permission · `suppliers:*` | Suppliers: driver, URL, key (write-only) and limits. | 6 |
| `GET /admin/reports/suppliers` | staff-permission · `reports:read` | Supplier spend, rejection rate and speed. | 11 |
| `GET /admin/supplier-api-logs` | staff-permission · `suppliers:read` | Log of supplier requests and responses. | 6 |
| `GET /admin/supplier-api-logs/:id` | staff-permission · `suppliers:read` | Log of supplier requests and responses. | 6 |
| `GET /admin/suppliers` | staff-permission · `suppliers:*` | Suppliers: driver, URL, key (write-only) and limits. | 6 |
| `GET /admin/suppliers/:id` | staff-permission · `suppliers:*` | Suppliers: driver, URL, key (write-only) and limits. | 6 |
| `GET /admin/suppliers/:id/services` | staff-permission · `suppliers:read` | The supplier services after syncing. | 6 |
| `PATCH /admin/suppliers/:id` | staff-permission · `suppliers:*` | Suppliers: driver, URL, key (write-only) and limits. | 6 |
| `POST /admin/suppliers` | staff-permission · `suppliers:*` | Suppliers: driver, URL, key (write-only) and limits. | 6 |
| `POST /admin/suppliers/:id/import` | staff-permission · `catalog:create` | Import the selected items as services, fields and links. | 6 |
| `POST /admin/suppliers/:id/import/preview` | staff-permission · `catalog:create` | Preview the import: new, matching and changed services, with the suggested price. | 6 |
| `POST /admin/suppliers/:id/sync` | staff-permission · `suppliers:update` | Sync services and balance now. | 6 |
| `POST /admin/suppliers/:id/test` | staff-permission · `suppliers:update` | Test the connection through accountinfo. | 6 |
| `PUT /admin/services/:id/supplier-links` | staff-permission · `catalog:update` | Link the service to suppliers in priority order. | 6 |

### Supplier calls (outgoing) (4)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `SUPPLIER accountinfo` | outbound-supplier-account | Our balance at the supplier. | 6 |
| `SUPPLIER getimeiorder+getimeiorderbulk` | outbound-supplier-account | Poll the status and the result. | 6 |
| `SUPPLIER imeiservicelist` | outbound-supplier-account | The supplier's services and their cost, for sync. | 6 |
| `SUPPLIER placeimeiorder+placeimeiorderbulk` | outbound-supplier-account | Send the order and store supplier_ref. | 6 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `success`: Order completed by the supplier (tables: `service_supplier_links`, `supplier_api_logs`)
- `reject`: Supplier rejects the order (tables: `service_supplier_links`, `supplier_api_logs`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `supplier_api_logs`)
- `b2c-paid`: Paid storefront order (tables: `service_supplier_links`, `supplier_api_logs`)
- `b2c-ticket`: Support ticket about a delay (tables: `supplier_api_logs`)
- `system-alert`: Alert and incident: a supplier slows down (tables: `service_supplier_links`, `supplier_api_logs`, `suppliers`)

## Permissions

Staff permissions the map requires on this module's admin routes: `catalog:create`, `catalog:update`, `reports:read`, `suppliers:*`, `suppliers:read`, `suppliers:update`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `catalog-1` · GET /admin/services, GET/POST/PATCH /admin/services/:id, GET /admin/client-prices, GET /admin/pricing/resol...
- `orders-suppliers-3` · GET /admin/supplier-api-logs, GET /admin/supplier-api-logs/:id
- `orders-suppliers-4` · GET /admin/suppliers, GET /admin/suppliers/:id
- `orders-suppliers-5` · GET /admin/suppliers, GET /admin/suppliers/:id
- `orders-suppliers-6` · POST /admin/suppliers/:id/sync
- `orders-suppliers-7` · GET /admin/suppliers
- `orders-suppliers-8` · DELETE /admin/suppliers/:id
- `orders-suppliers-9` · POST /admin/suppliers
- `orders-suppliers-10` · POST /admin/suppliers/:id/import
- `orders-suppliers-13` · GET /admin/suppliers/:id
- `orders-suppliers-16` · GET /admin/suppliers, GET /admin/suppliers/:id
- `orders-suppliers-20` · GET /admin/suppliers
