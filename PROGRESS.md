# Progress

Single source of truth for status. The lead updates it after every step. Read it first.

## Resume here

**Phase 2, foundation, in progress** (Sonnet implements, Opus reviews). **P2.1 runtime-core, P2.2 docs-tooling and
P2.3 data are done.** P2.4a infra-core, P2.4b queues-outbox and P2.7 contract-tests are done
too. Next: **P2.5 security**, then **P2.6 staff sign-in** (the last Phase 2 features). Briefs: `docs/briefs/` (`_common.md` first; `_feature.md` is the
Phase 3 recipe). Parallel implementers work in sibling worktrees of this repo (`git worktree add
../backend-p2-<name> -b feat/backend-p2-<name>`, then `bun install` there; a sibling path keeps the relative
`reference` symlink working; the workflow tool's worktree isolation targets the frontend repo, not this one). Each
worktree gets its own test database through an untracked `.env.test` (`DATABASE_URL_TEST=.../gsm_<name>_test`,
created with `CREATE DATABASE`), so parallel test runs never truncate each other's tables. The lead
merges each finished branch into `feat/backend` (squash) after review and green checks.

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
| 2 Foundation | in progress (P2.1-P2.4b, P2.7 done; P2.5, P2.6 left) | per feature, see below | 16 so far |
| 3 Feature loop (by stage) | | | |
| 4 Frontend integration | | | |

## Business rules answered by the user (2026-10-31)

All eight questions of `docs/contract/OPEN-QUESTIONS.md` are answered (recorded in `docs/contract/lead-decisions.json`;
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
| P2.5 | security | IP rules hook, maintenance hook, rate-limit hook, auth guards (staff/merchant/customer sessions, CSRF, API key, Dhru, webhook signatures), permission guard + catalog, audit interceptor, `/reference` staff gate | admin-team (part), ip-rules (part) | |
| P2.6 | staff-sign-in | `POST /admin/auth/login`, `/2fa`, `/2fa/setup`, `/logout`, `/password/set`, `GET /admin/auth/me` (6) | | |
| P2.7 | contract-tests | route/shape/error parity tests, fixture harvest from the frontend mocks, allowlist, `pending.ts` | | done (`test(contract)` commit) |
| 2a | identity-staff-access | staff, roles, permissions, sessions, IP rules, access restriction, audit logs, settings (st2 admin, 31) | admin-team, ip-rules | |
| 2b | identity-merchant-auth | merchant portal sign-in, security, sessions (st2 client, 15) | | |
| 3 | money-wallets-ledger | postTransaction, money events, wallets, statement, adjust, credit limit (user rule 2), ledger, reconcile, currencies (st3, 14) | | |
| 4a | catalog-structure | client groups + nightly promotion job (user rule 1), categories, services, fields, options, inventory (st4/5) | | |
| 4b | catalog-pricing | group/client prices, pricing rules (user rule 8: the demo's resolver), bulk price, resolve, merchant catalog and price export | | |
| 5 | orders-engine | state machine, placement + hold, admin order actions, bulk reply, export, merchant orders, files (st5) | manual | |
| 6 | suppliers | suppliers admin, Dhru supplier client, dispatch/poll jobs, dispatch/fetch/change-supplier, sync, import (st6) | success, reject, timeout | |
| 7a | dhru-and-rest-v1 | Dhru surface (8 actions), REST v1 (12), idempotency (st7) | | |
| 7b | merchant-api-webhooks | API keys, webhook endpoints, deliveries, outgoing events, public docs (st7) | | |
| 8 | billing | gateways, invoices (user rule 3), payments, approve/reject (user rule 4), automatic credit after the verification delay (user rule 6), KYC, payment webhook (B2B), invoice.paid (st8) | | |
| 9 | health-dashboard | system health routes, dashboard, queues board (st9) | | |
| 11 | commissions-reports | plans, assignments, accruals (user rule 5 on refunds), approve, reports (st11) | | |
| 12a | notifications | templates, notifications, preferences, Telegram link + webhook (st12) | | |
| 12b | alerts-integrity | alert rules, alerts, incidents, integrity job (st12) | system-alert, system-integrity | |
| 14a | storefront-checkout | store config, listings, IMEI check (checksum + TAC), checkout sessions, consents (st14) | | |
| 14b | customers-accounts | store sign-in, account, admin customers, tax rates, TAC catalog, FX refresh (st14) | b2c-account | |
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
| **Total** | **22** |

## Decisions

001 runtime Bun · 002 package manager bun · 003 TypeScript 6.0 · 004 local S3 = Chainguard MinIO · 005 pg driver ·
006 two Redis roles · 007 argon2id via @node-rs/argon2 · 008 zod contract layer · 009 contract sync tests ·
010 ids and tokens · 011 money · 012 logging · 013 config · 014 testing · 015 observability (+ Prometheus) ·
016 repo layout · 017 API docs exposure · 018 auth, sessions, CSRF, pipeline · 019 encryption and token hashing ·
020 outbox and queues · 021 rate limiting · 022 caching · 023 outbound HTTP · 024 ledger · 025 order state machine ·
026 Dhru compatibility · 027 database conventions · 028 error format.

## Blockers

None.

## Notes for later phases

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
- Run Bun entry points from the repo root: Bun reads `tsconfig.json` (decorator flags) from the working directory.
- `TRUST_PROXY` as a hop count becomes a trust function (Fastify 5.12 ignores numbers); use it only when the app port
  is reachable solely through the proxy chain, otherwise list the proxy addresses.
