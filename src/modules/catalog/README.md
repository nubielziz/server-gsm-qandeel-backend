# Catalog & pricing module (`catalog`)

Map domain B. What is for sale and at what price: client groups, categories, services with their fields and options, group and client prices, pricing rules, inventory codes and the TAC catalog (a table with no routes since decision 068).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 026 Dhru compatibility, 051 field patterns (feature 41), 063 the price grid and the stored order of services, 065 one Name per field and the main input flag, 066 the `ids` read of the merchant catalog, 068 the TAC catalog loses its routes, 070 order forms draw only the custom fields, 071 the IMEI field of a plain IMEI service, 072 the option lists lose their write route, 073 IMEI is a field type. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: feature 4a (catalog-structure, 19 of its 20 routes; `PUT /admin/services/:id/options` is retired, decision 072): merchant groups, service
categories, services with their custom fields (their option lists are read only), and the code inventory; feature 4b (catalog-pricing, 16 routes): group prices, client prices, pricing rules, the
bulk price change, the price resolver and the merchant catalog (below); feature 14b (the TAC catalog: its 4 routes are retired, decision 068). Supplier links and import are
feature 6.

- **Ranks, the merchant groups and the retail rank** (`application/client-group-admin.service.ts`, `infra/group.repository.ts`; decision 064): every
  rank answers its kind, `rankKind` (`merchant` for the stored kind `b2b`, `retail` for any other), and `accountCount`, the number of accounts in it
  (guests included, and the retail rank too; `merchantCount` is gone), through identity's `MerchantGroupMembers.countByGroup`. List, show, create
  (`b2b`, last in the order), change, delete. One default group at all times: making a
  group the default moves the mark in the same transaction (an advisory lock keeps two such changes apart), the default group
  cannot be deleted (`GROUP_IN_USE`) or unmarked (`DEFAULT_GROUP_REQUIRED`), the storefront retail group (`b2c_retail`) cannot be
  deleted or be the default. **The retail rank never allows credit:** `client_groups_retail_no_credit_check` refuses it on the table and
  `PATCH /admin/client-groups/:id` answers `422` on `overdraftAllowed` (code `retail_no_credit`). A group stops allowing overdraft (`overdraftAllowed: false`) only while no merchant of the group has
  a credit limit above zero (user rule 2; credit holders from money's `MerchantWallets.idsWithCreditLimit`, members from identity's
  `MerchantGroupMembers`). **A rank is deleted only while no account is in it**; the rank history of money (`account_rank_changes`) keeps the ids and names of
  both ranks of every change without a foreign key to this table, so it never blocks a delete and the console shows the stored name of a deleted rank.
  Deleting a free group also deletes its group prices and pricing rules and removes its id from
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
  (`domain/service-figures.ts` is the same rule in code; a test compares the two). Decision 069: a row also carries `ownCost`
  (`services.cost`), `stockDelivery` and `stockAvailable` (available codes, counted in SQL: `availableCodeCountSql`). Create sets the
  server defaults (`active`, `auto`, `fixed`, `block_open`, own cost 0 or the `ownCost` sent, effective cost equal to it, no code stock
  unless `stockDelivery` is sent) and derives `delivery_time` from `slaMinutes`; with `ownCost` sent it refuses a `basePrice` under the
  floor that cost sets, as a change does; change refuses a `basePrice` under the
  floor (the minimum profit being saved counts), clears `cost_was` when a base price is saved, keeps category and type in
  agreement (composite FK), maps a code clash to `409 CODE_TAKEN`; a `basePrice` or `minProfit` change also needs `pricing:update` (decision 046); delete archives (`archived_at`, status `disabled`, service
  pricing rules off) when anything refers to the service and hard deletes otherwise. Archived services are hidden from every
  read here and their code is free again.
- **The Catalog page's reads** (decision 060; `application/service-read-access.ts`, `domain/service-attention.ts`,
  `infra/service-attention.sql.ts`): every answer of the list, show, create and change routes also carries `attention` (the
  reasons `no_supplier`, `below_floor`, `price_proposal`, `publish_failed`, enabled services only), the shop price
  `retailPrice` with `retailPriceSource` (these three are sent to every reader on every path and are required in the contract; `toView`
  in `service-admin.service.ts` writes them for the list, the detail and both write answers), and, by permission, `retailPriceRule` and `retailPriceWaiting` (`pricing:read`) and
  `listingId`, `isListed` and `shopBlocked` (`storefront:read`); the detail adds `publishFailure` (`storefront:read`). A key the
  caller may not read is left out, and a reason it may not read is not in `attention` nor in `needsAttention`. `serviceReadAccess`
  is the one rule for the four routes. The list filters `needsAttention`, `hasSupplier`, `supplierId` (the primary supplier),
  `stockDelivery` (decision 069, the console's Inventory menu), `isListed` and `notOnShop` (the last two `403` without
  `storefront:read`, before any query) and sorts on `retailPrice`. Each
  reason, the shop block and "not on the shop" is one SQL expression in `service-attention.sql.ts`, used by the filters, the count
  and the flags (their own select per page, not the page query, which the bulk price change shares); the parts over supplier and
  storefront tables are built in `foreign-reads.repository.ts`. `shopBlocked` repeats the first checks of the storefront's publish
  rule, and a test compares the two over every combination.
- **Fields** (`service-parts.service.ts`; the option lists have no writer since decision 072, see "Service options" below): replace-all in one
  transaction under a lock on the service row, `422` on the later duplicate's dotted path. A field has a hidden key (`service_fields.key`: made by the server from the Name when the field is
  created, `freeFieldKey(fieldKeyBase(name))` in `src/common/field-names.ts`, never changed; the order forms answer under it) and a Name
  (`service_fields.supplier_key`, on the wire `name`: unique in the service ignoring letter case, what a supplier receives in
  `CUSTOMFIELD`; decision 065). A row of the PUT carries the `key` of a saved field or none for a new one; an unknown or repeated key is
  `422` on `fields.N.key`, a repeated Name on `fields.N.name`, a second main input on `fields.N.isMainInput` (`fieldListProblems`); a
  label or flag that the row leaves out keeps the saved value, an empty label stores the Name (`plannedFieldRows`); on an IMEI service a list
  that leaves no field flagged flags the first field named IMEI in any letter case (`imeiNamedFieldIndex`), the import's rule; any other
  list is accepted for an IMEI service (decision 073: renamed, another type, optional, no main input, no fields at all). The field types
  are `text`, `number`, `select`, `textarea` and `imei` (`SERVICE_FIELD_TYPES`, check `service_fields_field_type_check`; decision 073: one
  IMEI, read as digits, 15 with a valid Luhn digit, on any service; placement judges it, `INVALID_IMEI`). The audit
  row names each field before and after by key, Name, label, type, pattern, `required` and the flag (`auditedField`; decision 073: turning
  an `imei` field into `text` removes the IMEI check, so it shows).
- **The default field of a new IMEI service** (decision 073): `POST /admin/services` of type `imei` writes, in the same transaction,
  `IMEI_DEFAULT_FIELD` (`domain/service-parts.ts`): key `imei`, Name and label `IMEI`, type `imei`, required, the main input, `sort` 0,
  no pattern, with its own audit row `replaced custom fields of service` (before: no fields) after `created service`. The supplier import
  gives a plain IMEI service the same field (decision 071); migration `0072_imei_field_type` made the stored ones of that shape of type
  `imei`. Staff change or remove it on the fields route like any other field. A Name that the
  database's `lower()` repeats but the code did not is answered `422` on `fields.N.name` as well (`laterRepeatedNameIndexes`). A field's `regex` follows the supported form of decision 051 (`src/common/field-pattern.ts`,
  `fieldPatternProblem`: literals, classes, the escapes `\d \w \s` and their capitals, groups that neither repeat nor nest, counts up to
  500, `^` and `$` at the ends, and a bound on the work of a 500-character value); a pattern outside it is refused at save with `422` on
  `fields.N.regex` and the reason's sentence (`FIELD_PATTERN_MESSAGES`). The order check runs only a pattern in that form
  (`compileFieldPattern`); the patterns stored before were reviewed once (`field_patterns_review`, see "Jobs and schedules").
- **Inventory** (`inventory-admin.service.ts`, `domain/inventory-codes.ts`): codes AES-GCM encrypted (`inventory_codes.code_enc`)
  with `code_hash` (`TokenService.lookupHash` of `inventory-code:<code>`, keyed with `LOOKUP_HASH_KEY`, decision 054) and `code_last4`; import counts imported, duplicates and
  rejected, never logs a clear code; void only `available` codes, idempotent. `InventoryStock` (`application/inventory-stock.ts`,
  public, in `CatalogModule`) hands codes to an order at placement: `claim` locks the oldest available codes of a service
  (`FOR UPDATE SKIP LOCKED`) and decrypts them as the order's result, `sell` marks them sold with the order id (RULES orders 10).
  **Decision 069:** only a service delivered from code stock (`services.stock_delivery`) takes codes: an import into another service is
  `422` on `codes` (`not_stock_service`), and `claim` answers no claim for it. The flag goes off only when no code is available (`PATCH`
  `stockDelivery: false` is `422` on `stockDelivery`, `codes_in_stock`, counted under the service row lock that an import takes too).
- **The own cost** (decision 069, `writeOwnCost` in `application/effective-cost.ts`): 0 to 1,000,000,000 (`MAX_OWN_COST`, the
  supplier price range of decision 051, so the floor and the shop price rules never overflow). `PATCH ownCost` (needs `pricing:update`) writes
  `services.cost` with a raised effective cost in one statement (the `cost_was` rule of `recomputeEffectiveCost`), then recomputes; the
  use case moves the price version after the commit (so the follow pass moves a following shop price, decision 040), signals the search
  index and audits `ownCost`/`stockDelivery` before and after. It is written before the floor check of a `basePrice` sent with it.
- **Supply** (decision 069, `domain/code-stock.ts`): `supplyStateOf` (read by `supplyStates`) counts one available code of a stock service
  as supply; a stock service with no usable supplier and no code is `out_of_stock`. The attention reason `no_supplier` uses the same rule
  (`suppliedFromStockSql`).
- **`recomputeEffectiveCost(tx, serviceIds)`** (`application/effective-cost.ts`): the one writer of `services.effective_cost`:
  `greatest(cost, credit x credit_rate)` of the first link an order can use (switched on, supplier `active`, service still listed),
  else the highest of the switched-on links, else 0. It first locks the service rows `FOR NO KEY UPDATE` in id order and then reads
  and writes from the locked rows (decision 069), so an own cost change racing a supplier sync is never worked out from a stale cost.

### Service options (read only since decision 072)

`PUT /admin/services/:id/options` (feature 4a) was retired with the console's Options section of a service (Models, Networks, MEP lists): nobody
saves these lists any more. The route is a row of the map, so it stays in the route manifest and is listed in `test/contract/retired.ts`; no
contract, controller method, use case, repository function, domain check or test serves it, and a call answers `404`. *Kept:* the table
`service_options` and its schema (the map is read only; production holds no rows; the demo seed still writes rows), the `options` array of
`GET /admin/services/:id` and `GET /client/services/:id` (`listOptionRows`), the model and network labels of the search index
(`findOptionLabels`) and every other read of the table, and the permission `catalog:update` (the other service writes use it). The outbox reason `options` of
`catalog.services_changed` is no longer written. No migration, no queue or cache key change.

### TAC catalog (read only since decision 068)

The four routes `GET /admin/tac-catalog`, `GET /admin/tac-catalog/:id`, `POST /admin/tac-catalog` and `PATCH /admin/tac-catalog/:id` (feature 14b) were
retired with the console's TAC tab: nobody edits the catalogue by hand any more. They are rows of the map, so they stay in the route manifest
and are listed in `test/contract/retired.ts`; no contract, controller, use case, repository function or test serves them. *Kept:* the table
`tac_catalog` with its seed rows (the demo's eight TACs, `scripts/seed/storefront.ts`), its foreign key from `imei_checks.tac`, and the read of a
held order's device name by the risk queue (`risk/infra/foreign-reads.repository.ts`, `tacEntries`). The permissions `catalog:*` stay (the services
use them) and the audit entity type `tac_entry` stays so old audit rows still read. The error code `TAC_TAKEN` left the catalog with the routes.
No migration, no queue or cache key change.

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
  prices.N.groupId` "Listed twice". A form that saves every group also sends `retailPriceSeen`, the retail price it loaded (`null`:
  none): a retail row left at that figure is not written and not held to the floor, so the price stored now stays and keeps following,
  also when a follow pass moved it or a publish set one after the form opened (feature 31).
- **Client prices** (`client-price-admin.service.ts`): one per account of a merchant rank and service (`409 PRICE_EXISTS`), above zero and at or above
  the floor of the account's group; `groupPrice` on each row is the resolver result for the account's group without the client
  price (catalog-16). **Fixed client prices exist for merchant ranks only** (decision 064): a create or a change for an account of the retail rank
  (a guest included) is `422` on `clientId` (code `retail_rank`), and so is `GET /admin/pricing/resolve`; the rows of an account that was lowered to the
  retail rank stay, can be deleted (`DELETE` is still allowed), and apply again after a raise. The shop always prices from the one retail rank.
  Audit like the demo: `set client price for` and `removed client price for` on the `account`.
- **Pricing rules** (`pricing-rule-admin.service.ts`, `domain/pricing-rule-input.ts`): CRUD with the target and group checked under
  share locks, amounts never negative, one of percent and fixed above zero, a discount or promo at most 100 %, a margin at most
  1000 %, a window that runs forwards; a rule being turned off is never refused for its target. Audit entity `pricing_rule`
  (`added`, `edited`, `removed pricing rule for`).
- **Bulk price** (`bulk-price-admin.service.ts`, `domain/bulk-price.ts`): preview saves nothing (a POST with `audit: false`); apply
  recomputes from the locked current prices, saves every new price (under the floor too, counted), clears `cost_was` and writes one
  `changed prices of` entry.
- **Merchant catalog** (`merchant-catalog.ts`, `client-catalog.service.ts`, `infra/merchant-catalog.repository.ts`): the live,
  `active` services in an active category open to the merchant's group, at the merchant's price; cost, floor and supplier names are
  never sent. `MerchantCatalog` (`page`, `find`, `all`) is the public piece the Dhru list (7a) reuses. Shapes: B159.
  **`GET /client/services?ids=`** (decision 066, B286): the shop shows a merchant its own prices on its normal pages and reads those of the
  services on a page in one call. `ids` is one comma-separated value of at most 100 service ids, each a positive whole number
  (`contracts/merchant-catalog.contracts.ts`; an empty value or piece, a bad piece, a repeated key or 101 ids is `422` on `ids`; a repeated id
  counts once). The answer is the list's rows, order and `x-total-count` for those of them the merchant may see: an id that is unknown,
  archived, off or hidden from its group is absent, as it is from the list. The page range still applies (default 25 rows: send `_end=100`
  with up to 100 ids). The rows answered are recorded as listed prices exactly as the list records them (`ClientCatalogService.list`), so
  price protection holds. `MerchantCatalog.page` and `pageVisibleServices` take the optional ids next to the visibility rule; the list without
  `ids`, the single read and the export are unchanged, and so are the money paths and the retail checkout's refusal of a merchant.
- **Merchant machine surface** (`merchant-api-catalog.ts`, feature 7a): the Dhru `imeiservicelist`, which the service binds to the
  `DhruGateway` at start. Visibility, prices and the quantity rules are the portal's (B159). The Dhru `LIST` is grouped by category (`GROUPNAME`, `GROUPTYPE` IMEI, SERVER or REMOTE; two categories with one name
  keep unique group keys by adding the type), `SERVICES` by service id with the keys of decision 026 (`SERVICEID`, `SERVICETYPE`,
  `SERVICENAME`, `CREDIT`, `INFO`, `TIME`, `QNT`, `QNTOPTIONS`, `MINQNT`, `MAXQNT`, the twelve `Requires.*` flags and `Requires.Custom`
  built from the service's fields: `fieldname` is the field's Name, `description` its label and `fieldtype` the Dhru type (`text`,
  `textarea` or `dropdown`; a `number` and an `imei` field are `text`: Dhru has no IMEI field type, decision 073); an IMEI service's
  main-input field is not repeated there, because the `IMEI` parameter carries it). The portal's `GET /client/services/:id` and the shop's service page list every
  field with `isMainInput` (decision 070: the order forms draw only the fields, and an IMEI service's IMEI is typed into the flagged one).
  File services are not in the Dhru list.
  Every list records the prices it showed (`ListedPrices.record`, user rule 9). Nothing is cached: a price list is never the truth for a
  charge (the order path prices again) and staleness would show an old price after a change.
- **Merchant switches** (feature 7a): `POST /admin/services` and `PATCH /admin/services/:id` accept the optional `allowCancel`,
  `allowVerify` (booleans) and `verifyWindowH` (integer 0 to 720, `0` = no window); the three start off, the reads return them, and
  the change is audited with the service's own verb phrases (`created service`, `edited service`, the switches in `before`/`after`).
  The console does not send them, so its writes keep the stored values.
- **Quantity rule** (feature 25, MISMATCHES B212): `POST /admin/services` and `PATCH /admin/services/:id` accept the optional
  `minQty` and `maxQty` (whole, 1 to `MAX_QUANTITY` = 100000) and `qtyOptions` (at most `MAX_QTY_OPTIONS` = 50 whole pack sizes
  from 1 to 100000, no repeats); the list, the show and both answers always send the three. A service sells a range or packs: the
  pure `resolveQuantityRule(current, change)` (`domain/quantity-rule.ts`) is the only writer besides the import. With packs it stores
  them ascending and sets `minQty` to the smallest and `maxQty` to the largest pack (so the default quantity, the stock test and
  Dhru's MINQNT and MAXQNT agree with placement), and a sent `minQty` or `maxQty` that disagrees is `422 packs_set`; without packs a
  `maxQty` under `minQty` is `422 below_min` on `maxQty` (`above_max` on `minQty` when only `minQty` was sent); every pack problem
  (`invalid_pack`, `duplicate_pack`) is on `qtyOptions`; all problems of a request come back together. `PATCH` writes the three
  columns only when it sends one of the keys; `qtyOptions: []` clears the packs and the service then sells `minQty..maxQty`
  (send both with it; left out, the stored ones, the former smallest and largest pack, stay). The audit rows carry the three
  values (`created service` in `after`, `edited service` before and after). The CHECK `services_qty_limits_check` bounds the values
  (`max_qty <= 100000`, at most 50 packs, each 1 to 100000); order, uniqueness and "min/max are the packs' bounds" are the domain
  rule's, and the readers stay defensive. No cache key: the catalog version already moves on every service write, and no view of the
  rule is cached. `ServiceImporter.create` takes the rule (`ImportedServiceInput.quantity`) and refuses, with a plain `Error`, one
  that `quantityRuleProblems` rejects (a programming error: the suppliers module normalises it first).
  Feature 26 (supplier quick add, B214): `ImportedServiceInput.status` (`active` when omitted, or `disabled`) sets the state the new
  service starts in, and `create` also returns `categoryCreated` (true when the group's category did not exist and was made for it),
  so the quick add can count the categories a run created. The picker's import passes neither and behaves as before.
  Feature 31 (category names, plan 31 section 3.5): `create` finds the category of a new service by the supplier's **raw group text
  first** (the lookup it always made, so a group whose category an earlier import made under the raw text keeps going there and no
  service is split between two categories), **then by the cleaned name** (`cleanGroupName` in `domain/category-name.ts`: entities
  decoded; control and invisible characters, direction marks, emoji, decoration and Arabic script runs removed; spaces collapsed;
  separators at either end dropped; nothing left gives `Imported`), and only then creates the category, under the cleaned name. The
  picker's import goes through the same lookup, and the adoption below keeps its exact-name lookup. `categoriesForGroups(db, [{ type, group }])`
  makes the same two lookups without writing (one read, Postgres's own `lower()`): the preview of a supplier import names with it the
  category each new service goes into, or the cleaned name the import makes one under (`id` `null`; decision 063). The categories that already exist
  get their clean names from `CategoryNameCleanup` (see "Jobs and schedules"), which leaves a name another category of the type holds.
  `decodeEntities` and the two character patterns live in `src/common/text.ts` (the storefront search re-exports `decodeEntities`).
  Feature 33 (decision 042): a field of `ImportedServiceInput.fields` carries its `regex` (the supplier's main box gets `^.{min,max}$`
  from its lengths, never the supplier's own pattern; the `Requires.Custom` fields `''`), which `create` stores. Decision 065: a field
  also carries its Name (`supplierKey`: the supplier's field name as the supplier spells it, the box's own name for the box, made unique
  in the service ignoring letter case by the suppliers module), the hidden key the suppliers module made from that Name, and
  `isMainInput` (set on the box, or on the IMEI field of a plain IMEI service: decision 071); `create` stores them as given.
  `ServiceImporter.adoptMainInput(tx, { serviceId, field, replaces })` is the supplier
  sync's adoption of an IMEI service made before the decision whose supplier's main box is not an IMEI: under the service's row lock it
  re-checks the service (live, `imei`, its main-input field the one `replaces` names, or none when `replaces` is omitted, the box's key and
  Name held by no other field ignoring letter case, so the unique indexes are never hit; else it answers `null` and writes nothing), moves it
  to type `server` and the `server` category of the same name (an existing one, found ignoring case, is reused as it is with its own
  switch and groups; only a category created for the move copies the old one's switch and groups; locked `FOR SHARE` as a staff edit locks it), puts the field first, flagged as the main input (the others keep their keys and their order behind it; decision 071: with `replaces` the main-input field the service has becomes the box in full, keeping only its id and key: Name, label, type `text`, no options, pattern and `required` are the box's, `makeFirstFieldRow`) and,
  like `PATCH /admin/services/:id`, writes `catalog.services_changed` (reason `service`). Price, cost, status, quantities, SLA, links
  and listing stay. The caller moves the catalog price version after the commit and writes the audit row (`adopted the supplier's
  input`). `ServiceImporter.requireFields(tx, { serviceId, keys })` (feature 33, second review round) is the sync's repair of the
  fields a supplier requires that the import made optional: under the service's row lock it sets only `required` on those of the keys
  that are optional (nothing else of a field changes, a field is never made optional) and answers the keys it changed; like a staff save
  of the fields (`PUT /admin/services/:id/fields`) it writes nothing for the shop or the search index; the caller writes the audit row.
  `ServiceImporter` now injects `CatalogSignals` (the supplier engine module provides both for the worker).
- **Price protection** (user rule 9, MISMATCHES B117): `ListedPrices.record(db, clientId, entries, at)` remembers the last price
  listed to a merchant (table `listed_prices`, written only when the price changes); the three portal routes call it, and so do
  7a's list (`imeiservicelist`; API key calls, no browser check). The portal's list and show reads carry
  `originCheck: 'fetch-metadata'` (decision 045): a request that the browser marks `cross-site` or `same-site`, without an `Origin`
  of the shop, is `403 CSRF_FAILED` and records nothing; the portal's own server calls, which carry neither header, are answered.
  The export carries `originCheck: true` (same-origin or an `Origin` of the shop): the browser downloads it. `checkPriceChange(listed, current, tolerance, { floorRaised? })` is the pure guard feature 5 calls at placement: above the
  tolerance `refuse` (`409 PRICE_CHANGED` with `listedPrice` and `currentPrice`), within it `raised` (charge it, record
  `raised = true` and the reason `floor` or `price_change` in `pricing_snapshot`), nothing on record `ok`. The tolerance is the
  setting `pricing.price_change_tolerance_percent` (platform settings registry, integer 0 to 100, default 10; read with
  `SettingsReader.integer(PRICE_CHANGE_TOLERANCE_KEY, DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT, PRICE_CHANGE_TOLERANCE_BOUNDS)`).
- **Price version** (`catalog-price-version.ts`, `catalog-prices.module.ts`): `CatalogPriceVersion.bumpAfterCommit(work)` moves the
  `catalog` version counter after the commit of every write that can change a resolved price (services, group prices, client
  prices, rules, a group's discount or delete, categories); feature 6 calls it when `recomputeEffectiveCost` reports a change.
  Cached price lists read through `CatalogPriceVersion.versioned(key)`. This feature caches nothing itself.

### The price grid and the stored order of services (decision 063)

- **Price grid** (`GET /admin/services/price-grid`, `application/service-price-grid.service.ts`, `domain/price-grid.ts`,
  `contracts/service-grid.contracts.ts`): one page of live services in the list dialect of `GET /admin/services` (filters `type`, `status`,
  `categoryId`, `q`; sorts `name`, `sort`, `id`; `x-total-count`), for the console's price page. A row has the effective `cost`
  (`null` while the cost is zero: no cost on record), `costChangedFrom`, the base price with `baseMargin`, the floor and `belowFloor`, the
  shop price with `retailPriceSource` (`rule` or `manual`, the words of the service rows) and `retailMargin`, and `groupPrices`: one entry per merchant group (`b2b`, in the order
  of the groups page) with the stored `fixedPrice`, the `price` and its `margin`. The group `price` is `PricingContext.resolve`, the function the
  merchant catalog and the order path call (never a second formula); a margin is price minus cost, signed, `null` without a cost. A page is
  one list query, one `PriceResolver.context` load, one supplier-chain read and one shop-price read: nothing per cell. It needs
  `catalog:read` and `pricing:read` (the second checked in the use case: `403` naming it). `PricingContext.merchantGroupsBySort()` and
  `groupFixedPrice()` are what it adds to the resolver's context.
- **Stored order** (`POST /admin/services/order`, `application/service-order.service.ts`, `catalog:update`): `services.sort` (migration 0063,
  default 0, `CHECK` 0 to 1000000) is the position of a service in its category. The body `{ items: [{ id, sort }] }` (1 to 500) is saved in
  one transaction (services locked in id order; a service listed twice, unknown or archived is `422` on `items.N.id`, all problems together,
  nothing saved), only the positions that differ are written, one `changed the order of` audit entry is written (also when nothing moved), and the
  catalog price version moves after the commit. The answer is `{ updated }`.
- **Who follows it**: the portal catalog (its `category` sort is category position, then the service position, then the caller's next key; the
  default order is category, name), the price export and the Dhru service list (`MerchantCatalog.all`: category position, `services.sort`, name).
  `_sort=sort` of the admin list and of the grid is the same order. One definition: `infra/service-order.sql.ts`.
  Inside a Dhru group `SERVICES` is an object keyed by service id, which a JSON reader sorts by key whatever the writer did.

### Retail price rules (feature 31, decision 040, B229)

- **The rules** (`retail_price_rules`; `domain/retail-rule.ts` pure, `application/retail-pricing.ts`, `infra/retail-price-rule.repository.ts`):
  the shop's price as `effective cost x (1 + percent / 100) + fixed`, never under the storefront floor, rounded up to the cent and,
  from `roundFrom` (default 5.00) on, to the style (`cent`, `step_0.05`, `step_0.10`, `ends_99`: always upwards, never the
  `applyRounding` trap of `ends_99` rounding 17.995 down). A cost of 0 gives no price (`no_cost`). One rule per target among the rules
  not deleted: a general one, one per service type, one per category; `pickRetailRule` takes the active rule of the category, else of
  the type, else the general one. `autoFollowPercent` (default 25) is the limit `costMoved(from, to, percent)` applies: `abs(to -
  from) x 100 > from x percent`, exact, no division. A delete is soft (`deleted_at`, `is_active = false`): every read filters
  `deleted_at IS NULL` except the label of a price's history (`ruleRowsOf`), the rule row is locked `FOR NO KEY UPDATE` so an edit or
  a delete never waits on the foreign key checks of the writers that point at it, and a category delete removes its rule by the
  cascade (the audit row names it: `removedRetailRuleId`). Routes `GET`/`POST /admin/retail-price-rules`, `PATCH`/`DELETE
  /admin/retail-price-rules/:id` and `POST /admin/retail-price-rules/preview` (`retail-price-rule-admin.service.ts`; `pricing:read`,
  `create`, `update`, `delete`; the preview is `pricing:read` and `audit: false`). Every write is audited (entity
  `retail_price_rule`: `created`, `changed`, `deleted retail price rule`, the fields before and after) and moves the catalog price
  version. The preview works out, for at most 2000 following services the change can reach (by id), the price the same evaluator
  gives under the changed rule set and counts the changes, rises, falls, floor prices and services left without a rule; it lists the
  100 largest changes and stores nothing.
- **Typed or following** (`retail_price_follows`): a row means a rule wrote the service's retail price last (`rule_id`,
  `applied_price`, `applied_cost`, `applied_at`); no row means a person typed it (or there is none). `RetailPrices.set(db, id,
  price, { origin, quote })` is the writer of every path but the group price page: it throws `RetailFloorError` for a price under
  the quote's floor (the callers' `422` answer first), upserts the price row, then deletes the follow row (`manual`) or upserts it
  (`rule`). The group price page's replace keeps its own floor check and calls `RetailPrices.afterGroupReplace`: a changed or removed
  retail row stops following, the same price keeps it. A new price of either origin closes a proposal that waits for it (`superseded`).
  `RetailPrices.sources(db, ids)` tells the listing rows whether a price is typed or following, by which rule, and whether a proposal
  waits (`waiting`).
- **`RetailPricing`** (global through `CatalogModule`): `targets(db, ids, at?)` (per live service: the quote, the type and category,
  the follow row, the active rule of now and its price), `facts`, `activeRules`, `anyActiveRule(db)`; the pure `priceWithRules`
  applies a rule set to the facts (the preview uses it with a changed set).
- **The follow pass** (`retail_price_changes`, B230; `domain/retail-follow.ts` pure, `application/retail-price-follow.ts`,
  `retail-follow-steps.ts`, `retail-follow-scheduler.ts`, `infra/retail-price-change.repository.ts`): the table of plan 31 section 3.4.
  `decideFollow` reads the stored price, the cost, the follow row and the rule of now, under the service row lock: no retail row or
  an archived service drops the follow row; a stored price that is not `applied_price` is `detached` (a typed price from now on); no
  rule leaves everything; the rule giving the stored price records the cost and the rule; a cost of 0 proposes `no_cost`; a cost that
  moved more than the rule's limit since `applied_cost` proposes `cost_jump`; a service that came under another rule while both rules
  stayed as they were (a sync adoption) proposes `rule_changed`; anything else is written at once, with the reason `cost_changed`,
  `rule_changed` or `floor_changed`. A sync adoption (`ServiceImporter.adoptMainInput`) sets the follow row's `applied_at` to its own
  moment, so a rule edited before the move counts as older than the price. A waiting proposal is rewritten only when what it shows
  differs and keeps `notified_at`. Nothing locks a rule row (the foreign key checks take `FOR KEY SHARE`, which a rule edit or delete
  never waits for). Every move and every
  proposal is a change row and an audit row (entity `service`, actor `system`: `changed`, `proposed`, `detached retail price of`).
  The hourly message (`retail.prices_followed`, at most once an hour, one notification per channel) goes to the ops recipients and its `link`
  is `<CONSOLE_BASE_URL>/catalog?view=settings&tab=shop-prices` (the Shop price rules tab of the Catalog settings; the console still
  redirects the older `/storefront?tab=pricing`, so a stored mail keeps working); a marking of nothing but closed proposals tells nobody
  and does not count for the hour.
- **The price changes routes** (`retail-price-changes.service.ts`, `controllers/retail-price-changes.controller.ts`; `pricing:read`,
  `pricing:update`): `GET /admin/retail-price-changes` (filters `kind`, `waiting`, `serviceId`; sorts `id`, newest first by default,
  and `createdAt`) and `POST /admin/retail-price-changes/resolve` (`{ ids, action, seen }`, one transaction per id): `apply` names in
  `seen` the `newPrice` the list showed for every id and writes the rule price of now only when that is still the proposal's figure
  and the rule still gives it, whatever the size of the move (the pass rewrites a waiting proposal, so the row alone cannot say what a
  person saw); `keep` takes no `seen` and deletes the follow row, so the price is typed, also for a service no rule can price; an id
  answers `skipped` with `not_waiting`, `no_rule`, `no_cost` (also a cost too large to price) or `changed` (the proposal shows the
  figure of now).

Known deviation (tech debt): `infra/foreign-reads.repository.ts` reads supplier links, `orders`, `service_listings`,
`listing_publish_items`, `checkout_sessions` and `help_articles` with plain selects, because those modules export
no service yet (the supplier chain of a service row, the archive-or-delete decision and the Catalog page's facts of decision 060;
the storefront imports the catalog, so the catalog cannot call it, decision 032); replace its bodies with their public services as
they appear (orders 5, suppliers 6, storefront 14a and 15, customers, risk 18). Nothing outside that file and the fragments it hands
to `infra/service-attention.sql.ts` knows.

## Public API (`index.ts`)

Exports `CatalogModule` (global) and `CatalogAdminModule` (the routes; a database-less test app leaves it out), the read-only
`ClientGroupDirectory` (`find(db, id, { lock: 'share' }?)` (the target rank row `FOR SHARE` while a rank change reads it), `findDefault`, `findRetail` (the storefront's `b2c_retail` group, feature 14a), `refsOf`; a `ClientGroupRef` has id,
name, kind, discountPercent, isDefault, overdraftAllowed, depositLimit (use `rankKindOf(ref.kind)` for the rank kind); identity uses it for the group a new
account joins and the group inside an account row), `recomputeEffectiveCost(tx, serviceIds)` (feature 6
calls it from sync, import and link changes), the figure rules (`defaultMinProfit`, `effectiveMinProfit`, `floorPrice`,
`marginPercent`, `isBelowFloor`, `deliveryTimeText`), the closed vocabularies `SERVICE_PRICE_MODES`, `SERVICE_DUPLICATE_RULES` and
`SERVICE_TYPES`, the inventory helpers the seed uses, and the storefront's read-only views (feature 14a): `StorefrontServices`
(`sellable(db, ids, groupId)`: the merchant catalog's visibility rule for the retail group, no cost or supplier; `priced(db, groupId, filter?)`: the
sellable ids that also have a fixed price for the group, optionally narrowed by service type, category and stock (feature 22:
`SellableFilter`, the SQL test `IN_STOCK_SQL`); `inStockIds(db, ids)`: which services are delivered from code stock and have enough
available inventory codes for their smallest order (`showsInStock` / `smallestOrder` / `coversSmallestOrder`,
`domain/storefront-availability.ts`; decision 069); `categoriesOf(db, ids)`: the categories of
some services with counts (a category has one name, English only since decision 039); `names(db, ids)`: name, type and delivery time whatever the service's state;
`fields(db, serviceId)`). Other modules import only `src/modules/catalog/index.ts` (lint rule
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
serviceId, price, { origin, quote })` (the one writer of the retail row of `service_group_prices` outside the group-price route; the caller moves the
price version after its commit). `PATCH /admin/service-listings/:id` uses it, so the listing page and the group-price page hold
the retail price to the same floor. Feature 31 (decision 040) adds the origin (`manual` or `rule`), the floor refusal
`RetailFloorError`, `afterGroupReplace`, `sources` (whose `RetailPriceSource` also carries the `price` since decision 060), and exports `RetailPricing`, `priceWithRules`, the pure `evaluateRetailRule`,
`pickRetailRule`, `ruleLabel`, `costMoved`, `DEFAULT_AUTO_FOLLOW_PERCENT` and the lists `RETAIL_RULE_SCOPES` and `RETAIL_ROUNDINGS`.
The follow pass adds `RetailPriceFollow` with `RetailPriceFollowModule` and its processor (worker only), `RetailFollowScheduler` (in
`CatalogPricesModule`), the job and scheduler names, and the lists `RETAIL_CHANGE_KINDS`, `RETAIL_CHANGE_REASONS` and
`RETAIL_CHANGE_RESOLUTIONS`.

Feature 41 (decision 051) adds the one-time review of the stored field patterns: `FieldPatternReview` (`run()` answers a
`FieldPatternReviewResult`, `{ checked, cleared }`) with `FieldPatternReviewModule` and its processor (worker only),
`FIELD_PATTERNS_REVIEW_EVENT`, `FIELD_PATTERNS_REVIEW_JOB` and `FIELD_PATTERN_CLEARED_AUDIT_ACTION`. The pattern checker itself is shared
code (`src/common/field-pattern.ts`), not a catalog export.

### Ranks as a seam (decision 064)

The abstract class `RankGroupReads` (`ports/rank-group-reads.ts`, the first line of the barrel) is how other modules ask what a rank is, without
reading `client_groups`: `kindOf(db, groupId)` (the stored kind, `b2b` or `b2c_retail`, or undefined), `retailGroupId(db)` (the one retail rank; a plain error when
none exists), `nameOf(db, groupId)` (the name the rank history snapshots) and `rankOrder(db)` (every rank id ordered by `sort`, then `id`).
`ClientGroupDirectory` implements it and the wiring binds the port to it (`useExisting`). Identity's `AccountDirectory`, the rank gate's `RankKinds` and
the account lists read ranks only through it. `rankKindOf(kind)` (identity) turns a stored kind into the wire word: `b2b` is `merchant`, anything else
`retail`. The portal catalog routes (`GET /client/services`, `GET /client/services/:id`, `GET /client/prices/export`) serve merchant ranks only (403
`RANK_NOT_ALLOWED` for any other rank, by the rank gate and again in `merchantFor`) and no longer list `ACCOUNT_PENDING_APPROVAL`.

## Owned tables

Only this module reads and writes these 10 tables, `listed_prices`, `retail_price_rules`, `retail_price_follows` and `retail_price_changes` (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`.

| Table | What it holds |
|---|---|
| `client_groups` | The ranks (merchant groups and the one retail rank) with their discount percentages and promotion limits; kind `b2b` is a merchant rank, kind `b2c_retail` marks the single retail rank used by the storefront and every guest (the kinds are closed, decision 064). |
| `service_categories` | Service categories; equal to GROUPNAME in Dhru. |
| `services` | Services; id equals SERVICEID. |
| `service_fields` | Custom fields of a service; equal to Requires.Custom. |
| `service_options` | Lists of models, providers and MEP values for a service (read only since decision 072). |
| `service_group_prices` | The price of a service per merchant group, including the storefront Retail price. |
| `service_client_prices` | A negotiated price of a service for one specific merchant. |
| `pricing_rules` | Margin and discount rules for automatic pricing. |
| `inventory_codes` | Stock of digital codes. |
| `tac_catalog` | The first 8 digits of an IMEI (TAC) with brand and model; used for automatic recognition and SEO pages. |
| `listed_prices` | The last price listed to a merchant for a service (price protection, user rule 9). A backend addition to the map's tables (B158), migration `0006_listed_prices.sql`. |
| `retail_price_rules` | The retail price rules (feature 31, decision 040): general, per service type, per category; soft-deleted. Migration `0041_retail_price_rules.sql`. |
| `retail_price_follows` | The services whose retail price a rule wrote last (feature 31, decision 040). Migration `0041_retail_price_rules.sql`. |
| `retail_price_changes` | What the follow pass did or proposes: `followed`, `proposed`, `detached` (feature 31, decision 040). Migration `0043_retail_price_changes.sql`. |

## Routes

41 endpoints (admin 37, client 3, dhru 1); the two `GET /v1/services` rows and `PUT /admin/services/:id/options` of the map are retired (see `test/contract/retired.ts`). Source: `docs/slices/catalog.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built: the 19 built routes of feature 4a are in `contracts/{client-groups,categories,services,inventory}.contracts.ts`, the 16 of feature 4b in `contracts/{pricing,client-prices,pricing-rules,merchant-catalog}.contracts.ts`, the rest are pending (`test/contract/pending.ts`).

Decision 063 adds two admin routes beyond the map (`scripts/map-additions/47.mjs`, `contracts/service-grid.contracts.ts`):
`GET /admin/services/price-grid` (`catalog:read` and `pricing:read`) and `POST /admin/services/order` (`catalog:update`).

Feature 31 adds seven admin routes beyond the map (`scripts/map-additions/31.mjs`). Spec B229, `contracts/retail-price-rules.contracts.ts`:
`GET /admin/retail-price-rules` (`pricing:read`), `POST /admin/retail-price-rules` (`pricing:create`, 201), `PATCH
/admin/retail-price-rules/:id` (`pricing:update`), `DELETE /admin/retail-price-rules/:id` (`pricing:delete`, 204) and `POST
/admin/retail-price-rules/preview` (`pricing:read`, `audit: false`). Spec B230, `contracts/retail-price-changes.contracts.ts`: `GET
/admin/retail-price-changes` (`pricing:read`) and `POST /admin/retail-price-changes/resolve` (`pricing:update`).

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
| `PATCH /admin/client-groups/:id` | staff-permission · `groups:*` | Merchant groups: discount, upgrade threshold and deposit limit. | 4 |
| `PATCH /admin/client-prices/:id` | staff-permission · `pricing:*` | A special price for a merchant on a service. | 4 |
| `PATCH /admin/pricing-rules/:id` | staff-permission · `pricing:*` | Margin and discount rules. | 4 |
| `PATCH /admin/service-categories/:id` | staff-permission · `catalog:*` | Service categories and the merchant groups that can see them. | 4 |
| `PATCH /admin/services/:id` | staff-permission · `catalog:*` | Services: type, execution, pricing mode and rules. | 4 |
| `POST /admin/client-groups` | staff-permission · `groups:*` | Merchant groups: discount, upgrade threshold and deposit limit. | 4 |
| `POST /admin/client-prices` | staff-permission · `pricing:*` | A special price for a merchant on a service. | 4 |
| `POST /admin/inventory-codes/void` | staff-permission · `inventory:write` | Void unsold codes. | 5 |
| `POST /admin/pricing-rules` | staff-permission · `pricing:*` | Margin and discount rules. | 4 |
| `POST /admin/service-categories` | staff-permission · `catalog:*` | Service categories and the merchant groups that can see them. | 4 |
| `POST /admin/services` | staff-permission · `catalog:*` | Services: type, execution, pricing mode and rules. | 4 |
| `POST /admin/services/:id/inventory/import` | staff-permission · `inventory:write` | Import codes with duplicate detection. | 5 |
| `POST /admin/services/bulk-price/apply` | staff-permission · `pricing:update` | Apply the bulk price change. | 4 |
| `POST /admin/services/bulk-price/preview` | staff-permission · `pricing:update` | Preview a bulk price change. | 4 |
| `PUT /admin/services/:id/fields` | staff-permission · `catalog:update` | Custom fields of the service. | 4 |
| `PUT /admin/services/:id/group-prices` | staff-permission · `pricing:update` | Service price for each merchant group. | 4 |

### Merchant portal (3)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/prices/export` | merchant-session | My price list as CSV. | 4 |
| `GET /client/services` | merchant-session | Catalog at my prices, grouped by category; `ids` reads named services (decision 066). | 4 |
| `GET /client/services/:id` | merchant-session | Field schema for the dynamic order form. | 4 |

### Dhru Fusion API (1)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DHRU imeiservicelist` | dhru-credentials | Services available to the merchant's client group, with the merchant's prices and order fields. | 7 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

- `success`: Order completed by the supplier (tables: `service_fields`, `services`)
- `reject`: Supplier rejects the order (tables: `service_fields`, `services`)
- `manual`: Manual fulfilment by staff (tables: `service_fields`, `services`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `service_fields`, `services`)
- `b2c-paid`: Paid storefront order (tables: `service_group_prices`, `tac_catalog`)

## Permissions

Staff permissions the map requires on this module's admin routes: `catalog:*`, `catalog:update`, `groups:*`, `inventory:read`, `inventory:write`, `pricing:*`, `pricing:read`, `pricing:update`. A `*` row means the action of the method: `groups:read|create|update|delete` (client groups), `catalog:read|create|update|delete` (categories, services), `pricing:read|create|update|delete` (client prices, pricing rules); fields and options need `catalog:update`; group prices and the bulk price change `pricing:update`; the resolver `pricing:read`; the inventory routes `inventory:read` and `inventory:write`. Audit entity types written: `client_group`, `category`, `service` (also the group prices and the bulk change), `account` (client prices; the entity word of every account since decision 064), `pricing_rule`, `retail_price_rule` (feature 31) and `inventory_code` (a void; the import is audited on the `service`). The retail price
rules (feature 31, routes beyond the map) use `pricing:read` (list, preview), `pricing:create`, `pricing:update` and `pricing:delete`. A `basePrice` or `minProfit` change on `PATCH /admin/services/:id` also needs `pricing:update` (decision 046). `GET /admin/services/price-grid` (decision 063) needs `catalog:read` and also `pricing:read`; `POST /admin/services/order` needs `catalog:update` and writes the audit entry `changed the order of` (entity `service`).

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced: `service.price_changed` (queue `notifications`, aggregate `services`, payload `{ clientId, serviceId, previousPrice, price, currency }`), written by
`PriceChangeScan` (feature 7b, user rule 9 (5)): see "Jobs and schedules". Consumed by the merchant's daily digest (feature 12a). The route is registered by the platform module (`NotificationRoutes`).

Feature 29 (storefront search, decision 038): `CatalogSignals` (`application/catalog-signals.ts`) writes `catalog.services_changed`
(`{ serviceIds, reason }`, 1-50 ids per event, aggregate `services`; reason `service`, `price` or `stock`) and
`catalog.category_changed` (`{ categoryId }`, aggregate `service_categories`) in the writer's own transaction: service create, edit,
archive and delete, every group price set, an inventory import and void, the stock claim of an order placement,
a category edit and delete, (one per category) a merchant group delete that removed the group from categories, and the supplier
sync's adoption of a main box (feature 33: a type and category change, like a staff edit). Supplier imports (Quick add) write none:
imported services have no listing. The routes (queue `search-index`, job `search_sync`) are
registered by the storefront's search module. `StorefrontServices` gained `pricedPage`, `pricedAmong`, `serviceIdsOfCategory` and
`optionLabels` for the index.

## Jobs and schedules

`service_price_scan` (queue `maintenance`, processor `jobs/price-change-scan.processor.ts`, module `PriceChangeScanModule` in the worker; feature 7b): every move of the
catalog price version tells its listeners (`PriceVersionListeners`), and `PriceChangeScan` adds a delayed job (60 s, job id `price-scan-<minute>`, so at most one a minute).
The scan compares, for every active account of a merchant rank and service of the last 30 days of orders (read through the foreign reads of `infra/foreign-reads.repository.ts`, which read `orders.account_id` and **the merchant doors only, never a shop order**), the price a
new order would pay now (`PriceResolver`, floor included) with the unit price of the merchant's latest order, and writes `service.price_changed` for each difference
that has no event with the same ids yet (`OutboxService.hasEvent`; the digest is idempotent on the same event as well). Event-driven, so no `job_runs` row.
A merchant who has not ordered the service in 30 days is not told; a price that goes back to the last order's price is not announced.

`category_names_clean` (queue `maintenance`, processor `jobs/category-name-cleanup.processor.ts`, module `CategoryNameCleanupModule` in the worker; feature 31): runs once,
asked for by migration `0046_clean_category_names` through the outbox event `catalog.category_names_clean` (only the worker registers its route). `CategoryNameCleanup` walks
every category and gives it the name `cleanGroupName` makes of it, each rename in its own transaction under the category row lock, with the `catalog.category_changed` event, the
catalog price version and an `edited category` audit row by `system`. A name another category of the type already has (ignoring case) is left alone: staff merge such a pair by hand.
Idempotent: a repeat finds the names clean. Not recorded in `job_runs`.

`field_patterns_review` (queue `maintenance`, processor `jobs/field-pattern-review.processor.ts`, module `FieldPatternReviewModule` in the worker; feature 41, decision 051):
runs once, asked for by migration `0048_supplier_safety` through the outbox event `catalog.field_patterns_review` (only the worker registers its route). `FieldPatternReview`
walks every field with a pattern by id (archived services included), 500 a page, and clears each pattern outside the supported form with a guarded update (`where id = $1 and
regex = $2`, so a pattern a staff save changed meanwhile is left as saved), in one transaction per field with an audit row by `system` (`cleared an unsupported field pattern of`,
entity `service`, `before: { field, regex }`, `after: { field, regex: '' }`) and one warning line after the commit. No catalog price version move and no search signal (a staff
save of the fields does neither). Idempotent: a cleared pattern is not read again. Not recorded in `job_runs`.

`retail_price_follow` (queue `maintenance`, processor `jobs/retail-price-follow.processor.ts`, module `RetailPriceFollowModule` in the worker; feature 31, decision 040): every
move of the catalog price version asks for a pass (`RetailFollowScheduler` in the global `CatalogPricesModule`, so the API asks too: a delayed job of 60 s, id
`retail-follow-<minute>`), and the scheduler `retail_price_follow_hourly` runs one every hour at minute 10. The delayed job is unrecorded; the hourly and the manual run write
`job_runs`. See "The follow pass" above and `docs/queues.md`.

Otherwise none in this module. Ranks (client groups) are set by hand: no job moves a merchant between groups.

## Data migration

`drizzle/0005_default_client_groups.sql` makes sure a default merchant group and the storefront retail group exist (a fresh
database had none, so `POST /admin/clients` answered 500). It marks the first merchant group as the
default when groups exist without one, inserts `Standard` (default, no discount, threshold 0, no deposit limit, no overdraft) when
there is no merchant group, and inserts `Storefront retail` when there is no `b2c_retail` group. The seed's demo groups reuse or
replace these rows (`scripts/seed/identity.ts`).

`drizzle/0066_accounts_expand.sql` (decision 064) runs the retail half of `0005` again before it copies the customers (it inserts `Storefront retail` when no
`b2c_retail` rank exists: every copied customer and every guest takes the retail rank), refuses a kind outside `b2b` and `b2c_retail` (a preflight stop, and the
new `client_groups_kind_check`) and a retail rank that allows overdraft (`client_groups_retail_no_credit_check`).

`drizzle/0063_service_sort.sql` adds `services.sort` (decision 063): integer, default 0, `CHECK` from 0 to 1000000. Every service starts at 0, which keeps the
name order the merchant lists had; nothing is backfilled.

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
- `catalog-11` · PUT /admin/services/:id/options (retired, decision 072), PUT /admin/services/:id/group-prices
- `catalog-12` · PUT /admin/services/:id/group-prices
- `catalog-13` · PATCH /admin/services/:id
- `catalog-14` · PATCH /admin/services/:id
- `catalog-15` · GET /admin/inventory-codes, POST /admin/services/:id/inventory/import
- `catalog-16` · GET /admin/client-prices
- `catalog-17` · POST /admin/client-groups, PATCH /admin/client-groups/:id
- `identity-platform-3` · POST /admin/clients
- `orders-suppliers-10` · POST /admin/suppliers/:id/import
