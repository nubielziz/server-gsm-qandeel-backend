# Catalog & pricing module (`catalog`)

Map domain B. What is for sale and at what price: client groups, categories, services with their fields and options, group and client prices, pricing rules, inventory codes and the TAC catalog.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 026 Dhru compatibility. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 4a, catalog-structure, 20 routes): merchant groups, service categories, services with their custom fields and
option lists, and the code inventory. Pricing (group and client prices, pricing rules, bulk price, resolve, the merchant catalog)
is feature 4b; supplier links and import are feature 6; the TAC catalog is 14b.

- **Merchant groups** (`application/client-group-admin.service.ts`, `infra/group.repository.ts`): list with `merchantCount`
  (not for the retail group), show, create (`b2b`, last in the order), change, delete. One default group at all times: making a
  group the default moves the mark in the same transaction (an advisory lock keeps two such changes apart), the default group
  cannot be deleted (`GROUP_IN_USE`) or unmarked (`DEFAULT_GROUP_REQUIRED`), the storefront retail group (`b2c_retail`) cannot be
  deleted or be the default. A group stops allowing overdraft (`overdraftAllowed: false`) only while no merchant of the group has
  a credit limit above zero (user rule 2; credit holders from money's `MerchantWallets.idsWithCreditLimit`, members from identity's
  `MerchantGroupMembers`). Deleting a free group also deletes its group prices and pricing rules and removes its id from
  `service_categories.allowed_group_ids` (TODO feature 8: `payment_gateways.allowed_group_ids` through money). The group row is
  locked `FOR UPDATE` while it changes; the code that moves a merchant into a group (`ClientAdminService`) or sets a credit limit
  (`WalletService`) takes `FOR SHARE` on it, so these never interleave.
- **Categories** (`category-admin.service.ts`): `serviceCount` counts live services; a name is unique per type (case-insensitive,
  also mapped from the unique index); a type change waits until the live services have moved (archived ones follow by
  `ON UPDATE CASCADE`); delete only without any service row (`CATEGORY_IN_USE`, two details), deleting the category's pricing
  rules with it.
- **Services** (`service-admin.service.ts`, `infra/service.repository.ts`, `infra/service-figures.sql.ts`): `cost` on the wire is
  the effective cost, `minProfit` the service's own or the default policy `max(round(6 % of cost, 2), 0.02)`, `floorPrice` =
  cost + minProfit, `marginPct`, `belowFloor`; all worked out in SQL so the list can filter and sort on them
  (`domain/service-figures.ts` is the same rule in code; a test compares the two). Create sets the server defaults (`active`,
  `auto`, `fixed`, `block_open`, cost 0) and derives `delivery_time` from `slaMinutes`; change refuses a `basePrice` under the
  floor (the minimum profit being saved counts), clears `cost_was` when a base price is saved, keeps category and type in
  agreement (composite FK), maps a code clash to `409 CODE_TAKEN`; delete archives (`archived_at`, status `disabled`, service
  pricing rules off) when anything refers to the service and hard deletes otherwise. Archived services are hidden from every
  read here and their code is free again.
- **Fields and options** (`service-parts.service.ts`): replace-all in one transaction under a lock on the service row, `422` on
  the later duplicate's dotted path.
- **Inventory** (`inventory-admin.service.ts`, `domain/inventory-codes.ts`): codes AES-GCM encrypted (`inventory_codes.code_enc`)
  with `code_hash` (`TokenService.hash` of `inventory-code:<code>`) and `code_last4`; import counts imported, duplicates and
  rejected, never logs a clear code; void only `available` codes, idempotent.
- **`recomputeEffectiveCost(tx, serviceIds)`** (`application/effective-cost.ts`): the one writer of `services.effective_cost`.

Known deviation (tech debt): `infra/foreign-reads.repository.ts` reads supplier links, `orders`, `service_listings`,
`checkout_sessions`, `help_articles` and `imei_checks` with plain selects, because those modules export no service yet (the
supplier chain of a service row and the archive-or-delete decision); replace its bodies with their public services as they
appear (orders 5, suppliers 6, storefront 14a and 15, customers, risk 18). Nothing outside that file knows.

## Public API (`index.ts`)

Exports `CatalogModule` (global) and `CatalogAdminModule` (the routes; a database-less test app leaves it out), the read-only
`ClientGroupDirectory` (`find(db, id, { lock: 'share' }?)`, `findDefault`, `refsOf`, `promotionLadder`; a `ClientGroupRef` has id,
name, kind, discountPercent, isDefault, overdraftAllowed, earnThreshold, depositLimit; identity uses it for the group a new
merchant joins, the group inside a merchant row and the nightly promotion), `recomputeEffectiveCost(tx, serviceIds)` (feature 6
calls it from sync, import and link changes), the figure rules (`defaultMinProfit`, `effectiveMinProfit`, `floorPrice`,
`marginPercent`, `isBelowFloor`, `deliveryTimeText`), the closed vocabularies `SERVICE_PRICE_MODES`, `SERVICE_DUPLICATE_RULES` and
`SERVICE_TYPES`, and the inventory helpers the seed uses. Other modules import only `src/modules/catalog/index.ts` (lint rule
`gsm/module-boundaries`). The export order matters (decision 032): the leaves identity injects come first, `CatalogAdminModule`
(whose controllers use identity's decorators) last.

Planned exports (audit resolutions): the `PriceResolver` (one resolver for resolve, orders, price lists and the group/client price
checks, plus the b2c_retail floor for the storefront listings: catalog-4, b2c-7; algorithm in `RULES.md` services 3), feature 4b.

## Owned tables

Only this module reads and writes these 10 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`.

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

43 endpoints (admin 37, client 3, v1 2, dhru 1). Source: `docs/slices/catalog.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built: the 20 routes of feature 4a are in `contracts/{client-groups,categories,services,inventory}.contracts.ts`, the rest are pending (`test/contract/pending.ts`).

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

Staff permissions the map requires on this module's admin routes: `catalog:*`, `catalog:update`, `groups:*`, `inventory:read`, `inventory:write`, `pricing:*`, `pricing:read`, `pricing:update`. A `*` row means the action of the method: `groups:read|create|update|delete` (client groups), `catalog:read|create|update|delete` (categories, services); fields and options need `catalog:update`; the inventory routes `inventory:read` and `inventory:write`. Audit entity types written: `client_group`, `category`, `service` and `inventory_code` (a void; the import is audited on the `service`).

API key scopes on its REST v1 routes: `services:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None in this module. The nightly group promotion (`client_group_promotion`) writes `clients.group_id`, so it lives in identity
(`src/modules/identity/jobs/`); it reads thresholds through `ClientGroupDirectory.promotionLadder` and is documented in
`docs/queues.md`.

## Data migration

`drizzle/0005_default_client_groups.sql` makes sure a default merchant group and the storefront retail group exist (a fresh
database had none, so `POST /client/auth/register` and `POST /admin/clients` answered 500). It marks the first merchant group as the
default when groups exist without one, inserts `Standard` (default, no discount, threshold 0, no deposit limit, no overdraft) when
there is no merchant group, and inserts `Storefront retail` when there is no `b2c_retail` group. The seed's demo groups reuse or
replace these rows (`scripts/seed/identity.ts`).

## Cache keys

None: the structure of the catalog is read from Postgres on every request. The merchant catalog and price lists (feature 4b)
add their cache keys with the price version.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-7` · GET /admin/service-listings, PATCH /admin/service-listings/:id
- `catalog-1` · GET /admin/services, GET/POST/PATCH /admin/services/:id, GET /admin/client-prices, GET /admin/pricing/resol...
- `catalog-2` · POST /admin/services
- `catalog-3` · DELETE /admin/services/:id
- `catalog-4` · GET /admin/pricing/resolve
- `catalog-5` · DELETE /admin/client-groups/:id
- `catalog-6` · DELETE /admin/service-categories/:id
- `catalog-7` · PATCH /admin/tac-catalog/:id
- `catalog-8` · GET /admin/tac-catalog, GET/POST/PATCH /admin/tac-catalog/:id
- `catalog-9` · GET /admin/services, GET /admin/services/:id, POST/PATCH /admin/services
- `catalog-10` · POST /admin/service-categories, PATCH /admin/service-categories/:id
- `catalog-11` · PUT /admin/services/:id/options, PUT /admin/services/:id/group-prices
- `catalog-12` · PUT /admin/services/:id/group-prices
- `catalog-13` · PATCH /admin/services/:id
- `catalog-14` · PATCH /admin/services/:id
- `catalog-15` · GET /admin/inventory-codes, POST /admin/services/:id/inventory/import
- `catalog-16` · GET /admin/client-prices
- `catalog-17` · POST /admin/client-groups, PATCH /admin/client-groups/:id
- `identity-platform-3` · POST /admin/clients
- `orders-suppliers-10` · POST /admin/suppliers/:id/import
