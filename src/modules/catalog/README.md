# Catalog & pricing module (`catalog`)

Map domain B. What is for sale and at what price: client groups, categories, services with their fields and options, group and client prices, pricing rules, inventory codes and the TAC catalog.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 026 Dhru compatibility. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: feature 4a (catalog-structure, 20 routes): merchant groups, service categories, services with their custom fields and
option lists, and the code inventory; feature 4b (catalog-pricing, 16 routes): group prices, client prices, pricing rules, the
bulk price change, the price resolver and the merchant catalog (below); feature 14b (4 routes): the TAC catalog (below). Supplier links and import are
feature 6.

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
  rejected, never logs a clear code; void only `available` codes, idempotent. `InventoryStock` (`application/inventory-stock.ts`,
  public, in `CatalogModule`) hands codes to an order at placement: `claim` locks the oldest available codes of a service
  (`FOR UPDATE SKIP LOCKED`) and decrypts them as the order's result, `sell` marks them sold with the order id (RULES orders 10).
- **`recomputeEffectiveCost(tx, serviceIds)`** (`application/effective-cost.ts`): the one writer of `services.effective_cost`.

### TAC catalog (feature 14b)

`TacCatalogAdminService` (`application/tac-catalog-admin.service.ts`, `infra/tac-catalog.repository.ts`, `domain/tac-input.ts`) serves
`/admin/tac-catalog` (`catalog:read|create|update`, audit entity type `tac_entry`): list with `q` over TAC (a typed prefix finds it), brand, model code and
marketing name, an exact `brand` filter, sorts by `tac` (default), `brand`, `model` and `releaseYear`; add (`source` `manual`) and correct. A TAC appears once
(`409 TAC_TAKEN` on `tac`, also for two requests at once through the unique index). RESOLUTIONS catalog-7: the `tac` of an entry is editable only while no `imei_checks`
row has it (`imei_checks.tac` is history, no `ON UPDATE CASCADE`): otherwise `422` on `tac` with "N IMEI checks already use TAC <old>; add a new entry for the new TAC
instead." (the count is a foreign read of risk's table, `infra/tac-foreign-reads.repository.ts`). RESOLUTIONS catalog-8: `release_year` stays nullable and an unknown year is
sent as `0` (sorted as 0); a body year is a whole number from 1990 to next year by the clock (0 and null are `422` on `releaseYear`); a year cannot be cleared; `brand` and
`model` cannot be emptied. The seed loads the demo's eight TACs (`scripts/seed/customers.ts`).

### Pricing (feature 4b)

- **The resolver** (`domain/price-resolution.ts` pure, `application/price-resolver.ts` loader, `infra/pricing-data.repository.ts`):
  user rule 8, RESOLUTIONS catalog-4, step by step: a client price wins, else a group price, else the base price; then ONE pricing
  rule (active, inside its window on the clock's time, for every group or the merchant's group, scope service > category > global,
  then priority ascending, then group-specific first, then id) applies margin (+) or discount and promo (-) as
  `p x (1 + s x percent / 100) + s x fixed`; then the group discount; then round half-up to cents; then the winning rule's
  `rounding` (`nearest_0.05`, `nearest_0.10`, `ends_99`); then the floor clamp `max(rawPrice, effective cost + minProfit)`. Fixed
  (client or group) prices skip the rule, the discount and both roundings and are never rounded. The minimum profit is the
  service's own, else the first matching rule's above zero (rules for every group only without a merchant group), else
  `max(round(6 % x cost, 2), 0.02)`. Steps carry the ids and labels the console's trace draws (`category` is labelled "Service
  rule", "Category rule" or "Global rule"; `rounding` carries the rounded price; money values are 4-decimal text, `category` and
  `discount` values are signed fractions as numbers). `PricingContext` answers many questions after one load (the price for a
  merchant and for every group, the floors of a group-price save); `PriceResolver.floor` is the one floor function checkout and the
  storefront listings use, with `storefrontFloor(base, floor)` = `max(round(base x 1.10, 2), floor)` (catalog-12, b2c-7). The SQL of
  the service list (`infra/service-figures.sql.ts`) is the same minimum-profit rule for merchant-less contexts; a test keeps the two
  equal.
- **Group prices** (`group-price-admin.service.ts`, `domain/group-prices.ts`): replace-all under a lock on the service row and a
  shared lock on the groups; every submitted row is held to its floor (a merchant group at the effective cost plus the minimum
  profit for that group; `b2c_retail` at the storefront floor), rows kept unchanged included; repeated groups are `422
  prices.N.groupId` "Listed twice".
- **Client prices** (`client-price-admin.service.ts`): one per merchant and service (`409 PRICE_EXISTS`), above zero and at or above
  the floor of the merchant's group; `groupPrice` on each row is the resolver result for the merchant's group without the client
  price (catalog-16). Audit like the demo: `set client price for` and `removed client price for` on the `merchant`.
- **Pricing rules** (`pricing-rule-admin.service.ts`, `domain/pricing-rule-input.ts`): CRUD with the target and group checked under
  share locks, amounts never negative, one of percent and fixed above zero, a discount or promo at most 100 %, a margin at most
  1000 %, a window that runs forwards; a rule being turned off is never refused for its target. Audit entity `pricing_rule`
  (`added`, `edited`, `removed pricing rule for`).
- **Bulk price** (`bulk-price-admin.service.ts`, `domain/bulk-price.ts`): preview saves nothing (a POST with `audit: false`); apply
  recomputes from the locked current prices, saves every new price (under the floor too, counted), clears `cost_was` and writes one
  `changed prices of` entry.
- **Merchant catalog** (`merchant-catalog.ts`, `client-catalog.service.ts`, `infra/merchant-catalog.repository.ts`): the live,
  `active` services in an active category open to the merchant's group, at the merchant's price; cost, floor and supplier names are
  never sent. `MerchantCatalog` (`page`, `pageAfter`, `find`, `all`) is the public piece the Dhru and REST v1 lists (7a) reuse. Shapes: B159.
- **Merchant machine surfaces** (`merchant-api-catalog.ts`, `controllers/v1-services.controller.ts`, feature 7a): `GET /v1/services` (cursor
  pages in id order: `?limit=` 1 to 100, default 50, `?cursor=`; filters `type`, `categoryId` and `q`), `GET /v1/services/:id` (adds the
  custom `fields` and the model, network and MEP `options`) and the Dhru `imeiservicelist`, which the service binds to the `DhruGateway` at
  start. Visibility, prices and the quantity rules are the portal's (B159); each row also says `allowCancel`, `allowVerify` and
  `verifyWindowH`. The Dhru `LIST` is grouped by category (`GROUPNAME`, `GROUPTYPE` IMEI, SERVER or REMOTE; two categories with one name
  keep unique group keys by adding the type), `SERVICES` by service id with the keys of decision 026 (`SERVICEID`, `SERVICETYPE`,
  `SERVICENAME`, `CREDIT`, `INFO`, `TIME`, `QNT`, `QNTOPTIONS`, `MINQNT`, `MAXQNT`, the twelve `Requires.*` flags and `Requires.Custom`
  built from the service's fields; an IMEI service's own `imei` field is not repeated there). File services are not in the Dhru list.
  Every list records the prices it showed (`ListedPrices.record`, user rule 9). Nothing is cached: a price list is never the truth for a
  charge (the order path prices again) and staleness would show an old price after a change.
- **Merchant switches** (feature 7a): `POST /admin/services` and `PATCH /admin/services/:id` accept the optional `allowCancel`,
  `allowVerify` (booleans) and `verifyWindowH` (integer 0 to 720, `0` = no window); the three start off, the reads return them, and
  the change is audited with the service's own verb phrases (`created service`, `edited service`, the switches in `before`/`after`).
  The console does not send them, so its writes keep the stored values.
- **Price protection** (user rule 9, MISMATCHES B117): `ListedPrices.record(db, clientId, entries, at)` remembers the last price
  listed to a merchant (table `listed_prices`, written only when the price changes); the three portal routes call it, and so do 7a's
  lists (`GET /v1/services[/:id]`, `imeiservicelist`). `checkPriceChange(listed, current, tolerance, { floorRaised? })` is the pure guard feature 5 calls at placement: above the
  tolerance `refuse` (`409 PRICE_CHANGED` with `listedPrice` and `currentPrice`), within it `raised` (charge it, record
  `raised = true` and the reason `floor` or `price_change` in `pricing_snapshot`), nothing on record `ok`. The tolerance is the
  setting `pricing.price_change_tolerance_percent` (platform settings registry, integer 0 to 100, default 10; read with
  `SettingsReader.integer(PRICE_CHANGE_TOLERANCE_KEY, DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT, PRICE_CHANGE_TOLERANCE_BOUNDS)`).
- **Price version** (`catalog-price-version.ts`, `catalog-prices.module.ts`): `CatalogPriceVersion.bumpAfterCommit(work)` moves the
  `catalog` version counter after the commit of every write that can change a resolved price (services, group prices, client
  prices, rules, a group's discount or delete, categories); feature 6 calls it when `recomputeEffectiveCost` reports a change.
  Cached price lists read through `CatalogPriceVersion.versioned(key)`. This feature caches nothing itself.

Known deviation (tech debt): `infra/foreign-reads.repository.ts` reads supplier links, `orders`, `service_listings`,
`checkout_sessions`, `help_articles` and `imei_checks` with plain selects, because those modules export no service yet (the
supplier chain of a service row and the archive-or-delete decision); replace its bodies with their public services as they
appear (orders 5, suppliers 6, storefront 14a and 15, customers, risk 18). Nothing outside that file knows.

## Public API (`index.ts`)

Exports `CatalogModule` (global) and `CatalogAdminModule` (the routes; a database-less test app leaves it out), the read-only
`ClientGroupDirectory` (`find(db, id, { lock: 'share' }?)`, `findDefault`, `findRetail` (the storefront's `b2c_retail` group, feature 14a), `refsOf`, `promotionLadder`; a `ClientGroupRef` has id,
name, kind, discountPercent, isDefault, overdraftAllowed, earnThreshold, depositLimit; identity uses it for the group a new
merchant joins, the group inside a merchant row and the nightly promotion), `recomputeEffectiveCost(tx, serviceIds)` (feature 6
calls it from sync, import and link changes), the figure rules (`defaultMinProfit`, `effectiveMinProfit`, `floorPrice`,
`marginPercent`, `isBelowFloor`, `deliveryTimeText`), the closed vocabularies `SERVICE_PRICE_MODES`, `SERVICE_DUPLICATE_RULES` and
`SERVICE_TYPES`, the inventory helpers the seed uses, and the storefront's read-only views (feature 14a): `StorefrontServices`
(`sellable(db, ids, groupId)`: the merchant catalog's visibility rule for the retail group, no cost or supplier; `priced(db, groupId)`: the
sellable ids that also have a fixed price for the group; `names(db, ids)`: name, type and delivery time whatever the service's state;
`fields(db, serviceId)`) and `TacDirectory.find(db, tac)` (brand, model, marketing name and year of a TAC). Other modules import only `src/modules/catalog/index.ts` (lint rule
`gsm/module-boundaries`). The export order matters (decision 032): the leaves identity injects come first, `CatalogAdminModule`
(whose controllers use identity's decorators) last.

Feature 4b adds, all global through `CatalogModule` (they take the caller's database handle, so they need only the clock) except
the price version: `PriceResolver` (`context`, `resolveMany`, `resolve`, `floor`) and `PricingContext`, `ListedPrices` (`record`,
`find`, `findMany`), `MerchantCatalog` (`page`, `find`, `all`), the pure `resolveServicePrice`, `floorFor`, `orderedRules`,
`ruleMatches`, `ruleMinProfit`, `storefrontFloor`, `belowFloorMessage`, `applyRounding`, the price guard `checkPriceChange` with
`PRICE_CHANGE_TOLERANCE_KEY`, `DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT` and `PRICE_CHANGE_TOLERANCE_BOUNDS`, and `CatalogPriceVersion`
(`CatalogPricesModule`, global, needs the cache; a test app without the infrastructure leaves it out like `CatalogAdminModule`).

Feature 15 adds `RetailPrices` (global through `CatalogModule`, takes the caller's database handle): the storefront's door into the
catalog. `retailGroupId`, `quotes(db, serviceIds, at?)` (per live service: effective cost, minimum profit for the retail group, the
storefront floor `storefrontFloor(base, floor)` and the retail price), `lockLiveService(db, id, 'update' | 'share')` and `set(db,
serviceId, price)` (the one writer of the retail row of `service_group_prices` outside the group-price route; the caller moves the
price version after its commit). `PATCH /admin/service-listings/:id` uses it, so the listing page and the group-price page hold
the retail price to the same floor.

## Owned tables

Only this module reads and writes these 10 tables and `listed_prices` (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`.

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
| `listed_prices` | The last price listed to a merchant for a service (price protection, user rule 9). A backend addition to the map's tables (B158), migration `0006_listed_prices.sql`. |

## Routes

43 endpoints (admin 37, client 3, v1 2, dhru 1). Source: `docs/slices/catalog.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built: the 20 routes of feature 4a are in `contracts/{client-groups,categories,services,inventory}.contracts.ts`, the 16 of feature 4b in `contracts/{pricing,client-prices,pricing-rules,merchant-catalog}.contracts.ts`, the rest are pending (`test/contract/pending.ts`).

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

Staff permissions the map requires on this module's admin routes: `catalog:*`, `catalog:update`, `groups:*`, `inventory:read`, `inventory:write`, `pricing:*`, `pricing:read`, `pricing:update`. A `*` row means the action of the method: `groups:read|create|update|delete` (client groups), `catalog:read|create|update|delete` (categories, services), `pricing:read|create|update|delete` (client prices, pricing rules); fields and options need `catalog:update`; group prices and the bulk price change `pricing:update`; the resolver `pricing:read`; the inventory routes `inventory:read` and `inventory:write`. Audit entity types written: `client_group`, `category`, `service` (also the group prices and the bulk change), `merchant` (client prices), `pricing_rule` and `inventory_code` (a void; the import is audited on the `service`).

API key scopes on its REST v1 routes: `services:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced: `service.price_changed` (queue `merchant-webhooks`, aggregate `services`, payload `{ clientId, serviceId, previousPrice, price, currency }`), written by
`PriceChangeScan` (feature 7b, user rule 9 (5)): see "Jobs and schedules". Consumed: none. The route is registered by the platform module.

## Jobs and schedules

`service_price_scan` (queue `maintenance`, processor `jobs/price-change-scan.processor.ts`, module `PriceChangeScanModule` in the worker; feature 7b): every move of the
catalog price version tells its listeners (`PriceVersionListeners`), and `PriceChangeScan` adds a delayed job (60 s, job id `price-scan-<minute>`, so at most one a minute).
The scan compares, for every active merchant and service of the last 30 days of orders (read through the foreign reads of `infra/foreign-reads.repository.ts`), the price a
new order would pay now (`PriceResolver`, floor included) with the unit price of the merchant's latest order, and writes `service.price_changed` for each difference
that has no event with the same ids yet (`OutboxService.hasEvent`; the webhook fan-out is idempotent on the same change as well). Event-driven, so no `job_runs` row.
A merchant who has not ordered the service in 30 days is not told; a price that goes back to the last order's price is not announced.

Otherwise none in this module. The nightly group promotion (`client_group_promotion`) writes `clients.group_id`, so it lives in identity
(`src/modules/identity/jobs/`); it reads thresholds through `ClientGroupDirectory.promotionLadder` and is documented in
`docs/queues.md`.

## Data migration

`drizzle/0005_default_client_groups.sql` makes sure a default merchant group and the storefront retail group exist (a fresh
database had none, so `POST /client/auth/register` and `POST /admin/clients` answered 500). It marks the first merchant group as the
default when groups exist without one, inserts `Standard` (default, no discount, threshold 0, no deposit limit, no overdraft) when
there is no merchant group, and inserts `Storefront retail` when there is no `b2c_retail` group. The seed's demo groups reuse or
replace these rows (`scripts/seed/identity.ts`).

## Cache keys

No key of its own: the catalog and the prices are read from Postgres on every request. The module owns the `catalog` version
counter (`gsm:{env}:cache:version:catalog`, `CatalogPriceVersion`), moved after the commit of every write that can change a resolved
price; a price list that is cached later reads through it (`docs/cache-keys.md`). Feature 7a caches no list.

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
