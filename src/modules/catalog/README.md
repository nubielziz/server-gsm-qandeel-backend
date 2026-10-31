# Catalog & pricing module (`catalog`)

Map domain B. What is for sale and at what price: client groups, categories, services with their fields and options, group and client prices, pricing rules, inventory codes and the TAC catalog.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 026 Dhru compatibility. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Not built yet: the module is an empty shell (`catalog.module.ts`, `index.ts`). Its feature adds controllers, services, repositories and the owned tables.

## Public API (`index.ts`)

Exports `CatalogModule` only. Add the services other modules may call here, and nothing else: other modules import only `src/modules/catalog/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 10 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `client_groups` | Merchant groups with their discount percentages and promotion limits; kind = b2c_retail marks the single retail group used by the storefront. |
| `service_categories` | Service categories; equal to GROUPNAME in Dhru. |
| `services` | Services; id equals SERVICEID. |
| `service_fields` | Custom fields of a service; equal to Requires.Custom. |
| `service_options` | Lists of models, providers and MEP values for a service. |
| `service_group_prices` | The price of a service per merchant group, including the storefront Retail price. |
| `service_client_prices` | A negotiated price of a service for one specific merchant. |
| `pricing_rules` | Margin and discount rules for automatic pricing. |
| `inventory_codes` | Stock of digital codes. |
| `tac_catalog` | The first 8 digits of an IMEI (TAC) with brand and model; used for automatic recognition, IMEI checks and SEO pages. |

## Routes

43 endpoints (admin 37, client 3, v1 2, dhru 1). Source: `docs/slices/catalog.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (37)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/client-groups/:id` | staff-permission · `groups:*` | Merchant groups: discount, upgrade threshold and deposit limit. | 4 |
| `DELETE /admin/client-prices/:id` | staff-permission · `pricing:*` | A special price for a merchant on a service. | 4 |
| `DELETE /admin/pricing-rules/:id` | staff-permission · `pricing:*` | Margin and discount rules. | 4 |
| `DELETE /admin/service-categories/:id` | staff-permission · `catalog:*` | Service categories and the merchant groups that can see them. | 4 |
| `DELETE /admin/services/:id` | staff-permission · `catalog:*` | Services: type, execution, pricing mode and rules. | 4 |
| `GET /admin/client-groups` | staff-permission · `groups:*` | Merchant groups: discount, upgrade threshold and deposit limit. | 4 |
| `GET /admin/client-groups/:id` | staff-permission · `groups:*` | Merchant groups: discount, upgrade threshold and deposit limit. | 4 |
| `GET /admin/client-prices` | staff-permission · `pricing:*` | A special price for a merchant on a service. | 4 |
| `GET /admin/inventory-codes` | staff-permission · `inventory:read` | Code inventory and the status of each code. | 5 |
| `GET /admin/pricing-rules` | staff-permission · `pricing:*` | Margin and discount rules. | 4 |
| `GET /admin/pricing-rules/:id` | staff-permission · `pricing:*` | Margin and discount rules. | 4 |
| `GET /admin/pricing/resolve` | staff-permission · `pricing:read` | The price of a service for a merchant, with the resolution trace. | 4 |
| `GET /admin/service-categories` | staff-permission · `catalog:*` | Service categories and the merchant groups that can see them. | 4 |
| `GET /admin/service-categories/:id` | staff-permission · `catalog:*` | Service categories and the merchant groups that can see them. | 4 |
| `GET /admin/services` | staff-permission · `catalog:*` | Services: type, execution, pricing mode and rules. | 4 |
| `GET /admin/services/:id` | staff-permission · `catalog:*` | Services: type, execution, pricing mode and rules. | 4 |
| `GET /admin/tac-catalog` | staff-permission · `catalog:*` | TAC table: brand and model for each IMEI prefix. | 14 |
| `GET /admin/tac-catalog/:id` | staff-permission · `catalog:*` | TAC table: brand and model for each IMEI prefix. | 14 |
| `PATCH /admin/client-groups/:id` | staff-permission · `groups:*` | Merchant groups: discount, upgrade threshold and deposit limit. | 4 |
| `PATCH /admin/client-prices/:id` | staff-permission · `pricing:*` | A special price for a merchant on a service. | 4 |
| `PATCH /admin/pricing-rules/:id` | staff-permission · `pricing:*` | Margin and discount rules. | 4 |
| `PATCH /admin/service-categories/:id` | staff-permission · `catalog:*` | Service categories and the merchant groups that can see them. | 4 |
| `PATCH /admin/services/:id` | staff-permission · `catalog:*` | Services: type, execution, pricing mode and rules. | 4 |
| `PATCH /admin/tac-catalog/:id` | staff-permission · `catalog:*` | TAC table: brand and model for each IMEI prefix. | 14 |
| `POST /admin/client-groups` | staff-permission · `groups:*` | Merchant groups: discount, upgrade threshold and deposit limit. | 4 |
| `POST /admin/client-prices` | staff-permission · `pricing:*` | A special price for a merchant on a service. | 4 |
| `POST /admin/inventory-codes/void` | staff-permission · `inventory:write` | Void unsold codes. | 5 |
| `POST /admin/pricing-rules` | staff-permission · `pricing:*` | Margin and discount rules. | 4 |
| `POST /admin/service-categories` | staff-permission · `catalog:*` | Service categories and the merchant groups that can see them. | 4 |
| `POST /admin/services` | staff-permission · `catalog:*` | Services: type, execution, pricing mode and rules. | 4 |
| `POST /admin/services/:id/inventory/import` | staff-permission · `inventory:write` | Import codes with duplicate detection. | 5 |
| `POST /admin/services/bulk-price/apply` | staff-permission · `pricing:update` | Apply the bulk price change. | 4 |
| `POST /admin/services/bulk-price/preview` | staff-permission · `pricing:update` | Preview a bulk price change. | 4 |
| `POST /admin/tac-catalog` | staff-permission · `catalog:*` | TAC table: brand and model for each IMEI prefix. | 14 |
| `PUT /admin/services/:id/fields` | staff-permission · `catalog:update` | Custom fields of the service. | 4 |
| `PUT /admin/services/:id/group-prices` | staff-permission · `pricing:update` | Service price for each merchant group. | 4 |
| `PUT /admin/services/:id/options` | staff-permission · `catalog:update` | Model, network and MEP option lists. | 4 |

### Merchant portal (3)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/prices/export` | merchant-session | My price list as CSV. | 4 |
| `GET /client/services` | merchant-session | Catalog at my prices, grouped by category. | 4 |
| `GET /client/services/:id` | merchant-session | Field schema for the dynamic order form. | 4 |

### REST API v1 (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /v1/services` | api-key · `services:read` | Catalog at the merchant's prices; filter by type, category and search. | 7 |
| `GET /v1/services/:id` | api-key · `services:read` | Service details with the field schema and quantities. | 7 |

### Dhru Fusion API (1)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DHRU imeiservicelist` | dhru-credentials | Services available to the merchant's client group, with the merchant's prices and order fields. | 7 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `success`: Order completed by the supplier (tables: `service_fields`, `services`)
- `reject`: Supplier rejects the order (tables: `service_fields`, `services`)
- `manual`: Manual fulfilment by staff (tables: `service_fields`, `services`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `service_fields`, `services`)
- `b2c-paid`: Paid storefront order (tables: `service_group_prices`, `tac_catalog`)

## Permissions

Staff permissions the map requires on this module's admin routes: `catalog:*`, `catalog:update`, `groups:*`, `inventory:read`, `inventory:write`, `pricing:*`, `pricing:read`, `pricing:update`.

API key scopes on its REST v1 routes: `services:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").
