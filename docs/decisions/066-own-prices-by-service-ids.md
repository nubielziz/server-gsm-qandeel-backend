# 066: A merchant reads its own prices of named services (`ids` on `GET /client/services`)

Status: accepted, 2026-11-24. Builds on decisions 011 (money), 035 (routes beyond the map), 045 (the origin rules of the portal reads), 063 (the stored
order of services) and 064 (one account type). Spec entry B286.

**Context.** An account with a merchant rank pays its own prices, not the retail price. Until now it saw them in one place only: the
portal's price list (`GET /client/services`, its own page) and one service at a time (`GET /client/services/:id`). The shop is changing so that a
merchant uses the same pages as every other buyer, with its own price drawn where the retail price is drawn: on the cards of a list, a
grid or a search, in the quick view, on the service page and in the related services. A page knows which services it shows, at most a
few dozen, and needs the price of exactly those. The catalog route could only page the whole catalog (a page holds up to 1,000 rows, the
catalog up to thousands), and one read per card would be one request per service. The price a merchant is shown is also the price its
order is checked against: every price a merchant reads is remembered as its listed price, and `POST /client/orders` refuses an order that
costs more than the tolerance above the last listed price (`PRICE_CHANGED`). A read that did not remember the price it showed would
leave the merchant looking at one price while the order guard compared another.

**Decision.** `GET /client/services` takes one more optional query parameter, `ids`.
- **The wire form.** `ids=5,9,12`: service ids separated by commas, at most 100, each a positive whole number written without spaces or
  signs (the same form as an id in a path). It is one value: a repeated key is not the form.
- **The answer.** Only the named services the account may see, in the row shape of the list (`CatalogRow`: id, name, code, type, category,
  `price`, `currency`, delivery time, SLA, info, quantities), in the order of the list (category position, then the service's own
  position, then name, or the `_sort` asked for), with `x-total-count` holding the number of services found. The order of the ids does not
  matter and an id sent twice counts once. The other parameters (`type`, `categoryId`, `q`, `_sort`, `_order`) combine with it by AND.
- **Absent, not refused.** An id that is unknown, archived, switched off, in an inactive category or in a category closed to the account's
  rank is simply not in the answer, exactly like an id that does not exist, so ids cannot be probed. The same visibility rule as the list
  decides (`visibleTo`); `ids` only narrows it. A request whose ids are all absent answers `200` with `[]` and a total of 0.
- **Paging stays the list's.** The default page is 25 rows. A caller that sends up to 100 ids and wants them in one call sends `_end=100`
  (the route's page is allowed up to 1,000). `x-total-count` tells a caller that a page was cut.
- **Refusals.** An empty value (`ids=`), an empty piece (`5,,9`), a piece that is not a positive whole number, a repeated key and more than
  100 ids are `422 VALIDATION_FAILED` with `errors[0].field` `ids`, and nothing is remembered. The route's other errors are what they were:
  `401`, `403 RANK_NOT_ALLOWED` for a retail rank, `403 CSRF_FAILED` for a request that the browser marks as started by another site.
- **Listed prices.** The rows answered are remembered with `ListedPrices.record`, in the same call and with the same rule as the list (a
  write only when a price changed, one row per merchant and service, the time of the change): the rows of a request with `ids` are the
  rows of that page, so price protection works for the prices of a card as for the prices of the list. A service that was not answered
  is not recorded.
- **Never kept by a cache.** The list (with and without `ids`) and `GET /client/services/:id` answer `Cache-Control: private, no-store`:
  they carry the merchant's own prices, and the shop reads them in the browser through its own host, so neither a shared cache on the way
  nor the browser may keep them.

**What does not change.**
- **The money paths.** An order is still priced again by the one resolver at `POST /client/orders` and held from the wallet in the same
  transaction; nothing in the order engine, the price resolver or the ledger is touched, and the listed price stays a guard, never the
  source of a charge.
- **The retail checkout.** The shop checkout session and its payment steps still refuse an account of a merchant rank
  (`RANK_NOT_ALLOWED`, decision 064): the door an order comes through decides how it is paid (decision 064). A merchant buys through the
  wallet door.
- **The list without `ids`**, `GET /client/services/:id` and `GET /client/prices/export`: same parameters, same rows, same writes, same
  order (decision 063), same errors (only the `Cache-Control` header above is added to the list and the show).
- **The public shop reads** (`/store/v1/*`): retail prices, cacheable, never carrying a merchant price. This parameter lives on the
  merchant route only.
- **The shop's price sort and price filter** order and bound the public (retail) prices; a merchant's own prices do not change them.

**Consequences.**
- No route, table, migration, queue, job, cache key, outbox event or permission is added. `MerchantCatalog.page` and
  `pageVisibleServices` take an optional list of ids and add one `id IN (…)` condition next to the visibility rule, in the same query that
  counts the total; the price of each row is resolved by the same `PricingContext` call as before.
- One route gains a query parameter (B286); the route itself is in the map. The generated documents (OpenAPI, the endpoint pages and the
  route manifest) are rebuilt by the lead with the next documents run.
- Tests: `test/unit/modules/catalog/contracts/merchant-catalog.contracts.spec.ts` (what the schema accepts and refuses, the limit of 100, the
  documentation of the parameter) and `test/integration/catalog/client-catalog-ids.test.ts` (the shape, the limit, a bad value, absent ids,
  the listed prices recorded as the list records them, the refusals, the `Cache-Control` header, and the list without `ids` unchanged).

**Open.** (1) The default page of 25 rows applies to a request with `ids` too; if callers keep forgetting `_end`, the default page of such
a request could follow the number of ids. (2) A merchant price is in `USD` without tax, as in the list; the parameter does not change that.
