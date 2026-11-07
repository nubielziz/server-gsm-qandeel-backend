# 14b customers-accounts

Phase 3, map stage 14 (storefront accounts and the admin customers). Read `_common.md` and `_feature.md` first: this brief
only names the scope. Modules: customers (store sign-in, account, admin customers), catalog (TAC catalog) and money (FX
refresh; the tax rate routes of this stage were built early by the lead, `23dc5d5`). Wave 6, in parallel with 14a. Scenario
completed: **b2c-account** (`test/scenarios/b2c-account.e2e.test.ts`, every step of the slices' `scenarios` with this id).
Decisions 018 (customer sessions, CSRF, Turnstile), 019 (token hashing), 029 (FX provider), 031 (clock).

## Routes (23; remove them from `test/contract/pending.ts`)
- Store auth: `POST /store/v1/auth/magic-link`, `/auth/verify`, `/auth/login`, `/auth/password/forgot`, `/auth/password/set`,
  `/auth/logout`, `POST /store/v1/me/password`.
- Account: `GET|PATCH /store/v1/me`, `GET /store/v1/me/orders`.
- Admin customers: `GET|POST /admin/customers`, `GET|PATCH /admin/customers/:id`, `POST /admin/customers/:id/account`,
  `/password`, `/sessions/revoke`, `/suspend`, `/reactivate`.
- TAC catalog: `GET|POST /admin/tac-catalog`, `GET|PATCH /admin/tac-catalog/:id`.
- FX: `POST /admin/currencies/refresh-fx`.

Per-route semantics: `docs/contract/endpoints/customers.md`, `catalog.md`, `money.md`; shapes:
`docs/contract/frontend-endpoints.json`; console callers (read-only): `FRONTEND_DIR/src/features/customers` and
`src/features/storefront/api/tacCatalog.ts`, `src/features/settings` (currencies refresh), with their `types/` and `mocks/`.

## Rules that matter (beyond the endpoint docs)
- **Store sign-in.** Customer sessions and CSRF like the staff and merchant ones (decision 018); Turnstile on the public auth
  writes; no account enumeration (the same answer for a known or unknown email); magic links and password tokens single use,
  hashed (decision 019), expiry from the clock; the merchant portal's 2b code is the pattern.
- **Customers (b2c-1, b2c-11, b2c-12, b2c-14, b2c-16).** Currency as id plus code on the wire; risk signals on the detail;
  consents with the request IP; closed vocabularies; a blocklisted email is 422 on `email`; an email change clears
  `email_verified_at` and, for an account, sends a new verification through the outbox (12a delivers it).
- **TAC catalog (catalog-7, -8).** The TAC is editable only while no IMEI check uses it; `409 TAC_TAKEN`; release year rules.
- **FX refresh (money-9, decision 029).** `FxProvider` driver (`openexchangerates|manual`), `FX_PROVIDER_DOWN` (502) only when
  nothing could be fetched, a partial failure is 200 with `failed[]`; audited; the console's stale rule (24 h).
- Staff writes audited with the demo's verb phrases (ANSWERS audit Q3).

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
money-9, catalog-7, catalog-8, b2c-1, b2c-5, b2c-11, b2c-12, b2c-14, b2c-16. Migration 0003 ships their schema changes; add a
migration only for what it lacks.

## Out of scope
Checkout and tracking (14a), payments (16), block, export and anonymize (18), customer emails' delivery (12a).
