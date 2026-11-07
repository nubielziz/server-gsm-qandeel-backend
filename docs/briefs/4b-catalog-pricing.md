# 4b catalog-pricing

Phase 3, map stage 4 (admin and client surfaces). Read `_common.md` and `_feature.md` first: this brief only names the
scope. Module: catalog. Wave 2, after 4a (it builds on 4a's services, groups and `recomputeEffectiveCost`). Scenarios
completed: none (orders come with 5).

## Routes (16; remove them from `test/contract/pending.ts`)
- `PUT /admin/services/:id/group-prices`.
- Client prices: `GET /admin/client-prices`, `POST /admin/client-prices`, `PATCH /admin/client-prices/:id`,
  `DELETE /admin/client-prices/:id`.
- Pricing rules: `GET /admin/pricing-rules`, `GET /admin/pricing-rules/:id`, `POST /admin/pricing-rules`,
  `PATCH /admin/pricing-rules/:id`, `DELETE /admin/pricing-rules/:id`.
- `POST /admin/services/bulk-price/preview`, `POST /admin/services/bulk-price/apply`, `GET /admin/pricing/resolve`.
- Merchant portal: `GET /client/services`, `GET /client/services/:id`, `GET /client/prices/export`.

Per-route semantics: `docs/contract/endpoints/catalog.md`; shapes: `docs/contract/frontend-endpoints.json`; console callers
(read-only): `FRONTEND_DIR/src/features/services/api/pricing.ts`, `serviceParts.ts`, `src/features/merchants/api/` (client
prices) with their `types/`, `lib/trace.ts` (how the console prints resolver steps) and `mocks/`.

## The resolver (user rule 8, resolution catalog-4: the authority)
One public `PriceResolver` in the catalog index, a pure domain function plus a loader, used by `GET /admin/pricing/resolve`,
the price checks of this feature, the merchant catalog and price export, and later by orders (5), Dhru and REST v1 lists (7a)
and storefront listings (14a/15, resolution b2c-7). Steps, in order, exactly as catalog-4 says: client price wins, else group
price, else base price; then ONE pricing rule (active, inside its window on the clock's time, group-specific or group-null,
scope service > category > global, then priority asc, group-specific first, then id) applied as margin (+) or discount/promo
(-) percent and fixed amount; then the group discount; round half-up to 2 dp; then the optional `rounding` step
(nearest_0.05, nearest_0.10, ends_99); then the floor clamp `max(rawPrice, effective cost + minProfit)` with the minProfit
selection of catalog-4. Fixed (client or group) prices skip the rule, discount and rounding steps. Without a merchant only
group-null rules match. Every step is reported with the ids and labels the console's trace expects (`category` step label
"Service rule" | "Category rule" | "Global rule"; `rounding` step value = the rounded price). Unit-test the demo's worked
examples (`reference/gsm-admin/src/js` pricing code, read-only, and the frontend mock's numbers) step by step.

## Rules that matter (beyond the endpoint docs)
- **Floors (catalog-1, catalog-12, b2c-7):** every b2b group price and client price must be >= the floor for that group
  (effective cost + minProfit, resolver order), 422 on the row's price field with the message of catalog-12; the
  `b2c_retail` row needs the storefront floor `max(round(base_price × 1.10, 2), floor)`; the whole PUT set is validated,
  unchanged rows too. Repeated `groupId` is 422 `prices.N.groupId` "Listed twice" (catalog-11). Bulk apply keeps its accepted
  exception (saves under-floor base prices and counts them) and clears `cost_was` of every repriced service (catalog-14).
- **Client prices (catalog-16):** `groupPrice` on each row = the resolver result for the merchant's group without the client
  override, after rounding and the floor clamp, 4-dp string.
- **Price protection (user rule 9, MISMATCHES B117; your part):** (a) the listed-price memory: a catalog table (migration,
  B116 note) keeping, per merchant and service, the last price listed to them (currency, time; written only when it changes),
  written by `GET /client/services`, `/client/services/:id` and `/client/prices/export` and exposed as a public
  `ListedPrices.record(...)` for 7a's Dhru and REST v1 lists; (b) the guard `checkPriceChange(listed, current, tolerance)` as a
  pure public function: above `pricing.price_change_tolerance_percent` (new setting in the platform settings registry, default
  10, integer 0-100) → refuse (`409 PRICE_CHANGED` with `listedPrice` and `currentPrice`), within it → charge and mark
  `raised = true` with the reason; feature 5 calls it at placement and writes the snapshot; (c) the catalog price version
  (decision 022) bumps whenever a resolved price can change (prices, rules, groups, effective cost), so cached price lists
  invalidate.
- **Merchant catalog:** `/client/*` routes follow ALIGNMENT § 7 and B153 (a pending merchant is refused with
  `ACCOUNT_PENDING_APPROVAL`: leave `pendingMerchant` at its default); prices resolved for the signed-in merchant; archived and
  disabled services hidden; the CSV export follows the endpoints doc.
- Caching: resolved price lists may be cached under versioned keys (`CacheKeys`, `docs/cache-keys.md`), never used as the
  truth for a charge (the order path resolves again in its transaction).
- Every mutation writes `audit_logs`; lists follow ALIGNMENT; seed the demo's group prices, client prices and rules
  (`scripts/seed/catalog.ts`, same ids and numbers as the frontend mocks).

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
catalog-1, -3 (archived services are never priced), -4, -11, -12, -14, -16, b2c-7. Migration 0003 ships their schema
changes; add a migration only for the listed-price table and anything it lacks (say so in your report).

## Out of scope
The order placement path and the pricing snapshot write (5), Dhru and REST v1 lists (7a, they call your public pieces),
the price-change digest (12a), storefront listings (15).
