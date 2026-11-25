# 069: Services sold as codes, and a service's own cost

Status: accepted, 2026-11-25. Builds on decisions 025 (the order state machine and stock delivery at placement), 040 (retail price rules and
the follow pass), 046 (pricing decisions need `pricing:update`), 060 (the Catalog page's facts of a row) and 063 (the stored order of services).
Spec entry B287.

**Context.** Until now every service could hold codes (`inventory_codes`), and every order of every service first tried to take codes from
the stock (`InventoryStock.claim` at placement, RULES orders 10). Codes imported by mistake into an IMEI unlock service would have been
delivered in place of the unlock. The owner sells gift-card codes (iTunes and the like) that they own, with no supplier, and two more gaps
hit them: the shop refused such a service when its order handling is automatic, because no supplier is linked (the codes did not count as
supply: the publish rule's `supplier_unavailable`), and the shop price rules (cost x (1 + percent) + fixed) cannot price a service whose
cost is 0, while staff had no way to set a service's own cost (`services.cost`, which the effective cost already reads).

**Decision.**
- **"Delivered from code stock".** A service has the flag `services.stock_delivery` (`stockDelivery` on the admin wire, default off). Only
  such a service takes codes: an import into any other service is `422 VALIDATION_FAILED` on `codes` with the code `not_stock_service`
  ("Turn on Delivered from code stock for this service first."), and nothing is stored. Only its orders take codes at placement, in every
  placement path (portal, REST v1, Dhru single and bulk, the shop): `InventoryStock.claim` reads the flag in the placement transaction and
  answers "no claim" for any other service. A short stock changes nothing from before: the order goes the usual way (a supplier when one is
  linked, else it waits for staff in `needs_attention` or the manual queue).
- **Turning it off.** `PATCH /admin/services/:id` with `stockDelivery: false` while the service holds available codes is `422` on
  `stockDelivery` with the code `codes_in_stock` ("Void the N codes in stock first."; "Void the 1 code in stock first." for one). The codes are
  counted under the service row lock (`FOR UPDATE`); an import reads the flag under its `FOR SHARE` lock of the same row, so a flag that goes
  off and an import that adds codes cannot cross. Sold, reserved and void codes stay as history and do not block.
- **The row.** Every admin service row (list, show, create and change answers) carries `stockDelivery`, `stockAvailable` (how many of its codes
  are `available` now, counted in SQL; 0 without codes) and `ownCost` (`services.cost`, a 4-decimal money string). `cost` stays the
  effective cost: the larger of `ownCost` and the cost of the first usable supplier link (`recomputeEffectiveCost`). The three keys are
  always sent and required in the contract (the console carries them). `GET /admin/services` takes the filter `stockDelivery=true|false`
  (an equality filter like `hasSupplier`): the console's Inventory menu lists the services delivered from code stock.
- **The own cost.** `POST /admin/services` and `PATCH /admin/services/:id` take `ownCost` (0 to 1,000,000,000, the range of a supplier's price
  in decision 051, so the floor and the shop's price rules worked out from it never overflow `numeric(18,4)`: a larger value is `422` on
  `ownCost`; create default `0`). A create starts the effective cost at it, so a new service never shows "cost changed"; with `ownCost`
  sent, a create judges its `basePrice` against the floor that cost sets and refuses one under it exactly as a change does (`422` on
  `basePrice`, `below_floor`); without it the new service costs 0 and its base price is not judged, as before. A change goes through `writeOwnCost`: the cost and a raised effective
  cost are written together (the CHECK "effective cost not under the cost" holds after every statement; `cost_was` keeps the first previous
  effective cost when it rises, the rule of `recomputeEffectiveCost`), then the effective cost is worked out from the links again (it falls
  back to the supplier's cost when the own cost falls under it). It has every consequence of a supplier cost change: `costChangedFrom`, the
  floor of every price (the resolver reads the effective cost), the catalog price version moved after the commit (cached price lists, the
  price change scan of merchants' digests and the follow pass, which moves a following shop price or opens a proposal, decision 040), the
  search signal of the change and an `edited service` audit row whose snapshot holds `ownCost` and `stockDelivery` before and after. It is
  written before the floor check, so a `basePrice` sent with it is judged against the new floor, and a base price saved with it clears the
  "cost changed" mark (RESOLUTIONS catalog-14). Like the base price and the minimum profit, `ownCost` on a change needs `pricing:update`
  (`403 FORBIDDEN`, decision 046): it sets the floor. A cost change never refuses by itself: a base price left under the new floor reads
  `belowFloor`, and the resolver never sells under the floor.
- **An own cost racing a supplier sync.** `recomputeEffectiveCost` locks the service rows `FOR NO KEY UPDATE` in id order (the lock its
  update takes anyway, so a foreign key check of a new order or code never waits for it) before it reads anything, and works the figures
  out from the locked row: under READ COMMITTED its statement then reads what the other writer committed. Before, its update read the cost
  and the old effective cost from what the statement saw before it waited for the row, so a sync racing a change of the own cost could write
  an effective cost under the new cost (the CHECK refused it and the whole sync was lost) or skip an update a lowered own cost needed (a
  floor too low). The change of the own cost holds the row `FOR UPDATE` from its start, so the two run one after the other in either
  order. Every caller locks the same rows in the same order (the sync and the supplier status change after their supplier row, as before).
- **Supply.** A service delivered from code stock with at least one available code counts as supplied, with or without a supplier
  (`supplyStateOf`, read by `supplyStates`). One with no usable supplier and no available code is `out_of_stock`, a new publish block reason
  right after `supplier_unavailable` (an automatic service only; a manual one waits for staff as before). Codes of any other service never
  count. The attention reason `no_supplier` follows the same rule: an automatic stock service with an available code needs no supplier.
- **The shop's "in stock".** The availability `in_stock` (and its filter and the search documents' `in_stock`) needs the flag: only a stock
  service's codes complete an order at once (`showsInStock`, twin of `IN_STOCK_SQL`).
- **Dispatch.** An automatic order of a stock service that reaches the dispatch with no usable supplier (no link, or every linked supplier
  paused, disabled or no longer listing the service) stops in `needs_attention` with the reason "No codes in stock and no supplier: deliver it
  by hand." A supplier that costs more than the price charged keeps its own reason, and so does every order of any other service.

**What does not change.**
- **The money paths.** A stock delivery settles as before (revenue only, B17); the order engine, the price resolver and the ledger are not
  touched. A delivered code never returns to stock.
- **The listing switch and the retail follow.** Neither judges supply: the publish rule does, at prepare and again at apply under the service
  lock. A stock change (claim, import, void) already writes `catalog.services_changed` with the reason `stock`, which the search index applies;
  a change of the flag writes the reason `service`.
- **The supplier import** still writes the supplier's cost into `services.cost` (`ServiceImporter.setCost`); that is the own cost staff then
  see and may change.

**Consequences.**
- Migration `0070_code_stock` (additive, safe under the automatic deploy): the column `services.stock_delivery boolean not null default
  false`; every service holding a code that is not `void` (available, reserved or sold; archived services included) gets `true`, so stock
  that delivered before still delivers; the CHECK of `listing_publish_items.blocked_reason` takes `out_of_stock`. An API of the release
  before keeps working on the migrated schema.
- No route, table, queue, job, cache key, outbox event type or permission is added. Two bodies gain optional keys, the service row gains three
  keys, the list gains one filter, the import and the change gain one refusal each, the create gains the floor refusal of an own cost, and the
  publish block reasons gain one value (B287). The OpenAPI documents are
  rebuilt; the console contract is re-extracted by the lead after the console's side lands.
- The seed marks the two digital-code services it stocks (Z3X credits, UnlockTool licence) as stock services.
- Tests: `test/unit/modules/catalog/domain/code-stock.spec.ts`, `storefront-availability.spec.ts`, `publish-item.spec.ts` and
  `link-selection.spec.ts` (the rules); `test/integration/catalog/code-stock.test.ts` (the row, create, the two refusals, the own cost),
  `code-stock-migration.test.ts` (the backfill), `retail-price-follow.test.ts` (a following price follows an own cost),
  `orders-stock-delivery.test.ts` and `orders/customer-stock-delivery.test.ts` (the portal and the shop take codes only for a stock
  service), `listing-publisher.test.ts` and `publish-routes.test.ts` (supply and `out_of_stock`), `storefront-availability.test.ts` and
  `supplier-dispatch.test.ts` (the reason), `effective-cost-race.test.ts` (an own cost change and a recompute on two connections, in both
  orders, raising and lowering).

**Open.** A stock service whose stock runs out keeps its shop page: the publish rule judges supply only when a page is made, as for a
supplier that is paused later.
