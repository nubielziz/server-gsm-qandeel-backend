# 18 risk-privacy

Phase 3, map stage 18 (risk, IMEI checks, blocklist, privacy requests). Read `_common.md` and `_feature.md` first: this brief
only names the scope. Modules: risk and customers. Wave 7, after 16 (B2C payments and orders) and 14b. Decisions 019 (IMEI
encryption), 025 (risk hold transitions), 020 (jobs), 031 (clock).

## Routes (19; remove them from `test/contract/pending.ts`)
- Store privacy: `POST /store/v1/me/data-export`, `POST /store/v1/me/data-delete`.
- Data requests: `GET /admin/data-requests`, `GET|PATCH /admin/data-requests/:id`.
- Risk: `GET /admin/risk/queue`, `POST /admin/risk/orders/:id/approve`, `POST /admin/risk/orders/:id/refund`,
  `GET /admin/risk/rules`, `PUT /admin/risk/rules`.
- IMEI checks: `GET /admin/imei-checks`, `GET /admin/imei-checks/:id`.
- Blocklist: `GET|POST /admin/blocklist`, `GET|DELETE /admin/blocklist/:id`.
- Customers: `POST /admin/customers/:id/block`, `GET /admin/customers/:id/export`, `POST /admin/customers/:id/anonymize`.

Per-route semantics: `docs/contract/endpoints/risk.md` and `customers.md`; shapes: `docs/contract/frontend-endpoints.json`;
console callers (read-only): `FRONTEND_DIR/src/features/risk` and `src/features/customers` (privacy, data requests), with their
`types/` and `mocks/`.

## Rules that matter (beyond the endpoint docs)
- **Risk holds (orders-suppliers-11, decision 025).** Rules score a B2C payment; a flagged order is placed `held`;
  approve → `pending` (or `manual` per the placement rule), refund → `done` + `rejected` through feature 5's machine actions
  (`riskApprove`, `riskRefund`); the queue's signals (b2c-11), device from the TAC (b2c-17), payment method (b2c-6). A flagged
  automatic top-up sets `review_required` (money-3).
- **Blocklist (b2c-5).** Manual block adds email, card and IMEI entries with `ON CONFLICT DO NOTHING`, unblock removes only the
  customer's manual entries; checks at checkout and registration.
- **IMEI data (b2c-3, b2c-4).** Erasure nulls `imei_enc`, `imei_hash` and `cached_until` together; the retention job
  (`imeiRetentionDays`) and anonymize do the same; the wire masks an erased IMEI.
- **Privacy.** Export as a download with the origin check of b2c-8; anonymize per B50 and b2c-4; data request notes per b2c-13
  (required on a rejection, audited).
- Staff writes audited with the demo's verb phrases (ANSWERS audit Q3).

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
money-3, orders-suppliers-11, b2c-3, b2c-4, b2c-5, b2c-6, b2c-8, b2c-11, b2c-13, b2c-17. Migration 0003 ships their schema
changes; add a migration only for what it lacks.

## Out of scope
Payments and refunds (16), the checkout (14a).
