# Progress

Single source of truth for status. The lead updates it after every step. Read it first.

## Resume here

**State on 2026-11-07, late night.** Phase 3 waves 1 to 3 are merged on `main`, plus: **3** money (`c332201`), **2b**
merchant portal (`446fd46`), **2a** staff access (`ed74e0b`), **4a** catalog structure (`7c012d2`), **4b** catalog pricing
(`3838d27`), the 4 tax rate routes of 14b built early by the lead (`23dc5d5`), **7b** merchant API keys and webhooks
(`e9322de`), **5** orders engine (`e6de28a`), the lead's B2B stock delivery (`5b291ad`), **6** suppliers (`bbf84f4`), **7a**
Dhru and REST v1 (`13cdb12`), **8** billing (`8f8f4b0`), **9** dashboard and System health (`6826959`) and **14a** storefront
catalog, IMEI check, guest checkout and tracking (`ae1dc07`, spec decisions B169). **236 of 382** map endpoints are built;
the console calls 269, of which **154** are built (14a's routes are storefront routes the console never calls). `bun run
check` is green on the merged 14a tree (3646 pass, 1 skip, 0 fail). Scenario e2e tests: 6 of 13.

**Phase 4 (frontend integration) is running alongside.** The console has a partial mock mode (`VITE_API_MOCKS=unbuilt`,
frontend decision 018): built routes go to this API through the Vite dev proxy, the rest stays mocked; `npm run mocks:live`
in the frontend regenerates the list after each merge (106 routes, committed). Runtime walks with Playwright and a real
sign-in (password + TOTP) after each merge: access, merchants, wallets, ledger, trial balance, currencies, tax rates, audit,
settings, services, categories, inventory, client groups, the price resolver, rules and a merchant's pricing tab, all
answered by the real API with no error; real writes through the UI (reconciliation, merchant approval, wallet adjustment,
service disable/enable); a Support member sees the forbidden pages hidden and the API refuses them (403). With no mocks at
all the unbuilt pages show their error state with the server's 404 detail. 7b walk: a merchant's API access tab (keys
listed, the Staging key revoked: 204) and Settings > Webhook deliveries (list, a failed delivery in the drawer, Retry: 200,
a second retry within the minute: the server's 429 shown in the drawer). 5 walk: the seven Orders tabs with their counts
(70 real answers), Complete, Reopen and Reject on one order and Accept on a manual one (all 204), the drawer's timeline and
money, and the ledger's settle, reversal and release journals. Fixes found at runtime: audit phrases (money, catalog), the
role member count (2a), a default merchant group on a fresh database (4a migration 0005), the seeded webhook payloads (7b),
and in the console the mid-session sign-out keeps the page (`?to=`).

**Running now (six agents at once, the user's request of 2026-11-07 night):** one workflow per feature, each in
`../backend-<feature>` on `feat/backend-<feature>` with its own test database `gsm_<feature>_test` and Redis DB.
`gsm-backend-continue` (finishing interrupted work, args in `.lead/continue-args.json`): **12a** notifications
(`wf_4cd665ad-733`, Redis 9), **14b** customer accounts (`wf_4b060a2c-6a7`, 4), **15** storefront content (`wf_c039bfd4-270`,
5), **11** commissions and reports (`wf_a50bf7cb-24e`, 7). `gsm-backend-feature` (new worktree from `main`, args in
`.lead/feature-args.json`): **12b** alerts and integrity (`wf_31478c9a-770`, from `664f11c`, Redis 6), **16** B2C payments,
refunds and disputes (`wf_73269427-02a`, from `ae1dc07`, Redis 10). Each run: Sonnet implementer, Opus read-only review,
Sonnet fix of blocking findings, Opus re-review. Scripts: `workflows/scripts/gsm-backend-{feature,continue}-*.js` in the
lead's session directory; a resumed run needs the same args. Lead tools in `.lead/` (ignored through `.git/info/exclude`):
`merge-prep.sh start|finish <feature>`, `recreate-db.ts`, walk scripts, check logs. Only Postgres, the two Redis servers and
MinIO run; the API, worker and Vite start only for a walk and stop after it.

**Merge notes (the lead does these at each merge):**
- **14b:** set `turnstile: true` on its three store auth routes (decision 034); link a signed-in customer in checkout (14a
  opens guest sessions only); then let a signed-in account holder record `marketing` (14a's `ConsentService` skips it for any
  `has_account` customer because a guest checkout must never change it); its link-token tests need 14a's
  `createTestApp({ withoutModules })`; merge 14b's `findCustomerById` with 14a's `findCustomer` (customers infra).
- **12a:** add the `notifications` routes of 8's `invoice.paid` and the deposit approval; then 12b's alert notifications and
  16's refund decline email (both record where they must notify).
- **11:** add `GET /admin/reports/client-statement/:clientId` (it waited for `PdfRenderer`, merged with 8).
- **16:** 11 and 16 both touch `order-placement.ts` / `order-transitions.ts`; B169's open point (round the retail net up to
  whole cents).
- **Open from earlier merges:** gateway:<id> health checks (9), idempotency_keys expiry (7a), orphan files on refused file
  orders, the FILEDATA 1 MiB form limit, invoice PDF inline rendering, mismatched payments not reconciling through
  gateway_clearing, idle suppliers shown as degraded.

**Next, in order:** merge each running feature as it finishes (commit its work, merge `main` in, resolve, regenerate, full
check, squash-merge, B-entry, walk what the console can show, `npm run mocks:live` in the frontend); start **17** support
(after 12a and 14b), **18** risk and privacy (after 16) and **19** content generation and reports (after 9, 12a, 14a and 15)
as their dependencies merge, keeping six agents busy. After every merge: `bun run db:migrate && bun run db:seed` on the
development database before a walk.

**Local run:** `docker compose up -d`; `bun run db:migrate && bun run db:seed`; `bun src/main.ts` and `bun src/worker.ts`; in
the frontend `VITE_API_MOCKS=unbuilt VITE_DEV_PROXY_TARGET=http://localhost:3000 VITE_API_BASE_URL= npx vite` (port 5173: the
sign-in origin must be in `CORS_ORIGINS`); sign in as README "Local sign-in" says.

How a feature runs: a brief in `docs/briefs/` written from `_feature.md` (routes from `docs/slices/<module>.json`, user
rules from the table below; `_common.md` first). Parallel implementers work in sibling worktrees of this repo (`git worktree
add ../backend-<name> -b feat/backend-<name>`, then `bun install` there; a sibling path keeps the relative `reference`
symlink working; the workflow tool's worktree isolation targets the frontend repo, not this one). Each worktree gets its own
test database through an untracked `.env.test` (`DATABASE_URL_TEST=.../gsm_<name>_test`, created with `CREATE DATABASE`,
plus its own Redis DB numbers), so parallel test runs never truncate each other's tables. The lead commits the
implementer's output on the feature branch, merges `main` into it, fixes, runs `bun run check`, and squash-merges into
`main`. Under load (several suites at once) the migrations test in `test/integration/db-schema.test.ts` can pass its 60 s
timeout; it passes alone in about 5 s.

Read before briefing any implementer: `docs/contract/ALIGNMENT.md`, the feature's `docs/contract/endpoints/<module>.md`
and `docs/slices/<module>.json`, `docs/contract/RULES.md` for its frontend features, decisions 008-028.

## Status (2026-10-31)

- Backend repo: `/home/saifi/gsm-project/backend`, branch `feat/backend` (from the NestJS 12 starter, `master`).
  Frontend: `/home/saifi/gsm-project/frontend-admin` (read-only; `FRONTEND_DIR` default `../frontend-admin`).
- Map verified: **274 rows, 382 endpoints, 9 surfaces, 66 tables, 13 scenarios, 13 money events, 14 ledger
  accounts**. `docs/route-manifest.json` holds all endpoints; the frontend's **269 `@route` tags** all exist in it.
- Module map reviewed in Phase 1 (no change): 12 modules, table ownership = map domains (system health takes 5
  tables from domain G). Endpoints: identity 59, money 57, catalog 43, orders 40, platform 33, health 33, customers 28,
  storefront 25, suppliers 18, risk 17, commissions 15, support 14.
- Contract (Phase 1): `docs/contract/ALIGNMENT.md` (conventions), `frontend-endpoints.json` (exact shapes of the 269
  console endpoints, extracted from the frontend's TypeScript), `extraction/*.json` (per-endpoint semantics, 6 Opus
  analysts, all validated), `endpoints/<module>.md`, `error-codes.md` (119 codes), `MISMATCHES.md` (B1-B116),
  `ANSWERS.md` (201), `RULES.md` (216), `OPEN-QUESTIONS.md` (8), `TESTS.md` (contract-test design).
- Local stack (`compose.yaml`): Postgres 18.6 (`gsm`, `gsm_test`), queue Redis 8.10 (noeviction + AOF), cache Redis
  8.10 (allkeys-lru), MinIO (Chainguard image). Prometheus is added in Phase 2 (decision 015).
- Bun spike: **27/27 pass** on Bun 1.4.4 (decision 001). `bun run check` green (typecheck, routes:check,
  contract:check, `bun test ./src ./test`: 290 tests after P2.1).

## Phases

| Phase | Status | Commit | Agents used |
|---|---|---|---|
| 0 Setup + Bun spike | done | `25282af` | 0 |
| 1 Architecture + contract | done | see `git log` (`docs: phase 1 ...`) | 6 (Opus analysts, one workflow, 3 at once) |
| 2 Foundation | done | per feature, see below | 28 |
| 3 Feature loop (by stage) | | | |
| 4 Frontend integration | running since 2026-11-07 (partial mock mode; runtime walks after each merge; 87 console routes live) | frontend `169ddb9` … `0a91da5` | 1 (frontend Sonnet implementer) |

## Business rules answered by the user (2026-10-31)

All questions of `docs/contract/OPEN-QUESTIONS.md` are answered (eight from Phase 1, a ninth raised by the user) (recorded in `docs/contract/lead-decisions.json`;
full rules in the cited ANSWERS/MISMATCHES entries). The feature that implements each rule must follow it:

| # | Rule | Feature |
|---|---|---|
| 1 | Group promotion: cumulative completed-order spend in USD since account creation; `earn_threshold` set per group by the admin; nightly job promotes, never demotes; manual group change any time (ANSWERS merchants Q7) | 4a (client groups + promotion job) |
| 2 | Credit limit: lowering below the credit in use allowed (new orders refused until a top-up); a limit > 0 on a group without `overdraft_allowed` is 422 (merchants Q13) | 3 |
| 3 | Manual invoice = top-up (paying credits the wallet, `invoice.paid`); no B2B VAT for now but the rate stays a setting (default 0); due in 14 days (B41, finance Q6) | 8 |
| 4 | Deposit approval: manual gateways (bank, Wise) debit `bank`; automatic gateways `gateway_clearing` until payout (B38, finance Q8) | 8 |
| 5 | Commission on refunds: reversed before approval, reversing entry after approval (commissions Q8) | 11 |
| 6 | Automatic gateways credit by themselves 10 min after confirmation (setting `payments.auto_credit_delay_minutes`) when the gateway API still says confirmed and risk has not flagged it (flagged → staff review); crypto only after the gateway's required confirmations; manual gateways keep staff review; `hold_hours` only lengthens the wait (settings Q9) | 8 (+ 18 risk flags) |
| 7 | Refund `processing` between approval and the gateway result; the console now knows it (B82 resolved, console M258) | 16 |
| 8 | Pricing: exactly the demo's resolver (services Q6) | 4b |
| 9 | Price protection (MISMATCHES B117): order-time floor on max(service cost, latest synced supplier cost); dashboard alert; real prices in every price list (catalog version bumped by the sync); an order more than `pricing.price_change_tolerance_percent` (default 10, no console field yet) above the merchant's last listed price is refused with `409 PRICE_CHANGED` (Dhru: "Price changed. Please refresh the service list and order again."), within it the raise is recorded in `pricing_snapshot`; merchants who ordered a service in the last 30 days get a digest (email, Telegram, webhook `service.price_changed`) when its price changes; lead default: no dispatch failover to a link costlier than the charged price | 4b, 6 (+ 7a, 7b, 9, 12a) |

## Feature plan (Phase 2 and 3)

Each feature: ≤ 6 agent calls (≤ 2 implementer, ≤ 3 reader, 1 Opus review + 1 re-review), one commit. Scenario e2e
tests are added by the feature that completes the scenario. Endpoint counts from `docs/slices/index.json`.

| # | Feature | Scope | Scenarios completed | Status |
|---|---|---|---|---|
| P2.1 | runtime-core | config, logging, request id, problem+json + catalog, contract layer (defineRoute, @Route, lists), money helper, /health, /metrics, api + worker bootstrap, bunfig + tests (brief `docs/briefs/P2.1-runtime-core.md`) | | done (`feat(runtime-core)` commit) |
| P2.2 | docs-tooling | OpenAPI 3.1 generation (internal + public), Scalar `/docs` and `/reference`, `/openapi.json`, ESLint (jsdoc, boundaries, env rule) + prettier, module READMEs, CONTRIBUTING, CI script | | done (`feat(docs-tooling)` commit) |
| P2.3 | data | Drizzle schema for all 66 tables (per module) + schema additions (MISMATCHES), constraints, indexes, ledger triggers, first migration, migrator, resetDb, Postgres health indicator, seed from the frontend demo state | | done (`feat(data)` commit) |
| P2.4a | infra-core | two Redis clients + health indicators, CacheService + CacheKeys, RateLimitService + semaphore, crypto (AES-GCM keyring, token hashing, argon2, webhook signatures), S3 storage, outbound http + SSRF guard (brief P2.4 items 1-5) | | done (`feat(infra-core)` commit) |
| P2.4b | queues-outbox | BullMQ base (queues, worker registry, schedulers), job runs (health module), outbox + relay (platform module), Prometheus in compose; retire `spike/` (brief P2.4 items 6-10) | | done (`feat(queues-outbox)` commit) |
| P2.5a | sessions-guards | contract fields, session service + cookies + CSRF token, guard dispatcher, staff/merchant/customer session guards, CSRF guard, permission guard + catalog + Owner helpers, audit service + enforcement, `/reference` staff gate (brief P2.5 split) | admin-team (part) | done (`feat(sessions-guards)` commit) |
| P2.5b | pipeline-hooks | IP rules hook + hit-counter flush, maintenance hook, per-IP rate-limit hook, ordered hook registry (brief P2.5 split; parallel with P2.5a) | ip-rules (part) | done (`pipeline-hooks` commits) |
| P2.5c | machine-auth | capability-token guard registry, API key guard, Dhru credentials guard, webhook signature registry (brief P2.5 split; after P2.5a, parallel with P2.6) | | done (`feat(machine-auth)` commit) |
| P2.6 | staff-sign-in | `POST /admin/auth/login`, `/2fa`, `/2fa/setup`, `/logout`, `/password/set`, `GET /admin/auth/me` (6) | | done (`feat(staff-sign-in)` commit) |
| P2.7 | contract-tests | route/shape/error parity tests, fixture harvest from the frontend mocks, allowlist, `pending.ts` | | done (`test(contract)` commit) |
| 2a | identity-staff-access | staff, roles, permissions, sessions, IP rules, access restriction, merchants, audit logs, settings (st2 admin, 31; brief `docs/briefs/2a-identity-staff-access.md`) | admin-team, ip-rules | done (`ed74e0b`) |
| 2b | identity-merchant-auth | merchant portal sign-in, security, sessions (st2 client, 15; brief `docs/briefs/2b-identity-merchant-auth.md`) | | done (`446fd46`) |
| 3 | money-wallets-ledger | postTransaction, money events, wallets, statement, adjust, credit limit (user rule 2), ledger, reconcile, currencies (st3, 14) (brief `docs/briefs/3-money-wallets-ledger.md`) | | done (`c332201`) |
| 4a | catalog-structure | client groups + nightly promotion job (user rule 1), categories, services, fields, options, inventory (st4/5) (brief `docs/briefs/4a-catalog-structure.md`) | | done (`7c012d2`) |
| 4b | catalog-pricing | group/client prices, pricing rules (user rule 8: the demo's resolver), price protection (user rule 9: effective-cost floor, listed-price memory, PRICE_CHANGED guard, raise in the snapshot), bulk price, resolve, merchant catalog and price export (brief `docs/briefs/4b-catalog-pricing.md`) | | done (`3838d27`) |
| 5 | orders-engine | state machine, placement + hold, admin order actions, bulk reply, export, merchant orders, files (st5) | manual | done (`e6de28a`) |
| 6 | suppliers | suppliers admin, Dhru supplier client, dispatch/poll jobs, dispatch/fetch/change-supplier, sync (user rule 9: recompute the effective cost, bump the price version, no failover above the charged price), import (st6) | success, reject, timeout | done (`bbf84f4`) |
| 7a | dhru-and-rest-v1 | Dhru surface (8 actions), REST v1 (12), idempotency, PRICE_CHANGED message and listed-price memory on the list actions (user rule 9) (st7) | | done (`13cdb12`, B166 `c73a0b8`) |
| 7b | merchant-api-webhooks | API keys, webhook endpoints, deliveries, outgoing events incl. `service.price_changed` (user rule 9, route-parity allowance B117), public docs (st7) | | done (`e9322de`) |
| 8 | billing | gateways, invoices (user rule 3), payments, approve/reject (user rule 4), automatic credit after the verification delay (user rule 6), KYC, payment webhook (B2B), invoice.paid (st8) | | done (`8f8f4b0`, B167 `56f48f7`) |
| 9 | health-dashboard | system health routes, dashboard (services_below_floor on the effective cost, user rule 9), queues board (st9) | | done (`6826959`, B168 `815313d`) |
| 11 | commissions-reports | plans, assignments, accruals (user rule 5 on refunds), approve, reports (st11) | | |
| 12a | notifications | templates, notifications, preferences, Telegram link + webhook, price-change digest (user rule 9) (st12) | | |
| 12b | alerts-integrity | alert rules, alerts, incidents, integrity job (st12) | system-alert, system-integrity | |
| 14a | storefront-checkout | store config, listings, IMEI check (checksum + TAC), checkout sessions, consents (st14) | | |
| 14b | customers-accounts | store sign-in, account, admin customers, tax rates (done early: `23dc5d5`), TAC catalog, FX refresh (st14) | b2c-account | |
| 15 | storefront-content | listings admin, content pages, help, legal documents (st15) | | |
| 16 | b2c-payments-refunds | pay, receipt, B2C payment webhook, refunds (user rule 7: `processing`), disputes, VAT/payments reports, storefront settings (st16) | b2c-paid, b2c-refund, b2c-chargeback | |
| 17 | support | tickets (store + admin), replies, notes, templates, CSAT (st17) | b2c-ticket | |
| 18 | risk-privacy | IMEI checks via supplier, blocklist, risk queue and rules, data requests, export/anonymize (st18) | | |
| 19 | growth | abandoned checkouts, recovery, funnel, content generation (st19) | | |

## Agent budget

Limits (CLAUDE.md): 3 agents at once, depth 1, per feature ≤ 6 calls (≤ 2 implementer, ≤ 3 reader, 1 review + 1
re-review), max 2 review rounds.

| Step | Calls |
|---|---|
| Phase 0 | 0 (lead only) |
| Phase 1 | 6 (contract extraction: Opus analysts, max 3 at once) |
| P2.1 runtime-core | 2 (Sonnet implementer, Opus review: pass, no blocking) |
| P2.2 docs-tooling | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| P2.3 data | 2 (implementer, review: pass, no blocking) |
| P2.4a infra-core | 2 (implementer, review: pass, no blocking) |
| P2.7 contract-tests | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| P2.4b queues-outbox | 2 (implementer, review: pass, no blocking) |
| P2.5a sessions-guards | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| P2.5b pipeline-hooks | 2 (implementer, review: pass, no blocking) |
| P2.5c machine-auth | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| P2.6 staff-sign-in | 2 (implementer, review: pass, no blocking) |
| P2.8 clock | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| Wave 1, first run (2026-11-01) | 3 (Sonnet implementers 2a, 2b, 3; cut off before finishing, no review) |
| Session 2026-11-07 | limit set by the user: 4 calls in all, 2 at once. All 4 used: 2a finish (Sonnet), frontend partial mocks (Sonnet), 4a (Sonnet), 4b (Sonnet). Reviews, fixes and merges of 3, 2b and 2a by the lead (Opus). |
| Session 2026-11-07, second budget | approved by the user: 4 more calls, 2 at once. 7b and 5 (Sonnet) done and merged; 6 (Sonnet) running; 7a next. |
| Session 2026-11-07, third budget | approved by the user: a much larger budget and as much parallelism as is technically safe for waves 4-7 (it supersedes the "max 3 at once" of CLAUDE.md for this phase; inform the user before other significant spending). Plan: one workflow per feature (Sonnet implementer, Opus read-only review, Sonnet fix of blocking findings, Opus re-review), about 5 implementers at once (machine: 16 cores, 15 GB; Postgres raised to 300 connections, `cf06f09`). Merged under it: 7a, 8, 9, 14a. After the reboot the user asked for 3 agents at once, then 6 (2026-11-07 night). Running: 12a, 14b, 15, 11, 12b, 16 (each run's agent calls are in its workflow journal). |
| **Total** | **47** |

## Decisions

001 runtime Bun · 002 package manager bun · 003 TypeScript 6.0 · 004 local S3 = Chainguard MinIO · 005 pg driver ·
006 two Redis roles · 007 argon2id via @node-rs/argon2 · 008 zod contract layer · 009 contract sync tests ·
010 ids and tokens · 011 money · 012 logging · 013 config · 014 testing · 015 observability (+ Prometheus) ·
016 repo layout · 017 API docs exposure · 018 auth, sessions, CSRF, pipeline · 019 encryption and token hashing ·
020 outbox and queues · 021 rate limiting · 022 caching · 023 outbound HTTP · 024 ledger · 025 order state machine ·
026 Dhru compatibility · 027 database conventions · 028 error format · 029 FX provider · 030 PDF rendering · 031 clock ·
032 module import cycles (identity exports its principal layer first; `test/unit/module-load.test.ts`). 033 mail delivery (SMTP through nodemailer 10.2.1, Telegram Bot API over OutboundHttp, Mailpit locally on 1025/8025). 034 Turnstile (`X-Turnstile-Token`, one guard, `turnstile: true` on the six store routes, a dummy verifier without a secret).

## Blockers

None.

## Notes for later phases

- Tests (2026-11-07): bunfig has no `timeout` key, so the old `timeout = 15000` was ignored and the suite ran on Bun's 5 s
  default; the 15 s now comes from `--timeout 15000` in the `test` scripts (a heavy file sets `setDefaultTimeout`, as the
  seed tests do). The seed opens accounts for the 20 demo merchants and leaves the credit limit at 0 where the group allows
  none (user rule 2 wins over the demo data: the mock's Standard group has credit limits but no overdraft). Merchant mail
  events have one owner, `MerchantMailOutbox` (2a's duplicate registration of `merchant.invited` would have stopped the API
  and the worker at boot). The dev default of `CORS_ORIGINS` has no merchant-portal origin (`PORTAL_BASE_URL` defaults to
  `http://localhost:5174`): add it when the portal frontend exists.
- 5 merge notes (2026-11-07): ledger keys `order:<id>:hold`, `order:<id>:settle` (`:settle:2` after a reopen),
  `order:<id>:release`, `order:<id>:refund` (B2C) and `reverse:<settlement id>` for a reopen or a B2B refund (the brief
  said `order:<id>:refund` for B2B; `MerchantSpend` reads `reverse:`). `accept` on a non-manual order answers
  `NOT_MANUAL`. Not built: merchant cancel and verify in practice (the service flags, 7a), `POST /client/files` (7a),
  stock delivery (the lead), the B2C refunds row and gateway job (16). File downloads log but write no audit row. The
  seed's order timelines name suppliers that 6 seeds (supplier fields stay null until then). 7b's webhook event data and
  price change scan still read `orders` through their documented foreign read: switch them to `OrderReadService` when
  someone touches them. Migration 0008 was regenerated with drizzle-kit after 7b's 0007 (a worktree DB that applied the
  old 0007 must be recreated: the migrator compares timestamps only).
- 9 merge notes (2026-11-07): the Opus review found four blocking issues (manual runs of the schedulers that write no
  `job_runs` left a phantom running row; attention severities and filters against RULES dashboard 3; missing tests for the
  locked-rate money and most attention kinds; the supplier balance verdict without the runway), fixed and re-reviewed.
  Lead fixes at the merge: failed-job texts lose URL credentials and are capped at 500; a zero balance with no alert
  amount is not critical; the database-creating schema tests get 5 minutes; decisions 015, 020 and 032 amended. Open
  (B168): the `gateway:<id>` checks need a definition of a gateway's health and feature 8's call outcomes; an idle
  supplier reads unknown, so the dashboard shows it degraded. Walked with Prometheus off (the outage state works).
- 8 merge notes (2026-11-07): the Opus review found three blocking issues (a gateway confirming another amount or
  currency was credited the invoice's amount; the gateway on/off audit phrases; the deleted group left in the gateways),
  fixed and re-reviewed. Lead fixes at the merge: a gateway only the deleted group could use is turned off instead of
  opening to every group (B167), `webhookSecret` redacted in logs, approve documents its 409s; migration renumbered to 0010
  after 7a's 0009 (8's test database recreated). Open: the invoice PDF still renders inside the request (a job would be
  better); a mismatched payment rejected and adjusted by hand never passes through `gateway_clearing` (gateway payouts will
  not reconcile for it); the merchant notifications of approve, reject and KYC decisions come with 12a. Walked: a bank
  deposit approved from the console, an invoice, the payment methods, a KYC request approved. The dev servers are stopped
  after each walk (the user's machine is busy).
- 7a merge notes (2026-11-07): the Opus review passed; the lead fixed three security minors before the merge (a per-IP
  `upload` limiter for large bodies read before the credentials, decision 021 amended; a hidden service answered like an
  unknown one in the Dhru actions; upload names lose control, bidi and zero-width characters) and gave the tests that seed
  the whole demo a minute. Open (B166): `idempotency_keys` rows never expire and keep the answer (delivered codes too: an
  expiry job must also clear `orders.idempotency_key`); a refused file order leaves its stored file; Dhru `FILEDATA` in a
  form body is bound by the 1 MiB form limit; bulk items run in key order (integer-like ids first).
- 6 merge notes (2026-11-07): the three order moves live in the suppliers module (they read the supplier tables) and move
  orders through orders' `OrderSupplierMoves` (guarded updates) or `OrderTransitions.apply`; a supplier completion or
  rejection goes through `apply` and then sets `result_code` / `completed_at`, so the state machine's `columnsFor` still has no
  hook for supplier results (folding it in would remove that split). Money's `foreign-directory.repository.ts` still reads
  `suppliers` directly: switching it to `SupplierDirectory` would close an import cycle (money, suppliers, orders, money).
  A new supplier with balance 0 reads `lowBalance: true`. The seeded suppliers point at placeholder hosts, so a dispatch in
  development ends in Needs review ("Connection failed"); the dev database's 760 older orders keep no supplier (the orders
  seed only inserts).
- Stock delivery notes (2026-11-07): a stocked order keeps the service's effective cost as its `total_cost` (the drawer
  shows it as the supplier cost) while the settlement books no cost: codes carry no purchase cost (no column), so the
  stock's cost stays outside the ledger until someone decides to track it.
- 7b merge notes (2026-11-07): the portal webhook controller lives in identity (`merchant-webhook-routes.module.ts`)
  because platform imports no module; the engine stays in `platform/webhooks`. The merchant low-balance threshold is
  `clients.notification_prefs.lowBalanceThreshold` (a money string; none = no alert): 12a should expose it. B155 gained the
  `services:read` scope (`GET /v1/services` needs it); `*` is never offered to a merchant. Not built: re-queueing a pending
  delivery whose job was lost with the queue Redis, and auto-disabling an endpoint after many failures (9 or 12b). The
  admin delivery list rows carry `payload`, `responseBody` and `error` (the console fixtures need them); the portal says
  `succeeded` where the console says `delivered` (B156). A worktree has no `.env`, so `bun run db:migrate` / `db:seed`
  there use the dev database (`gsm`, the config default): 7b seeded it before its merge (harmless here: it matched);
  briefs say to touch only the feature's test database. (`db:migrate` prints "Migrations are up to date." after applying.) The schema tests that create a database get
  180 s (checkpoints under load: they timed out at 60 s at the end of full runs while another worktree tested).
- Wave 1 merge notes (2026-11-07): money's `infra/foreign-directory.repository.ts` reads `clients`, `client_groups`,
  `suppliers`, `customers` and `staff_users` with plain selects (documented deviation from decision 016): replace its bodies
  with the owners' public reads as they appear (identity after 2a, catalog 4a, suppliers 6, customers 14b). Merchant mail
  (2b) for 12a: the outbox row carries only `tokenId` and `auth_tokens` stores only the hash, so real delivery cannot rebuild
  the link: store the clear token AES-GCM-encrypted next to the row (short TTL, wiped when sent) or issue the token inside the
  mail job. Money routes live in `MoneyAdminModule` (database-less test apps leave it out); the global `MoneyModule` keeps
  `MerchantAccounts` and `LedgerPoster`.

- Phase 2 tests still to write for the Redis rules: Redis down at startup, Redis restart during processing (shutdown
  with an active job is proven by the spike).
- Retire `spike/` and the `postgres` and `argon2` dependencies once Phase 2 integration tests cover the spike checks.
- zod's JSON Schema output carries `$schema`; strip it when building OpenAPI components.
- The spike's validation answered 400; the real contract layer answers `422 VALIDATION_FAILED` (decision 028).
- Fixture harvest runs under Node with the frontend's own Vitest (ALIGNMENT § 8), not under Bun.
- CI needs the frontend checkout next to this repo (contract:check runs the frontend's TypeScript).
- The `origin` remote still points at `nestjs/typescript-starter` (never pushed; the user may change it).
- P2.1 review leftovers (accepted, non-blocking): Fastify router-level errors (malformed URL) skip the request hooks,
  so they carry no CORS headers, access-log line or duration sample; upstream failures must throw `AppError`
  (a Nest `HttpException` 502/504 becomes `500 INTERNAL_ERROR`); the worker's metrics listener sends no
  `X-Request-Id` on its problem answers; if the code ever runs on Node instead of Bun, re-enter the request context in
  a `preValidation` hook as `@fastify/request-context` does.
- OpenAPI: tags get a surface prefix only when two surfaces share them (lead decision: always prefixing would give
  names like `system: system`); the internal document should also list `webhooks` once events exist (feature 7b), so
  it stays a superset of the public one (decision 017).
- `scripts/ci.sh` runs `docker compose up -d`: never run it (or compose) from a worktree, it re-creates the shared
  containers with the worktree's bind paths.
- Data (P2.3) notes for Phase 3: `ip_rules.cidr` is the Postgres `cidr` type (normalise on write, drop `/32` on read:
  the wire omits it; host bits are rejected); `support_tickets.status` stores the map values (`pending_customer`,
  `closed`) that the support feature maps to the wire; columns left as plain `text` and every guessed type are listed
  in `src/infra/db/README.md` ("Open vocabularies and type guesses") for the owning feature to settle; audit entries
  without a numeric entity use `entity_id = 0` (frontend type requires a number).
- The seed (`bun run db:seed`, development only) maps demo ids like the frontend mocks (`'m3'` → 3); each Phase 3
  feature adds its module's seeder in `scripts/seed/`.
- Infra (P2.4a) notes: outbound calls go through `OutboundHttp` (the bare `httpRequest` is internal); https is
  required in production unless the call sets `allowPrivateNetwork` (internal services) or an explicit `httpsOnly`
  (a supplier on plain http needs an admin-visible opt-out in feature 6); the SSRF guard resolves DNS once, so a
  DNS-rebinding window remains (documented; https in production mostly closes it); stream uploads are buffered in
  memory up to 25 MiB; tune `ARGON2_*` on the production host (`scripts/bench-argon2.ts`, target 50-150 ms);
  `GET /health?strict=1` answers 503 only when Postgres is down (lead decision, decision 015 updated); the sign-in
  limiter key is an unsalted SHA-256 of email + IP (HMAC with `TOKEN_PEPPER` would be stronger: revisit in P2.6);
  the local queue Redis has no `maxmemory`, so the 90 % memory warning cannot fire locally.
- For P2.4b: BullMQ producers should use `skipWaitingForReady` (queue option) to fail fast while Redis is down,
  instead of the check-then-act `RedisService.assertQueueReady()`.
- Contract tests (P2.7): `test/contract/pending.ts` lists every unbuilt manifest key (378 after Phase 2's first four
  routes); a feature that builds routes removes them there. Known gaps for later features (`test/contract/README.md`
  "Known limits"): `GET /admin/permissions` needs a B-entry (`Permission[]` vs `string[]`, feature 2a);
  `GET /admin/files/:id` is a 302 that `defineRoute` cannot declare yet; route parity needs an allowance for the Dhru
  transport `POST /api/index.php` (feature 7a); `fixtures.test` does not notice a vanished mutation fixture.
- Queues (P2.4b) notes: BullMQ refuses `:` in custom job ids, so ids are `<kind>-<id>` (`outbox-<id>`,
  `manual-<run id>`; decision 020 updated); the outbox relay's one-second tick writes no `job_runs` (decision 020);
  an event type must be registered in a module the worker loads; for the health feature (9): schedule
  `JobRunsService.failStuck`, test Bull Board under Bun again, enqueue manual runs as `manual-<run id>`; when the worker
  runs in a container, give it `stop_grace_period: 30s` (its shutdown grace is 25 s); Prometheus (compose,
  `prom/prometheus:v3.15.1`) is running and scrapes `host.docker.internal:3000` and `:9464` (check the targets turn up
  once the API and the worker run).
- Sessions and guards (P2.5a) notes: customer sessions answer 401 until the customers module registers its
  `SessionSubjects` resolver (feature 14b); `PermissionsCatalog.list()` leaves out `x:*` wildcards, so role validation
  (feature 2a) accepts `x:*` by area prefix; ended sessions are never purged yet (add a purge job with feature 2a);
  revoke and suspension clear the session cache after commit, but another instance can re-cache a live view for up to
  about 60 s (cache-aside, decisions 018/022): sensitive actions in P2.6 and 2a re-check the database; P2.6's password
  set on a `pending_password` session must call `CsrfService.assert` itself (the CSRF guard ran before the optional
  session was read).
- Pipeline hooks (P2.5b) notes: the seed adds loopback allow rules (ids 8, 9) so a local console can sign in; signed
  `/webhooks/*` are never judged by IP rules (B118); sign-in steps (`/admin|client/auth/login|2fa|password`) count per IP
  whatever their access; MAINTENANCE logs at warn; still open: rate-limit keys hold the raw IP (hash them, P2.6), the IP
  rule snapshot stops caching above 100 KB (~1000 rules), an unparseable client IP is not reported (add a metric).
- Machine auth (P2.5c) notes: API-key scopes follow the permission grammar (`area:*`, `*`), but Dhru needs the exact
  `dhru` scope; key revocation (7b) and merchant status changes must call `ApiKeyDirectory.invalidate` /
  `invalidateClient` (else up to 60 s); `RateLimit-*` headers on v1 and multipart Dhru credentials are left to 7a;
  consider checking `allowed_ips` before the merchant status (a stolen key used elsewhere learns the status).
- Staff sign-in (P2.6) notes: local sign-in uses the seeded staff with password `demo-password` and the TOTP secrets
  listed in README "Local sign-in"; the 2FA and setup attempt limits count per account (stricter than per session:
  someone with the password can lock the owner out of the code step for 15 minutes); migration 0002 adds
  `staff_users.totp_last_step` (B116); `StaffAuthTokens` creates invite/reset links for feature 2a.
- Merge procedure (lead): commit the implementer's output on the feature branch, `git merge --squash` it into
  `feat/backend`, apply the review fixes, then stage only paths that still exist: a deleted directory in the `git add`
  list makes the whole command fail and leaves the later edits out of the commit (happened once: P2.4b, fixed by
  e504599). Run `bun install` after a merge that changed the lockfile.
- Run Bun entry points from the repo root: Bun reads `tsconfig.json` (decorator flags) from the working directory.
- `TRUST_PROXY` as a hop count becomes a trust function (Fastify 5.12 ignores numbers); use it only when the app port
  is reachable solely through the proxy chain, otherwise list the proxy addresses.
