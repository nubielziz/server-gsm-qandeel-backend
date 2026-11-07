# 8 billing

> Portal spec prerequisite (resolution identity-platform-16): done. `GET|POST /client/kyc` are MISMATCHES **B161**,
> `GET /client/payment-methods` **B162**, `GET|POST /client/invoices`, `GET /client/invoices/:id` and
> `POST /client/invoices/:id/receipt` **B163** (lead, 2026-11-07). They upload through `POST /client/files` (feature 7a).

Phase 3, map stage 8 (admin, client, incoming-webhook and outgoing-event surfaces). Read `_common.md` and `_feature.md`
first: this brief only names the scope. Modules: money (gateways, invoices, payments, the payment webhook, `invoice.paid`)
and identity (KYC). Wave 4, after 5 and 7b (outgoing events); in parallel with 9. Decisions 024 (ledger), 019 (credential
encryption), 020 (outbox, jobs), 030 (PDF rendering), 031 (clock).

## Routes and events (25; remove them from `test/contract/pending.ts`)
- Gateways: `GET|POST /admin/payment-gateways`, `GET|PATCH|DELETE /admin/payment-gateways/:id`.
- Invoices: `GET|POST /admin/invoices`, `GET /admin/invoices/:id`; portal `GET|POST /client/invoices`,
  `GET /client/invoices/:id`, `POST /client/invoices/:id/receipt`; `GET /client/payment-methods`.
- Payments (top-ups): `GET /admin/payments`, `GET /admin/payments/:id`, `POST /admin/payments/:id/approve`,
  `POST /admin/payments/:id/reject`.
- KYC (identity): `GET /admin/kyc-submissions`, `GET /admin/kyc-submissions/:id`, `POST /admin/kyc-submissions/:id/decide`;
  portal `GET|POST /client/kyc` (a pending merchant may upload KYC: `pendingMerchant: 'allow'`, B153).
- Incoming: `POST /webhooks/payments/:gateway` (B2B top-up confirmations; P2.5c's webhook signature registry).
- Outgoing: `invoice.paid` (through 7b's delivery fan-out; register the route of your own event).

Per-route semantics: `docs/contract/endpoints/money.md` and `identity.md`; shapes: `docs/contract/frontend-endpoints.json`;
console callers (read-only): `FRONTEND_DIR/src/features/finance` (Deposits, Invoices), `src/features/settings` (Payment
methods), `src/features/merchants` (Verification / KYC) with their `types/` and `mocks/`.

## Rules that matter (beyond the endpoint docs)
- **User rule 3:** a manual invoice is a top-up (paying it credits the wallet and emits `invoice.paid`); no B2B VAT for now
  but the rate stays a setting (default 0); due in 14 days (B41, finance Q6). Invoice tax columns per money-7.
- **User rule 4:** approving a deposit of a manual gateway (bank, Wise) debits `bank`; an automatic gateway debits
  `gateway_clearing` until payout (the `deposit` money event's `from`).
- **User rule 6 and money-3:** an automatic gateway's top-up is credited by itself `payments.auto_credit_delay_minutes` (10)
  after the confirmation (`hold_hours` only lengthens it), when the gateway API still says confirmed and risk has not flagged
  it (flagged → staff review); crypto only after the gateway's required confirmations; manual gateways keep staff review.
  The auto-credit job locks the payment row, re-checks, posts once (idempotency key per payment); `PAYMENT_AUTO_CREDIT_PENDING`
  and the race with a staff approval are tested (PHASE3-PLAN).
- **Deposit limit (catalog-17):** a deposit above the merchant group's non-zero `depositLimit` is 422 on `amount` at creation.
- **Payments (money-2, -8, b2c-6):** `/admin/payments` serves top-ups only (purpose `topup`; an order payment is 404);
  vocabularies pinned per purpose; `gatewayTxnId` '' for NULL.
- **Gateways (money-14):** the write-only `secret` is AES-GCM in `config_enc` with `secretHint` '••••' + last 4; the optional
  `webhookSecret`; `volume30d` per money-5; deleting a gateway with payments is refused as the endpoint doc says. Clean the
  group id out of `payment_gateways.allowed_group_ids` when 4a deletes a group (4a left a TODO for you).
- **Webhooks:** verified signature, 5-minute window, de-duplication by the gateway event id, `200` fast after the DB write,
  idempotent processing (ALIGNMENT § 7); a duplicate post credits once (concurrency test).
- **KYC:** documents stored in S3 through the platform files (hash, owner `client`), decisions audited, the merchant's
  `kyc_status` updated through identity.
- Every staff write is audited with the demo's verb phrases (ANSWERS audit Q3: `approved deposit of`, `rejected deposit of`,
  `issued invoice for`, ...). Seed: the demo's gateways, payments and invoices (`scripts/seed/money.ts`), linked to the
  journals the money seed already posted.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
identity-platform-16, money-2, -3, -5, -7, -8, -10, -14, catalog-17, b2c-6. Migration 0003 ships their schema changes; add a
migration only for what it lacks.

## Out of scope
B2C payments, refunds and disputes (16), the client statement PDF report (11, money-10), FX refresh (14b).
