# 14a storefront-checkout

Phase 3, map stage 14 (storefront surface `/store/v1`). Read `_common.md` and `_feature.md` first: this brief only names the
scope. Modules: storefront (config, the public catalog), risk (the IMEI check), customers (checkout sessions, consents) and
orders (tracking). Wave 6, after 4b (the b2c_retail price), 5 (orders) and 14b's customers table (the two may run in
parallel if 14a reads customers through a documented foreign read). Decisions 018 (sessions, CSRF, Turnstile), 021 (per-IP
limits), 019 (IMEI encryption and hashing), 031 (clock).

## Routes (8; remove them from `test/contract/pending.ts`)
- `GET /store/v1/config`, `GET /store/v1/services`, `GET /store/v1/services/:slug` (storefront).
- `POST /store/v1/imei/check` (risk).
- `POST /store/v1/checkout-sessions`, `GET /store/v1/checkout-sessions/:token`, `POST /store/v1/checkout-sessions/:token/consents`
  (customers).
- `GET /store/v1/orders/:token` (orders: tracking by the order's public token).

No console screen calls these routes (the storefront is another frontend): semantics in `docs/contract/endpoints/storefront.md`,
`customers.md`, `risk.md`, `orders.md` and the map rows (`docs/slices/*.json`); conventions in ALIGNMENT § 7 (storefront).

## Rules that matter (beyond the endpoint docs)
- **Public surface (ALIGNMENT § 7).** Turnstile on the writes (`403 TURNSTILE_FAILED`), per-IP limits, capability tokens in
  paths (checkout, tracking) compared in constant time, problem+json; nothing staff-only on the wire (cost, supplier, floor).
- **Catalog and prices.** Only listed, active, non-archived services (catalog-3) with their `service_listings` row; the price is
  4b's resolver for the `b2c_retail` group and never under the b2c floor (b2c-7, catalog-12); listed prices recorded like the
  merchant lists (user rule 9).
- **IMEI check.** Luhn checksum plus the TAC (`tac_catalog`, first 8 digits); writes `imei_checks` with `imei_enc` and the keyed
  `imei_hash`, `source` `storefront_free|pre_order`, and `country` per b2c-3; cached per IMEI until `cached_until`; never logs an
  IMEI.
- **Checkout sessions.** Status `open|paid|expired` (b2c-14); the price, tax (built tax rates: the window of the buyer's country)
  and FX rate are locked on the session; expiry from the clock; consents per b2c-12 and b2c-14 (purposes, the legal document
  version, the request IP). Paying is feature 16.
- **Tracking.** `GET /store/v1/orders/:token` shows the order's public status and result to the token holder only.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
catalog-3, orders-suppliers-2, b2c-3, b2c-7, b2c-12, b2c-14. Migration 0003 ships their schema changes; add a migration only for
what it lacks.

## Out of scope
Store sign-in and accounts (14b), payment and receipts (16), listings admin and content (15), risk holds (18).
