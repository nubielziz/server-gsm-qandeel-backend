# Commissions & referrals module (`commissions`)

Map domain F. Referral and commission plans, their assignment to merchants and the accruals they produce.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 024 ledger, 031 clock, 032 import cycles. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 11, commissions-reports): all 15 routes of this module, the commission engine that accrues and reverses commissions inside
the order's own transaction, the bulk approval, the merchant portal's two routes (B164) and the demo seed. The five money reports of the
same feature are in the money module (`/admin/reports/*`).

Structure: `contracts/` (zod contracts), `controllers/` (thin), `application/` (use cases), `domain/` (pure rules, unit tested), `infra/`
(Drizzle queries), `db/schema.ts`. Three Nest modules: `CommissionsAdminModule` (routes and use cases, needs the database; listed in
`NEEDS_DATABASE_AND_CACHE` of `test/support/app.ts`), `CommissionsEngineModule` (the listener only, no routes; the API and the worker both load
it, because an order completes in either process) and `CommissionsModule` (imports the admin module).

- **The engine** (`application/commission-accruals.ts`). It registers with the orders module's `OrderCompletionListeners` at boot
  (decision 032: a leaf in orders, no import between the modules) and runs in the transaction of the completion, so an accrual exists if and
  only if the completion committed. A completion is a staff reply, a supplier's result (the worker) or a stock delivery at placement.
  Every beneficiary with a current, active assignment accrues: a `referral` plan pays the merchant in `clients.referred_by_id` of the order's
  merchant, a `rebate` plan pays the order's own merchant. `basis_amount` is the order's `total_price` (revenue), `percent` the plan's rate at
  that moment (a later rate change never touches it), `amount = basis x percent / 100` (4 decimals, half up), `period` the completion
  month (`YYYY-MM`, UTC: no business time-zone setting exists yet), status `accrued`, no ledger entry. An amount that rounds to zero accrues
  nothing; a storefront order has no merchant and accrues nothing. An order accrues once per beneficiary: the partial unique index
  `commission_accruals_order_beneficiary_uq` (live accruals only) decides and `ON CONFLICT DO NOTHING` skips the loser.
- **Reversals** (user rule 5). A reopen or a B2B refund sets the order's `accrued` rows to `reversed` with `reversed_at` (the approval skips
  them with "Reversed: the order was refunded or reopened."). An `approved` accrual stays `approved`, gets `reversed_at` (a guarded update, so a
  replay or a race posts once) and the agent's wallet gives the commission back with the money event `commissionReversal` (Dr
  `client_wallet` of the agent / Cr `commission_expense`, kind `commission`, ref type `accrual`, key `reverse:accrual:<id>`). That debit may
  take the wallet below its credit limit, so it is posted with `allowBelowCreditLimit` of `postTransaction`, which nothing else uses; the
  dashboard's `wallets_negative` item shows the result. A reversed row (either way) no longer blocks the accrual of a later re-completion.
- **Approval** (`application/accrual-approval.service.ts`). One transaction: the accruals are locked in id order; an unknown id and a row that is
  not `accrued` are skipped with the console's reasons; the rest is grouped by agent and each agent gets one `commission` posting for the sum
  (Dr `commission_expense` / Cr `client_wallet`, ref type `accrual`, ref id the agent's lowest accrual id, memo `Commission batch, N accruals to
  <agent>`, key `commission:<agent>:<lowest accrual id>`), the accruals become `approved` with `ledger_tx_id` and `approved_at` from the clock,
  and one audit row per agent is written. `total` is what was posted.
- **Plans and assignments.** The rate is 0.5 to 15 percent and stored with 4 decimals; `basis` and `period` are required labels; `tiers` is a JSON
  object (`{}` by default) the server never interprets; a plan with a current assignment, or with assignments or accruals in its history, is never
  deleted (`409 PLAN_IN_USE`: switch it off). A merchant has one current plan (unique partial index on `beneficiary_id` where `ends_at` is null;
  a race answers `409 ALREADY_ASSIGNED`); changing the plan ends the row and inserts a new one in one transaction (the answer is the new row);
  DELETE sets `ends_at` and answers 204 (never `HAS_PENDING`); the scope (`referrals` or `own`) and `starts_at` come from the server. The list
  shows current assignments unless `includeEnded=true` (B42) and carries the per-agent figures of M155 (`referredCount`, `revenue30d`,
  `readyAmount`, `approvedAmount`).
- **Merchant portal** (B164). `GET /client/referrals`: the merchant's code, link (`PORTAL_BASE_URL/register?ref=<code>`), current plan and the
  merchants it referred (a name and a join date each, newest first, at most 100; the count is exact). `GET /client/commissions`: the merchant's
  own accruals (never the order id, the plan id or another merchant's figures). A pending merchant is refused (B153).
- **Seed** (`scripts/seed/commissions.ts`, after the orders seed): the demo's two plans plus the rebate plan the console's mock adds, one
  assignment per demo agent, and the demo's accruals linked to the seeded orders and, once approved, to their `commission` journals; the
  referral links come with the merchants (identity seed).

Migration `0009_commission_accrual_reversed_at`: adds `commission_accruals.reversed_at`, moves the uniqueness guard to `status <> 'reversed' and
reversed_at is null` and adds the check `status <> 'accrued' or reversed_at is null`.

Known deviation (tech debt): `infra/foreign-reads.repository.ts` reads `clients` (names, referrers, referral codes) and `orders` (the merchant
behind an order, referred revenue) with plain selects, because identity and orders export no directory for them yet. Nothing outside that file
knows; replace its bodies with their public services as they appear.

## Public API (`index.ts`)

Exports `CommissionsModule`, `CommissionsAdminModule`, `CommissionsEngineModule` (the worker loads it), the rate limits (`MIN_PLAN_PERCENT`,
`MAX_PLAN_PERCENT`) and the vocabularies (`COMMISSION_PLAN_KINDS`, `COMMISSION_ACCRUAL_STATUSES`). Other modules import only
`src/modules/commissions/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 3 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`.

| Table | What it holds |
|---|---|
| `commission_plans` | Referral and cashback plans. |
| `commission_assignments` | Links a plan to the merchant who benefits from it. |
| `commission_accruals` | Commissions owed and paid out. |

## Routes

15 endpoints (admin 13, client 2), all built. Source: `docs/slices/commissions.json` (generated from the map; `bun run routes:build`). Contracts are under `contracts/`.

### Admin console (13)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/commission-assignments/:id` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `DELETE /admin/commission-plans/:id` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |
| `GET /admin/commission-accruals` | staff-permission · `commissions:read` | Accrued commissions and their status. | 11 |
| `GET /admin/commission-accruals/:id` | staff-permission · `commissions:read` | Accrued commissions and their status. | 11 |
| `GET /admin/commission-assignments` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `GET /admin/commission-assignments/:id` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `GET /admin/commission-plans` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |
| `GET /admin/commission-plans/:id` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |
| `PATCH /admin/commission-assignments/:id` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `PATCH /admin/commission-plans/:id` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |
| `POST /admin/commission-accruals/approve` | staff-permission · `commissions:approve` | Approve and pay out in bulk, with a ledger entry on the wallet. | 11 |
| `POST /admin/commission-assignments` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `POST /admin/commission-plans` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |

### Merchant portal (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/commissions` | merchant-session | My commissions and their status. | 11 |
| `GET /client/referrals` | merchant-session | Referral link and referred merchants. | 11 |

## Scenarios

None of the 13 map scenarios (`docs/slices/` → `scenarios`) touches this module's tables. The commission rules are walked by `test/integration/commission-engine.test.ts` (the completion paths and the reversals).

## Permissions

Staff permissions the routes need: `commissions:read` (the lists and the shows of plans, assignments and accruals), `commissions:create`, `commissions:update`, `commissions:delete` (plans and assignments) and `commissions:approve` (the bulk approval). They come from the contracts (`permission` of each `defineRoute`); `commissions:*` covers them all. The merchant portal routes need a merchant session.

## Events

Outbox events produced: none (notifications about commissions are feature 12a). Consumed: none; the engine is an in-process listener of the orders module's `OrderCompletionListeners`, not an outbox route. Audit phrases written (the console prints `<actor> <action> <entityLabel>`): `changed rate of` (entity `plan`, label `<name> plan`; the demo's own phrase and label), `created plan`, `edited plan`, `deleted plan` (entity `plan`, label the bare plan name, so it reads "created plan Gold"; the demo has no phrase for them), `assigned plan to` (label `<merchant>, <plan> plan`), `changed commission plan of` (label the merchant's name; the demo's own phrase and label, the plan diff is in before/after), `ended plan of` (`<merchant>, <plan> plan`), `approved commissions for` (entity `merchant`, the agent). Merchant portal reads write no audit rows (B121).

## Jobs and schedules

None. Accruals and reversals run in the transaction of the order transition, in whichever process completes the order, so they need no queue; the approval is a synchronous request.

## Cache keys

None. An accrual's status decides what an approval pays, so no commission figure is cached.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `health-commissions-1` · GET /admin/commission-plans
- `health-commissions-2` · POST /admin/commission-assignments
- `health-commissions-3` · GET /admin/commission-accruals
- `health-commissions-4` · POST /admin/commission-accruals/approve, GET /admin/commission-accruals
- `health-commissions-11` · GET /admin/commission-accruals
- `health-commissions-12` · DELETE /admin/commission-assignments/:id

## Tests

Unit: `domain/*.spec.ts` (amount rounding, period, plan rate rules, who accrues, the approval split). Integration: `commission-plans`, `commission-assignments`, `commission-accruals`, `client-commissions`, `commission-engine` (a staff reply, a supplier's result, a stock delivery, reopen and refund before and after approval, races, rollback with the order's transaction), `ledger-credit-limit-override` (money's `allowBelowCreditLimit`) and `commissions-seed`, all under `test/integration/`.
