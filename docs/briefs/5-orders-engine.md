# 5 orders-engine

> Portal spec prerequisite (resolution identity-platform-16): done. `GET /client/files/:id` is specified in
> `docs/contract/MISMATCHES.md` **B154** (lead, 2026-11-07); `/client/kyc` (feature 8) still needs its spec.

Phase 3, map stage 5 (admin and client surfaces). Read `_common.md` and `_feature.md` first: this brief only names the
scope. Module: orders (plus `GET /admin/files/:id` and `GET /client/files/:id` of the platform module). Wave 2, after 4a and
4b (it prices with 4b's `PriceResolver` and checks 4b's price guard). Scenario completed: **manual** (write
`test/scenarios/manual.e2e.test.ts`: every step of `docs/slices/orders.json` `scenarios`, id `manual`, except the Dhru steps,
which feature 7a adds to the same file). Decision 025 (order state machine) is the core; also 024 (ledger), 020 (outbox), 022
(no cache for statuses used for decisions).

## Routes (22; remove them from `test/contract/pending.ts`)
- Admin (13): `GET /admin/orders`, `GET /admin/orders/:id`, `GET /admin/orders/:id/events`, `POST /admin/orders/:id/accept`,
  `/reply`, `/reject`, `/reopen`, `/refund`, `/verification`, `/notes`, `POST /admin/orders/bulk-reply/preview`,
  `POST /admin/orders/bulk-reply/apply`, `GET /admin/orders/export`.
- Merchant portal (7): `GET /client/dashboard`, `POST /client/orders`, `GET /client/orders`, `GET /client/orders/:id`,
  `POST /client/orders/:id/cancel`, `POST /client/orders/:id/verify`, `GET /client/orders/export`.
- Files (2, platform module): `GET /admin/files/:id`, `GET /client/files/:id` (302 to a short-lived presigned S3 link;
  `defineRoute` cannot declare a 302 yet: extend it as the P2.7 notes say, with a contract test).

Per-route semantics: `docs/contract/endpoints/orders.md`; shapes: `docs/contract/frontend-endpoints.json`; console callers
(read-only): `FRONTEND_DIR/src/features/orders/{api,types,mocks}` (the drawer actions, bulk reply, export) and the orders
lists embedded in the dashboard, merchants and customers pages.

## Rules that matter (beyond the endpoint docs)
- **State machine (decision 025 + resolution orders-suppliers-11, the authority).** Status (`pending`, `processing`,
  `completed`, `rejected`, ...) and `dispatch_state` (`held`, `done`, `manual`, `pending`, `sent`, `needs_attention`,
  `operator`) move only through one pure transition function per action, with guarded `UPDATE ... WHERE status = ... AND
  dispatch_state = ...` (a lost race answers `409 INVALID_TRANSITION`), and every transition writes `order_events` in the same
  transaction with the console's event words (orders-suppliers-15). `ORDER_HELD` for dispatch/reply/reject on a held B2C order,
  `USE_REFUNDS` for a reopened B2C order (orders-suppliers-18/19).
- **Money.** Placement holds the price (`order` money event: wallet → hold) through `LedgerPoster` in the placement
  transaction; completion settles it (`complete`: hold → revenue, with cost lines when the cost is known) and rejection
  releases it (`reject`: hold → wallet); a B2B refund of a completed order follows the endpoints doc. Idempotency keys
  `order:<id>:hold|settle|release|refund`; never post twice for one transition (concurrency tests: parallel reply and reject
  on one order post once; parallel placements never overspend a wallet; `INSUFFICIENT_FUNDS` / credit rule 2 apply).
- **Placement (one shared path for portal now, and Dhru/REST v1/store later):** resolve the price with 4b's `PriceResolver`
  for the merchant, apply 4b's `checkPriceChange` against the listed price (user rule 9: `409 PRICE_CHANGED` above the
  tolerance, else charge and record `raised` in `pricing_snapshot`), refuse a duplicate under `duplicate_rule = block_open`
  (`409 DUPLICATE_ORDER`, catalog-2), write `orders.imei` with the shared main-input helper (orders-suppliers-2), never set
  `placed_at`/`created_at` explicitly (same transaction time; contract test `placed_at = created_at`, orders-suppliers-1),
  pick `dispatch_state` (manual when the service is manual or has no active supplier link; `pending` otherwise and write the
  outbox row for the dispatch job of feature 6: register the event type now, the processor arrives with 6), answer at once.
  An archived or disabled service is not orderable.
- **Lists.** One read model with the console's filters and sorts; `pastSla` is the single age-only predicate of
  orders-suppliers-1 / ip-10 / hc-10 (open status and `placed_at` older than the service SLA), exported from the orders index
  for features 9 (dashboard, orders-health); queue derivation as ip-10 says. Bulk reply: preview matches non-empty IMEIs only,
  apply at most 500 items (422 on `items`), each order through the same reply transition. Export: count first, more than
  100,000 rows is 422 with the detail of orders-suppliers-19; every export writes `audit_logs`.
- **Merchant stats seam.** Register the orders source of identity's `ClientStatsDirectory` (2a left `NO_ORDERS` until this
  feature) so `GET /admin/clients` shows 30-day spend, orders and success rate; feed `MerchantSpend` of 4a from the ledger as
  it already does (no change needed when settle postings exist).
- **Portal routes** follow ALIGNMENT § 7, B153 (pending merchants refused) and the specs in `docs/contract/endpoints/orders.md`.
- Admin actions write `audit_logs` with the demo's verb phrases (`completed order`, `rejected order`, ...: ANSWERS audit Q3;
  the console prints `<actor> <action> <entityLabel>`). Seed: `scripts/seed/orders.ts` with the demo's 48 orders (ids, statuses,
  queues, events, prices as the frontend mocks) whose holds and settlements the money seed already posted: link them, do not
  post again.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
identity-platform-10, identity-platform-16, money-1, catalog-2, catalog-3, catalog-4, orders-suppliers-1, -2, -11, -14, -15,
-18, -19, health-commissions-10. Migration 0003 ships their schema changes; add a migration only for what it lacks.

## Out of scope
Dispatch, fetch and change-supplier and the supplier jobs (6), Dhru and REST v1 order routes (7a), the outgoing
`order.status_changed` event (7b), store orders and receipts (14a, 16), the top-clients report (11).
