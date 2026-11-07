# 6 suppliers

Phase 3, map stage 6 (admin surface and the outbound supplier calls). Read `_common.md` and `_feature.md` first: this brief
only names the scope. Module: suppliers (plus the three order routes that move an order to a supplier, owned by orders and
built here through its public service). Wave 3, after 4b and 5 (it dispatches 5's orders and recomputes 4a's effective
cost). Scenarios completed: **success**, **reject**, **timeout** (write `test/scenarios/{success,reject,timeout}.e2e.test.ts`,
every step of `docs/slices/suppliers.json` and `docs/slices/orders.json` `scenarios` with these ids, against a fake Dhru
supplier served in the test; the Dhru merchant-side steps are added by 7a). Decisions 023 (outbound HTTP, SSRF guard),
026 (Dhru compatibility), 020 (queues), 019 (credential encryption), 025 (state machine), 031 (clock).

## Routes (16; remove them from `test/contract/pending.ts`)
- Suppliers: `GET /admin/suppliers`, `GET /admin/suppliers/:id`, `POST /admin/suppliers`, `PATCH /admin/suppliers/:id`,
  `DELETE /admin/suppliers/:id`, `POST /admin/suppliers/:id/test`, `POST /admin/suppliers/:id/sync`,
  `GET /admin/suppliers/:id/services`, `POST /admin/suppliers/:id/import/preview`, `POST /admin/suppliers/:id/import`.
- Links and logs: `PUT /admin/services/:id/supplier-links`, `GET /admin/supplier-api-logs`, `GET /admin/supplier-api-logs/:id`.
- Order moves (orders module routes): `POST /admin/orders/:id/dispatch`, `POST /admin/orders/:id/fetch`,
  `POST /admin/orders/:id/change-supplier`.

Per-route semantics: `docs/contract/endpoints/suppliers.md` and `orders.md`; shapes: `docs/contract/frontend-endpoints.json`;
console callers (read-only): `FRONTEND_DIR/src/features/suppliers/{api,types,mocks}` and the order drawer's supplier actions
in `src/features/orders/api`.

## Rules that matter (beyond the endpoint docs)
- **Supplier client (decision 026).** One Dhru Fusion client (`accountinfo`, `imeiservicelist`, `placeimeiorder[bulk]`,
  `getimeiorder[bulk]`) behind a driver interface (`dhru` now; `rest` refused with a clear error until a REST supplier exists)
  through `OutboundHttp` only (SSRF guard; https required in production unless the supplier has the admin-visible plain-http
  opt-out the P2.4a notes ask for). Credentials AES-GCM with a key id; `apiKeyHint` = first 5 characters, written with the
  ciphertext, never decrypted on read (orders-suppliers-4). Per-supplier `maxConcurrency` (semaphore) and `rateLimitPerMin`
  (rate limiter), `timeoutMs`. Every call writes `supplier_api_logs` with non-null `http_status` (0 without an answer),
  `duration_ms`, `error` ('' when fine) and the outcome `ok|error|timeout` (orders-suppliers-3, health-commissions-8);
  secrets and IMEIs are redacted in stored bodies.
- **Dispatch and poll jobs (decision 020, orders-suppliers-11).** The dispatch job (enqueued by 5's placement outbox row)
  re-reads the order, picks the first active link by priority that is eligible (supplier active, not paused, cost not above the
  order's charged price: user rule 9 / B117(6), never fail over to a costlier link), calls `placeimeiorder`, and moves
  `pending → sent` (REFERENCEID) or `→ needs_attention` (refusal, timeout, no eligible link) with a `review` event and reason; a
  supplier timeout keeps the hold and never re-sends automatically (CLAUDE.md "Orders"). The poll job asks `getimeiorder` for
  sent orders (backoff, deterministic job ids) and settles through 5's transitions (`STATUS 4 → completed`, `3 → rejected`).
  Idempotent: a re-run never sends twice (guarded `UPDATE ... WHERE dispatch_state = 'pending'` before the call, the supplier
  reference stored once). Document both in `docs/queues.md`.
- **Order moves.** `dispatch` (staff retry: `retry` event; `409 NO_SUPPLIER`, `SUPPLIER_DISABLED`, `ORDER_HELD`), `fetch`
  (`fetch` event, 'Supplier has not finished yet' while running), `change-supplier` with the body and refusals of
  orders-suppliers-17 and the cost refresh and `costAbovePrice` flag of orders-suppliers-12 (allowed above the price for staff).
- **Sync and import.** Sync per orders-suppliers-6 (wait up to `timeoutMs + 5 s`; 200 / `409 SUPPLIER_UNAVAILABLE` /
  `504 SUPPLIER_TIMEOUT` / `409 SUPPLIER_DISABLED`), upserting `supplier_services`, then 4a's `recomputeEffectiveCost` for every
  linked service and the catalog price-version bump (user rule 9). Import per orders-suppliers-10 (with 4a's defaults and
  `SERVICE_PRICE_MODES` / `SERVICE_DUPLICATE_RULES`) and catalog-9 (suggested base price).
- **Reads.** `health` on `/admin/suppliers` only `up|degraded|down` (orders-suppliers-5, contract test); `creditRate` as an
  8-dp string (orders-suppliers-16, contract test `^\d+\.\d{8}$`); `links[].cost` (orders-suppliers-13); `runwayDays` and
  `lowBalance` (orders-suppliers-7); `reviewOrders` / `openOrders` (orders-suppliers-20, through the orders public service).
- **Delete** per orders-suppliers-8 (`409 SUPPLIER_IN_USE` with the two details; a tested but never used supplier deletes
  with 204: contract test). Defaults and validation per orders-suppliers-9.
- Admin writes write `audit_logs` with the demo's verb phrases (ANSWERS audit Q3: `synced supplier costs`,
  `flagged supplier degraded`, ...). Seed: the demo's suppliers, supplier services and links (`scripts/seed/suppliers.ts`,
  same ids as the frontend mocks; API keys as dev-only placeholders, never real secrets).

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
catalog-1, -2, -9, orders-suppliers-3 to -13, -15 to -17, -19, -20, health-commissions-8. Migration 0003 ships their schema
changes; add a migration only for what it lacks.

## Out of scope
The supplier report (11), the system-health supplier view (9, it reuses your health computation), Dhru and REST v1 for
merchants (7a), outgoing order events (7b).
