# 11 commissions-reports

> Portal spec prerequisite (resolution identity-platform-16): done. `GET /client/referrals` and `GET /client/commissions` are
> MISMATCHES **B164** (lead, 2026-11-07).

Phase 3, map stage 11 (admin and client surfaces). Read `_common.md` and `_feature.md` first: this brief only names the
scope. Modules: commissions (plans, assignments, accruals, the two portal routes) and money (the five reports). Wave 5, after
5 (order completions), 6 (supplier spend and call outcomes) and 8 (invoices and the shared PDF renderer). Decisions 024
(ledger), 030 (PDF rendering), 020 (jobs), 031 (clock), 032 (import cycles).

## Routes (20; remove them from `test/contract/pending.ts`)
- Plans: `GET|POST /admin/commission-plans`, `GET|PATCH|DELETE /admin/commission-plans/:id`.
- Assignments: `GET|POST /admin/commission-assignments`, `GET|PATCH|DELETE /admin/commission-assignments/:id`.
- Accruals: `GET /admin/commission-accruals`, `GET /admin/commission-accruals/:id`, `POST /admin/commission-accruals/approve`.
- Reports (money): `GET /admin/reports/profit`, `GET /admin/reports/wallet-exposure`, `GET /admin/reports/suppliers`,
  `GET /admin/reports/top-clients`, `GET /admin/reports/client-statement/:clientId` (PDF).
- Merchant portal: `GET /client/referrals`, `GET /client/commissions` (B164).

Per-route semantics: `docs/contract/endpoints/commissions.md` and `money.md`; shapes: `docs/contract/frontend-endpoints.json`;
console callers (read-only): `FRONTEND_DIR/src/features/commissions/{api,types,mocks}`, `src/features/finance/api/reports.ts`
(Reports tab), `src/features/suppliers/api/reports.ts` and the dashboard's wallet exposure, with their `types/` and `mocks/`.

## Rules that matter (beyond the endpoint docs)
- **Accruals (RULES commissions 1, health-commissions-3).** When an order completes (a staff reply, a supplier's result,
  a stock delivery at placement), every beneficiary with a current assignment accrues: a `referral` plan pays the merchant in
  `clients.referred_by_id` of the order's merchant, a `rebate` plan pays the order's own merchant. `basis_amount` = the
  order's `total_price` (revenue), `percent` = the plan's rate at that moment (rule 5: a later rate change never touches it),
  `amount` = basis x percent / 100 (4 decimals), `period` = the completion month (`YYYY-MM`, business time zone), status
  `accrued`, no ledger entry. Exactly once per order and beneficiary (a unique guard; a reversed accrual does not block a
  later re-completion). Storefront orders (no merchant) accrue nothing.
- **The completion hook.** Commissions must not import orders' internals and orders must not import commissions: add to
  orders a leaf listener registry (the pattern of catalog's `PriceVersionListeners`, decision 032) that `OrderTransitions`
  and the stock delivery in `OrderPlacement` call inside the transaction after a settlement (`complete`) and after a
  reversal (`reopen`, B2B `refund`); commissions registers at boot. One transaction: the accrual exists if and only if the
  completion committed.
- **Reversals (user rule 5, health-commissions-11).** A refund or reopen before approval sets the order's accruals
  `reversed` (approve skips them with the reason 'Reversed: the order was refunded or reopened.'); after approval the accrual
  stays `approved` and a reversing commission entry is posted (Dr `client_wallet` of the agent / Cr `commission_expense`,
  ref_type `accrual`, key `reverse:accrual:<id>`). That debit may take the agent's wallet below its credit limit: add an
  explicit option to `postTransaction` for it (named, tested, used only here; the dashboard's `wallets_negative` item shows
  the result) rather than refusing the reversal.
- **Approval (RULES commissions 2, 3, health-commissions-4).** One `commission` posting per agent for the sum of its
  approvable accruals (Dr `commission_expense` / Cr the agent's `client_wallet`, ref_type `accrual`, ref_id the first accrual,
  an idempotency key per agent and approval request); accruals become `approved` with `ledger_tx_id` and `approved_at` (the
  clock); unknown ids and non-accrued rows are skipped with the reasons of rule 3; the answer's total is what was posted; an
  empty or invalid id list is 422 on `ids`. Audited ('approved commissions of').
- **Plans (RULES commissions 5 to 7, health-commissions-1).** Rate 0.5 to 15 percent; kind `referral|rebate`; `basis` and
  `period` are required labels (the accrual basis is always revenue); `tiers` a JSON object (`{}` when none); delete refused
  with `409 PLAN_IN_USE` while an assignment is current.
- **Assignments (RULES commissions 8, 9, health-commissions-2, -12).** One current plan per merchant (unique partial index on
  `beneficiary_id` where `ends_at is null`; the race maps to `409 ALREADY_ASSIGNED`); changing the plan ends the current one
  and inserts the new one in one transaction; DELETE sets `ends_at` and answers 204 (never `409 HAS_PENDING`); the per-agent
  figures of M155 (referred count, 30-day revenue, ready and approved amounts) on the rows.
- **Reports.** Money in USD as 4-decimal strings; the console's query parameters and groupings (its `api/reports.ts` files
  and mocks are the reference): profit by day, service, supplier or merchant from settled orders; wallet exposure from the
  ledger accounts (balance, credit limit, held in open orders, per merchant); supplier spend, rejection rate and speed from
  orders and 6's call logs; top merchants by volume and by profit. The client statement is the PDF of money-10, rendered with
  decision 030's `PdfRenderer` (built by 8: reuse it), streamed, audited.
- Staff writes are audited with the demo's verb phrases (ANSWERS audit Q3). Seed: the demo's plans, assignments and
  accruals (`scripts/seed/commissions.ts`), linked to the seeded orders, and the demo's referral links.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
health-commissions-1, -2, -3, -4, -11, -12, money-10, identity-platform-16. Migration 0003 ships their schema changes; add a
migration only for what it lacks (for example the accrual uniqueness guard or `approved_at`, if missing).

## Out of scope
The dashboard (9), the payments report (16), the funnel (19), notifications about commissions (12a).
