# 060: The reads of the Catalog page

Status: accepted, 2026-11-23; the always-sent fields became required in the same week (see "Amendment: what became required"). Builds on
decisions 016, 032, 035, 040 and 046.

**Context.** The console is moving services, shop prices, shop pages and publish runs onto one Catalog page: one table of services
with views ("needs attention", "not on the shop", "switched off"), a side panel per service and one flow that adds services from a
supplier. The service rows did not say whether a service is on the shop, at what shop price, why it cannot go there or why it needs
staff, the list could not filter on those facts or on a supplier, no route read the supplier chain of one service, and an import did
not say which services it created. All of it is additive: no table, migration, job, queue, cache key or outbox event.

**Decision: the row.** The answers of `GET /admin/services`, `GET /admin/services/:id`, `POST /admin/services` and
`PATCH /admin/services/:id` (one view) gain:
- `attention`: the reasons that hold, in a fixed order: `no_supplier` (an automatic service with no active supplier link),
  `below_floor` (`belowFloorSql` at the clock's now, the dashboard's figure), `price_proposal` (a proposed shop price waits for
  staff, decision 040) and `publish_failed` (below). Only an enabled service has reasons.
- `retailPrice` (the retail group's price) and `retailPriceSource` (`rule`, `manual` or `null`), for every reader.
- `retailPriceRule` and `retailPriceWaiting`, as the listing rows name them, for a reader with `pricing:read`.
- `listingId`, `isListed` and `shopBlocked` for a reader with `storefront:read`; the detail also has `publishFailure`
  (`{ runId, reason, detail, at }` or `null`).

**Decision: who reads what.** One function, `serviceReadAccess` (catalog `application/service-read-access.ts`), decides for the four
routes and for the list's filters. The shop price is not hidden: every `catalog:read` reader already reads it in the detail's group
prices, and hiding that row would make the group price page's replace-all delete it. The shop page facts follow the listing routes
(`storefront:read`); the rule behind a price and a waiting proposal follow the retail price routes (`pricing:read`). A key the
reader may not read is left out, never sent as `null` or `false`, and a reason it may not read is neither in `attention` nor in the
`needsAttention` filter. So the permission keys stay optional in the contract for good; `attention`, `retailPrice` and
`retailPriceSource` are always sent and are required since the amendment below.

**Decision: one SQL per fact.** Each reason, the shop block, "not on the shop" and the shop price is one expression over
`"services"` in catalog `infra/service-attention.sql.ts`; the filters, the count (`x-total-count`) and the row flags use the same
expressions, so a view's count equals its rows. The parts over other modules' tables (`service_supplier_links`, `supplier_services`,
`service_listings`, `listing_publish_items`) are built in `infra/foreign-reads.repository.ts` under its deviation of decision 016:
the storefront imports the catalog, so the catalog cannot call it (decision 032). Every condition is NULL-free and in parentheses,
because a boolean filter compiles to `(expression) = false`, and names `"services"."id"` in full. The flags of a page are one select
of their own, not part of the page query, which the bulk price change also uses.

**Decision: a failed publish.** `publish_failed` holds when the service's latest publish row that has a result (by `finished_at`
(`updated_at` when unset), then the row id) was `refused` and the service has no listing at all. Not "is not listed": a publish run
blocks any service that has a listing (`already_listed`), so after a listing made by hand and later switched off no run could
ever clear the reason. A later `published` or `skipped` row, a listing, or switching the service off clears it; there is no
dismissal. `publishFailure` names the run, the result reason and its words while the reason holds; the detail shows it only when
the attempt it reads is itself `refused` (the flag and the attempt are two reads).

**Decision: the shop block.** `shopBlocked` is a closed list in the order of the storefront's publish rule: `service_disabled`,
`category_inactive`, `b2b_only` (the category's group list leaves the retail group out), `not_orderable` (a file service), or
`null`. The checks a publish run makes on its own draft (supplier, title, price, address) are not repeated. A test reads the
storefront's own facts and `evaluateItem` for every combination and compares.

**Decision: the list.** New filters, all `eq`: `needsAttention` (the union of the reasons the caller may read), `hasSupplier` (an
active link), `supplierId` (the primary supplier: the first active link by priority, then link id, the row's `supplier`; a fallback
is not matched), `isListed`, and `notOnShop` (enabled, not listed, `shopBlocked` null). `isListed` and `notOnShop` need
`storefront:read`: without it the request is refused `403` before any query, because an ignored filter would make a count disagree
with its rows and an applied one would let a reader probe what it may not read. A new sort, `retailPrice`, puts services without a
shop price last in both directions.

**Decision: the supplier chain of one service.** `GET /admin/services/:id/supplier-links` (suppliers module, `catalog:read`, a
route beyond the map: `scripts/map-additions/46.mjs`, spec `B-TBD service-supplier-chain` until it is numbered) answers the same
array as the `PUT`, every link in priority order (switched-off links too), `[]` without a link, `404` for an unknown or archived
service. The supplier detail cannot serve the panel: it lists only the services one supplier serves.

**Decision: the import answer.** `POST /admin/suppliers/:id/import` adds `createdServiceIds`: the services the call created (not the
updated or unchanged ones), in creation order, at most 500 (one per picked item), so the console can start one publish run per
call (a run takes at most 500 services). It is always sent (`[]` when the call created nothing) and is required since the amendment below.

**Consequences.**
- A page of the list costs a fixed number of extra queries (one select of flags, the shop price sources, the listings for a shop
  reader); the four view counts of the page are four list calls with a page of one row.
- The contract documents were first generated against the console as it was: the new fields were optional and the console did not
  call the new route yet. The amendment below is the later change, generated against the console that reads them.
- The SQL repeats the storefront's publish rule and its lock rule; the comparison test is what keeps them equal.

## Amendment: what became required

**What became required.** In the contract of the four row routes (`ServiceRow`, so the list, the detail, `POST` and `PATCH`):
`attention`, `retailPrice` (money or `null`) and `retailPriceSource` (`rule`, `manual` or `null`). In the answer of
`POST /admin/suppliers/:id/import`: `createdServiceIds` (an array, `[]` when the call created nothing). Every path already sent them:
`toView` in `service-admin.service.ts` writes the three row keys for every row of every route (a service without a supplier, a price
or a shop page gets `attention`, `null` and `null`, never a missing key), and `SupplierCatalogueService.import` has one return, after the
last write; a refused import throws before it answers. The tests read the whole row of the four routes for four kinds of reader and, for
a reader with the catalog permissions alone, that the three keys are there and the permission keys are not.

**What stays optional for good.** `retailPriceRule` and `retailPriceWaiting` (`pricing:read`), `listingId`, `isListed`,
`shopBlocked` and the detail's `publishFailure` (`storefront:read`): a reader without the permission does not get the key, so a
required key would make the answer a contract violation for that reader. Their descriptions say when they are left out.

**The address in the mail.** The hourly message about shop prices that follow a rule (`retail.prices_followed`) links to
`<CONSOLE_BASE_URL>/catalog?view=settings&tab=shop-prices`, and the sample of its `link` shows the same address. The backend builds no
other address of the old Services or Storefront pages: the only other console address it builds is `/set-password` (staff invitation
and reset), which did not move. The console still redirects the older addresses, so a message sent before this change keeps working.
The words of the shipped template ("Review them on the Retail pricing tab") are left as they are: a template row exists once
inserted and is edited by staff, and a new row would need a migration for a label only; the tab is called "Shop price rules" now.

**The generated documents** (`frontend-endpoints.json`, the fixtures, the route manifest and slices, `COVERAGE.md`, the contract
documents and the OpenAPI files) were regenerated against the console that reads these fields. The console now calls
`GET /admin/services/:id/supplier-links` (341 routes, one more), and it declares the new row keys as optional on its side, which a
required key on the producer's side satisfies. The fixture harvest needed one change of its own: the mock layer of the console's services
now reaches a ring of imports (orders, suppliers, storefront) through the orders barrel, where a label list is read before it is
defined, so the harvest loads the storefront module first, the way the console itself does.
