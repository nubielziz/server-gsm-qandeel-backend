# 063: A price grid, a stored order of services and the options of the supplier import

Status: accepted, 2026-11-23. Builds on decisions 011, 035, 040, 042, 046 and 060. Spec entries B240 (the price grid), B241 (the stored
order) and B242 (the import options); console mismatches M308, M309, M311 and M313. Decisions 061 and 062 are numbers of work that lands
later; they are not missing here.

**Context.** The console is getting a service page that prices many services in one table: the cost, the base price, the shop price and
one price per merchant group, each with what it leaves over the cost, and a way to put the services of a category in the order merchants
see them. The backend could not serve either. The group prices of a service were readable only one service at a time (`GET /admin/services/:id`),
a group with no fixed price had no figure on the wire at all (it pays the base price less its pricing rule and its discount, worked out by
the price resolver), and a service had no position: the merchant catalog, the price list and the Dhru service list could only show services by
name inside a category. The form that adds services from a supplier also wants two choices the import never took: add the new services
switched off, and put them in a category staff pick. All three changes are additive: one column, two routes, two optional keys.

**Decision: the price grid.** `GET /admin/services/price-grid` (`catalog:read`, and `pricing:read` checked in the use case, the way
decision 046 asks a second permission: `403` naming `pricing:read`, before anything is read) answers one page of live services in the
list dialect of `GET /admin/services` (filters `type`, `status`, `categoryId`, `q`; sorts `name`, `sort`, `id`; the total in
`x-total-count`). A row has the facts of the service row (`id`, `name`, `code`, `status`, `sort`, `categoryId`, the primary
`supplier`), the effective `cost`, `costChangedFrom`, `basePrice` with `baseMargin`, `floorPrice` and `belowFloor` (the list's own SQL), the
shop price `retailPrice` with `retailPriceSource` and `retailMargin`, and `groupPrices`: one entry per merchant group (kind `b2b`) in
the order of the groups page (`sort`, then id) with the stored `fixedPrice` (or `null`), the `price` and its `margin`.
- **One resolver.** `price` is `PricingContext.resolve({ serviceId, groupId })`, the function the merchant catalog, the price export and the
  order path call: the fixed price, or the base price after the pricing rule, the group discount and rounding, never under the floor. The grid
  holds no formula of its own; `domain/price-grid.ts` only arranges what the resolver and the list return. A test reads the same prices from
  the merchants' own catalogs and compares.
- **A fixed number of queries.** One list query for the page, one load of the pricing data for its services (`PriceResolver.context`: the
  services, all groups, the group prices of the page and the active rules), one read of the supplier chains and one of the shop prices; the cells
  are resolved in memory. Nothing is read per cell.
- **Margins.** A margin is the price minus the effective cost, signed (a price under the cost has a negative margin). While no cost is on
  record (the effective cost is zero: a new service starts there until a supplier is linked or imported; the resolver's trace calls it "No
  cost on record") `cost` and every margin are `null`: a margin over a zero cost would be the whole price. `costChangedFrom` follows `cost`.
- **The shop price source.** `retailPriceSource` is `rule` or `manual`: the words the service rows (decision 060) and the retail
  pricing use for the same fact, one word for one fact on every wire. The design wrote `typed`; the console's grid reads the wire's word
  (console M309) and may still print "typed" to staff.
- **Who reads it.** The grid shows what a merchant pays and what it costs, so it needs `pricing:read` besides `catalog:read`. It writes
  nothing and records no audit entry.

**Decision: the stored order.** `services.sort` (integer, default 0, `CHECK` from 0 to 1000000, migration 0063) is the position staff give a
service among the services of its category. Every row of the service routes carries it (always sent; optional in the contract until the console's `Service`
type and its mock rows carry it, since a required key would fail the harvested fixtures; the Pricing view reads the position from the grid), and `GET /admin/services` and the grid sort by it: `_sort=sort` means **category position, then `sort`,
then name**, all in the direction asked for, which is the order merchants see, so a list of several categories reads the way the catalog does.
- **`POST /admin/services/order`** (`catalog:update`) takes `{ items: [{ id, sort }] }`, 1 to 500 items, `sort` a whole number from 0 to 1000000, and
  answers `{ updated }`, the number of services whose position changed. One transaction: the services are locked in id order, every problem is
  judged first (a service listed twice, unknown or archived is `422` on `items.N.id`, all together), then the positions that differ are
  written in one statement, one audit entry (`changed the order of`, entity `service`, the old and new positions of the first 200 changed
  services by code and the counts) is written also when nothing moved, and the catalog price version moves after the commit when something did, so
  cached price lists start over. Two saves of the same services run one after the other, never mixed.
- **The lists that follow it**, each by category position, then `services.sort`, then name: the portal catalog (`GET /client/services`: its
  `category` sort stands for the category position and then the service position, so the default order and `_sort=category` read it; a sort
  by `name`, `type` or `id` is the caller's own and ignores positions), the price list (`GET /client/prices/export`) and the Dhru service
  list (it reads the same list, so its groups come in category position and its services are built in the new order).
- **Services nobody numbered** are at 0 and so come first, by name, ahead of the numbered ones; a category in which no service was ever numbered
  reads exactly as before. A new service starts at 0.
- **What does not follow it.** `GET /v1/services` pages by cursor in id order (decision 026, ALIGNMENT § 7): a position that moved a service
  across a page boundary would repeat or skip it, so that list stays in id order. The storefront has its own listing order
  (`service_listings.sort`). In the Dhru answer, `SERVICES` of a group is a JSON object keyed by service id; a JSON object whose keys are
  whole numbers is read in ascending key order by every JavaScript reader, so the position of a service inside a group cannot be carried by the
  answer's text until that object is written as ordered text; the groups, whose keys are names, do follow the category position.

**Decision: the options of the supplier import.** `POST /admin/suppliers/:id/import` and `POST /admin/suppliers/:id/import/preview`
take two optional body keys. `status` is `active` (the default) or `disabled`. `categoryId` is a category whose type is the type each
new service becomes; omitted, the category named after the supplier's group, as before. Without either key the routes answer and write
exactly what they did: the same body, the same items (no new field), the same audit row.
- **A disabled service is born disabled.** The state goes to `ServiceImporter.create`, which inserts the row in it, inside the import's
  one transaction. No service is ever inserted `active` and switched off afterwards, so none is orderable, not even for an instant, and no
  second write or event is needed. An updated or unchanged item is not touched by `status` or `categoryId`: they are about the services
  this call creates.
- **The category.** A category holds one service type (`service_categories.type`, the composite key of `services`). The check is on the
  type a new service *becomes* (`importShape`: an IMEI service whose main box is not an IMEI is a `server` service, decision 042), and
  only on the items the import would create. A category of another type, or one that does not exist, is `422` with the standard problem
  body: `errors[0]` is `{ field: 'categoryId', code: 'kind_mismatch' | 'unknown', message }`, and the `kind_mismatch` message names the
  category, its type and the supplier services that do not fit (ten at most, then "and N more"). Nothing is imported then. The preview
  answers the same `422` for the same request, so the form can show it before the import. The category row is read under a share lock
  inside the import, so a rename or a type change of it waits for the import.
- **How the importer puts services in the picked category.** The catalog's importer finds a category by the supplier's group text first,
  by (type, name) ignoring case, and `service_categories_name_uq` makes that pair unique. The suppliers module therefore gives the picked
  category's name as the group text; the importer finds exactly that category and makes none. One read after the loop proves that every
  created service has the picked category's id, else the transaction rolls back.
- **The preview names the category exactly.** With `status` or `categoryId` each item also carries `status` (what a `new` item would be
  created as) and `category` (`{ id, name }`). `category` is the picked one; without a pick it is what the catalog's
  `ServiceImporter.categoriesForGroups` answers (exported through the catalog's public index with its types `GroupOfService` and
  `GroupCategory`): the same two lookups as the importer's `create` (the group text, `Imported` when empty, then the cleaned name of
  `cleanGroupName`, by type and name ignoring case, compared by Postgres's own `lower()`), made in one read and without writing. A hit is
  named with its id and its own name; no hit is the cleaned name the import makes a category under, with `id` `null`. Both keys are
  `null` for an item the import would not create (matching, changed, a type it refuses). Without either key the items have neither field.
- **The audit row** `imported services from` gains `serviceStatus` (when `status` was sent) and `categoryId` and `categoryName` (when
  `categoryId` was sent).

**Consequences.**
- One migration (`0063_service_sort`): a column with a default and a `CHECK`; no data to move, nothing to backfill.
- Two routes beyond the map (`scripts/map-additions/47.mjs`, decision 035; specs B240 and B241). No job, queue, cache key or outbox event:
  the order is read from the table at every request, as the lists already were, and the version bump covers a cache that would hold
  them. The import options add no route, table, migration, queue, job, cache key or outbox event; the request schemas gain two optional
  keys and the preview's items two optional fields (B242).
- `PricingContext` gains `merchantGroupsBySort()` and `groupFixedPrice()`; `PricedGroupRow` gains `sort`. `merchantGroups()` keeps its id order
  (the resolve page's `otherGroups` reads it). `ServiceImporter` gains `categoriesForGroups()` and the category name domain
  `groupLookupName()`; the suppliers module reads no category by name of its own any more.
- The service rows' `allowCancel`, `allowVerify` and `verifyWindowH` (feature 7a, always sent) are required in the contract, now that the
  console reads them (console M302).
- The generated documents (route manifest and slices, coverage, contract documents, OpenAPI and the harvested fixtures) are rebuilt on the
  branch against the console branch that reads the two routes (`FRONTEND_DIR`); `docs/contract/frontend-endpoints.json` records that
  folder, so the lead re-runs `contract:extract` once the console is on its main checkout. The console now reads the grid's `manual`
  (console M309) and a `null` preview `category.id` (console M313), so the three contract-test allowlist entries that covered it (B240
  twice, B242 once) are removed and no allowlist entry cites this decision.
- Tests: `test/unit/modules/catalog/domain/price-grid.spec.ts`, `test/unit/modules/catalog/domain/category-name.spec.ts`
  (`groupLookupName`), `test/unit/modules/suppliers/contracts/suppliers.contracts.spec.ts`, the `categoryMisfits` and
  `categoryMismatchMessage` cases of `test/unit/modules/suppliers/domain/import-plan.spec.ts`, `test/contract/service-sort.test.ts`,
  `test/contract/catalog-row-keys.test.ts`, and the integration files `test/integration/catalog/catalog-price-grid.test.ts`,
  `catalog-service-order.test.ts` and `test/integration/suppliers/supplier-import-options.test.ts`.

**Open.** (1) `ServiceRow.sort` becomes required once the console's `Service` type and its mock rows carry it (console M311); on
2026-11-24 they still did not (the console reads the position from the grid row only), so the harvested service rows have no `sort`. (2) A
`categoryId` on `ImportedServiceInput` would replace the name hand-off of the picked category. (3) The quick add takes neither key; if the
form wants the same choices there, its body grows the same way. (4) Console proposals this decision does not take: an `id` filter on the
grid (M321) and the service's own cost and the supplier's cost apart (M308).
