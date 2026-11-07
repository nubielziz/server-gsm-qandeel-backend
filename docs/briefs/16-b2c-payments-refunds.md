# 16 b2c-payments-refunds

Phase 3, map stage 16 (storefront payment, refunds, disputes, B2C reports). Read `_common.md` and `_feature.md` first: this
brief only names the scope. Modules: money (payments, refunds, disputes, reports, the dispute webhook), customers (pay),
orders (the receipt, the B2C order) and storefront (settings). Wave 7, after 14a (checkout sessions), 8 (gateways, the payment
webhook pattern, `PdfRenderer`) and 5. Scenarios completed: **b2c-paid**, **b2c-refund**, **b2c-chargeback**. Decisions 024
(ledger), 025 (state machine), 020 (jobs), 030 (PDF), 031 (clock).

## Routes (15; remove them from `test/contract/pending.ts`)
- `POST /store/v1/checkout-sessions/:token/pay` (`Idempotency-Key` required, ALIGNMENT § 7), `GET /store/v1/orders/:token/receipt`.
- Refunds: `GET /admin/refunds`, `GET /admin/refunds/:id`, `POST /admin/refunds/:id/approve`, `/decline`, `/retry`.
- Disputes: `GET /admin/disputes`, `GET /admin/disputes/:id`, `POST /admin/disputes/:id/evidence`, `/accept`;
  incoming `POST /webhooks/disputes/:gateway`.
- Reports: `GET /admin/reports/vat`, `GET /admin/reports/payments`. Settings: `PATCH /admin/storefront/settings`.

Per-route semantics: `docs/contract/endpoints/money.md`, `customers.md`, `orders.md`, `storefront.md`; shapes:
`docs/contract/frontend-endpoints.json`; console callers (read-only): `FRONTEND_DIR/src/features/refunds` (refunds, disputes,
reports) and `src/features/settings` (storefront policies), with their `types/` and `mocks/`.

## Rules that matter (beyond the endpoint docs)
- **Paying creates the B2C order.** The capture posts `b2c_pay` (and `b2c_fee`) with ref_type `order` (money-1, money-2) and
  places the order through feature 5's placement path extended for a customer: no wallet hold; the risk hold of feature 18 when
  it exists (`held`); stock codes reserved at placement, sold on completion, back to stock on a rejection before delivery (RULES
  orders 10: the lead's B2B stock delivery is the base). Idempotent per `Idempotency-Key` and per gateway event id.
- **Vocabularies (money-2, b2c-6).** Order payments `pending|captured|failed|refunded|partial_refund|disputed|chargeback`,
  methods `card|wallet|crypto` (one wire helper).
- **Refunds (user rule 7, money-11, money-12).** `processing` from approval until the gateway answers, then `completed` or
  `failed`; retry sets `processing` again; a manual payout goes straight to `completed`; `b2c_refund` postings; the decline
  emails the customer (12a) and writes the order timeline.
- **Disputes.** Evidence before the deadline (`EVIDENCE_DEADLINE_PASSED`), `DISPUTE_NOT_OPEN`; the webhook verified,
  windowed, de-duplicated, answered fast (ALIGNMENT § 7); a chargeback posts `b2c_chargeback` and blocks per b2c-5.
- **Receipt.** The B2C tax receipt invoice (money-7) rendered with `PdfRenderer` (decision 030) and stored.
- **Reports (money-4, money-5).** VAT by country and period; payments with the gateway volume.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
money-1, -2, -4, -5, -7, -11, -12, b2c-5, b2c-6. Migration 0003 ships their schema changes; add a migration only for what it
lacks.

## Out of scope
Risk rules and the risk queue (18), the checkout itself (14a), B2B top-ups (8).
