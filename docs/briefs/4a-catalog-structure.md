# 4a catalog-structure

Phase 3, map stages 4 and 5 (admin surface). Read `_common.md` and `_feature.md` first: this brief only names the scope.
Module: catalog (plus one identity job and one money read, see "Group promotion"). Wave 2, after wave 1 (2a, 2b, 3) is
merged. Scenarios completed: none (the order scenarios need features 5 and 6).

## Routes (20; remove them from `test/contract/pending.ts`)
- Client groups: `GET /admin/client-groups`, `GET /admin/client-groups/:id`, `POST /admin/client-groups`,
  `PATCH /admin/client-groups/:id`, `DELETE /admin/client-groups/:id`.
- Categories: `GET /admin/service-categories`, `GET /admin/service-categories/:id`, `POST /admin/service-categories`,
  `PATCH /admin/service-categories/:id`, `DELETE /admin/service-categories/:id`.
- Services: `GET /admin/services`, `GET /admin/services/:id`, `POST /admin/services`, `PATCH /admin/services/:id`,
  `DELETE /admin/services/:id`, `PUT /admin/services/:id/fields`, `PUT /admin/services/:id/options`.
- Inventory: `GET /admin/inventory-codes`, `POST /admin/services/:id/inventory/import`, `POST /admin/inventory-codes/void`.

Per-route semantics: `docs/contract/endpoints/catalog.md`; shapes: `docs/contract/frontend-endpoints.json`; console callers
(read-only): `FRONTEND_DIR/src/features/merchants/api/groups.ts`, `src/features/services/api/{services,categories,serviceParts,inventory}.ts`
with their `types/` and `mocks/` (the mocks are the reference behaviour where the docs are silent).

## Rules that matter (beyond the endpoint docs)
- **Effective cost and floor (catalog-1, user rule 9).** `services.effective_cost` exists (migration 0003). Build the catalog
  public function `recomputeEffectiveCost(tx, serviceIds)` = greatest(`cost`, credit × credit_rate of the first active supplier
  link by priority then id, 0 without a link); call it on every write of `cost` (create, PATCH). Feature 6 calls it from sync and
  link changes. Every service response sends `cost` = the effective cost and `floorPrice` = effective cost + minProfit (the
  default minProfit policy of RULES services 1 when the service has none; the per-group rule selection of catalog-4 is 4b).
- **Closed vocabularies (catalog-2):** `price_mode` only `fixed`, `duplicate_rule` `block_open` (default) | `allow`; both server
  defaults, not on the wire. **basePrice > 0** on create and PATCH (catalog-9, 422 on `basePrice`).
- **Delete a service (catalog-3, user decision):** one transaction; archive (status `disabled`, `archived_at` from the clock,
  its service-scope pricing rules inactive) when anything references it (orders, supplier links, listings, inventory codes,
  checkout sessions, help articles, IMEI checks), else hard delete (service-scope rules first, children cascade). Both 204,
  audited. Archived services are hidden from lists unless the endpoints doc says otherwise; their codes stay unique only
  among live services (partial index exists).
- **Type invariant (catalog-13):** a service's type equals its category's type (composite FK exists): 422 on `categoryId`
  (if sent) else `type`; a category with live services cannot change type (422 on `type`).
- **Categories (catalog-6, catalog-10):** duplicate name per type (case-insensitive, trimmed) is 422 on `name`, also mapped from
  the unique violation; delete only without any service row (409 `CATEGORY_IN_USE` with the two details of catalog-6), deleting
  its category-scope pricing rules in the same transaction.
- **Groups (catalog-5, catalog-17, ip-3, user rule 2):** `earnThreshold` and `depositLimit` >= 0 (0 = never a promotion target
  / no per-deposit limit); delete refused for the default group, the `b2c_retail` group and a group with merchants
  (409 `GROUP_IN_USE`), otherwise delete its group prices, its pricing rules and its id in `payment_gateways.allowed_group_ids`
  and `service_categories.allowed_group_ids` (through the owners' public services where a table is not catalog's; payment
  gateways do not exist yet: leave a TODO that feature 8 closes) in one transaction. Switching `overdraftAllowed` off is refused
  (422 on `overdraftAllowed`) while any merchant of the group has a credit limit above 0 (read through money's public
  `MerchantWallets`). Extend `ClientGroupDirectory` (catalog's public read, already used by identity) instead of adding a
  second reader.
- **Options and fields (catalog-11):** 404 for an unknown or archived service; duplicate option values per list 422 on
  `options.N.value` (later occurrence); unique violations map to the same 422.
- **PATCH /admin/services/:id (catalog-14):** saving `basePrice` clears `cost_was` (so `costChangedFrom` is null); a
  `minProfit`-only PATCH does not; `minProfit: null` resets to the default policy.
- **Inventory (catalog-15, B18):** codes stored as AES-GCM ciphertext plus `code_hash` and `code_last4` (decision 019; reuse
  the crypto keyring); `maskedCode` = 8 bullets + last 4; `batchRef` optional (1-40 of `[A-Za-z0-9._-]`), else generated
  `B-0031` from `inventory_batch_ref_seq`; reject rule and duplicate counting as catalog-15 says (counted, not 422); 422 on
  `codes` only when empty or above 10,000; void is idempotent per code and audited. Never log or return a clear code.
- **Group promotion (user rule 1, ANSWERS merchants Q7):** a nightly job promotes a merchant, never demotes, to the b2b group
  with the highest `earnThreshold > 0` that is <= the merchant's cumulative completed-order spend in USD since account
  creation and above its current group's threshold; `b2c_retail` is never a target; staff may change a group any time
  (2a's PATCH). Ownership: the job writes `clients.group_id`, so it lives in **identity** (`src/modules/identity/jobs/`),
  reads thresholds through `ClientGroupDirectory` (catalog) and spend through a new read-only money public service
  `MerchantSpend.completedSpend(db, clientIds)` = Σ of the `order_settle` debits on each merchant's `client_hold` minus their
  reversals (USD; the ledger is the source of truth, and it already returns 0 for everyone until feature 5 settles orders).
  A promotion that ip-3 would refuse (target group without overdraft while the merchant has credit) is skipped and logged.
  Pure decision function with unit tests; worker scheduler via `upsertJobScheduler`, `job_runs` row per run, idempotent (a
  re-run promotes nobody twice), audit row per promoted merchant (actor `system`), `SessionService.invalidateSubject` for the
  merchant; documented in `docs/queues.md`. Integration test seeds settled postings with `postTransaction` and the `complete`
  money event builder.
- **A default group always exists.** A fresh database has no `client_groups` row, so `POST /client/auth/register` and
  `POST /admin/clients` answer `500` ("No default merchant group is configured.", seen at runtime on 2026-11-07). Add a data
  migration that inserts the default b2b group (`is_default`, threshold 0, no overdraft) and the `b2c_retail` group when
  none exists (the seed's demo groups then reuse or replace them by name), and keep the invariant in the group routes:
  the default group cannot be deleted, and making another group the default unsets the old one in the same transaction
  (`DEFAULT_GROUP_REQUIRED` where the endpoints doc names it).
- Every mutation writes `audit_logs` (entity types from `AUDIT_ENTITY_TYPES`). Lists follow ALIGNMENT (simple-rest
  `_start/_end/_sort/_order`, `x-total-count`, whitelisted filters and search of the endpoints doc).
- Seed: `scripts/seed/catalog.ts` with the demo's groups (if 2a's seed has not created them: reuse, never duplicate),
  categories, services (fields, options) and inventory codes, same ids/names/prices as the frontend mocks.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
identity-platform-3, catalog-1, -2, -3, -5, -6, -9, -10, -11, -13, -14, -15, -17, orders-suppliers-10 (import defaults you share
with feature 6: `SERVICE_PRICE_MODES`, `SERVICE_DUPLICATE_RULES` exported from the catalog index). Migration 0003 already ships
their schema changes; add a migration only for something it lacks (say so in your report).

## Out of scope
Group/client prices, pricing rules, bulk price, resolve and the merchant catalog (4b); supplier links and import (6);
TAC catalog (14b); deposits (8).
