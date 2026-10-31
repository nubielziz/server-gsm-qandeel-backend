# Progress

Single source of truth for status. The lead updates it after every step. Read it first.

## Resume here

**Phase 2, foundation, in progress** (Sonnet implements, Opus reviews). **P2.1 runtime-core and P2.2 docs-tooling are
done**; P2.3 data is built and being merged. Next: **P2.4 infra ∥ P2.7 contract-tests** (P2.7 needs P2.2's OpenAPI document),
then **P2.5 security**, then **P2.6 staff sign-in**. Briefs: `docs/briefs/` (`_common.md` first; `_feature.md` is the
Phase 3 recipe). Parallel implementers work in sibling worktrees of this repo (`git worktree add
../backend-p2-<name> -b feat/backend-p2-<name>`, then `bun install` there; a sibling path keeps the relative
`reference` symlink working; the workflow tool's worktree isolation targets the frontend repo, not this one). The lead
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
| 2 Foundation | in progress (P2.1, P2.2 done) | per feature, see below | 8 so far |
| 3 Feature loop (by stage) | | | |
| 4 Frontend integration | | | |

## Open questions for the user

Eight business rules with lead defaults (`docs/contract/OPEN-QUESTIONS.md`): group promotion, credit limits, manual
invoices, manual bank deposits, commission on refunded orders, gateway hold_hours, the refund `processing` status,
pricing-rule stacking. None blocks Phase 2; each touches a later stage (3, 4, 8, 11, 16). Update
`docs/contract/lead-decisions.json` and rerun `bun run contract:docs` when the user answers.

## Feature plan (Phase 2 and 3)

Each feature: ≤ 6 agent calls (≤ 2 implementer, ≤ 3 reader, 1 Opus review + 1 re-review), one commit. Scenario e2e
tests are added by the feature that completes the scenario. Endpoint counts from `docs/slices/index.json`.

| # | Feature | Scope | Scenarios completed | Status |
|---|---|---|---|---|
| P2.1 | runtime-core | config, logging, request id, problem+json + catalog, contract layer (defineRoute, @Route, lists), money helper, /health, /metrics, api + worker bootstrap, bunfig + tests (brief `docs/briefs/P2.1-runtime-core.md`) | | done (`feat(runtime-core)` commit) |
| P2.2 | docs-tooling | OpenAPI 3.1 generation (internal + public), Scalar `/docs` and `/reference`, `/openapi.json`, ESLint (jsdoc, boundaries, env rule) + prettier, module READMEs, CONTRIBUTING, CI script | | done (`feat(docs-tooling)` commit) |
| P2.3 | data | Drizzle schema for all 66 tables (per module) + schema additions (MISMATCHES), constraints, indexes, ledger triggers, first migration, migrator, resetDb, Postgres health indicator, seed from the frontend demo state | | in progress (worktree `../backend-p2-data`) |
| P2.4 | infra | two Redis clients + health indicators, CacheService, RateLimitService, BullMQ base (queues, worker registry, schedulers, job_runs), outbox + relay, S3 storage, outbound http, crypto (AES-GCM keyring, token hashing, argon2), Prometheus in compose; retire `spike/` | | |
| P2.5 | security | IP rules hook, maintenance hook, rate-limit hook, auth guards (staff/merchant/customer sessions, CSRF, API key, Dhru, webhook signatures), permission guard + catalog, audit interceptor, `/reference` staff gate | admin-team (part), ip-rules (part) | |
| P2.6 | staff-sign-in | `POST /admin/auth/login`, `/2fa`, `/2fa/setup`, `/logout`, `/password/set`, `GET /admin/auth/me` (6) | | |
| P2.7 | contract-tests | route/shape/error parity tests, fixture harvest from the frontend mocks, allowlist, `pending.ts` | | |
| 2a | identity-staff-access | staff, roles, permissions, sessions, IP rules, access restriction, audit logs, settings (st2 admin, 31) | admin-team, ip-rules | |
| 2b | identity-merchant-auth | merchant portal sign-in, security, sessions (st2 client, 15) | | |
| 3 | money-wallets-ledger | postTransaction, money events, wallets, statement, adjust, credit limit, ledger, reconcile, currencies (st3, 14) | | |
| 4a | catalog-structure | client groups, categories, services, fields, options, inventory (st4/5) | | |
| 4b | catalog-pricing | group/client prices, pricing rules, bulk price, resolve, merchant catalog and price export | | |
| 5 | orders-engine | state machine, placement + hold, admin order actions, bulk reply, export, merchant orders, files (st5) | manual | |
| 6 | suppliers | suppliers admin, Dhru supplier client, dispatch/poll jobs, dispatch/fetch/change-supplier, sync, import (st6) | success, reject, timeout | |
| 7a | dhru-and-rest-v1 | Dhru surface (8 actions), REST v1 (12), idempotency (st7) | | |
| 7b | merchant-api-webhooks | API keys, webhook endpoints, deliveries, outgoing events, public docs (st7) | | |
| 8 | billing | gateways, invoices, payments, approve/reject, KYC, payment webhook (B2B), invoice.paid (st8) | | |
| 9 | health-dashboard | system health routes, dashboard, queues board (st9) | | |
| 11 | commissions-reports | plans, assignments, accruals, approve, reports (st11) | | |
| 12a | notifications | templates, notifications, preferences, Telegram link + webhook (st12) | | |
| 12b | alerts-integrity | alert rules, alerts, incidents, integrity job (st12) | system-alert, system-integrity | |
| 14a | storefront-checkout | store config, listings, IMEI check (checksum + TAC), checkout sessions, consents (st14) | | |
| 14b | customers-accounts | store sign-in, account, admin customers, tax rates, TAC catalog, FX refresh (st14) | b2c-account | |
| 15 | storefront-content | listings admin, content pages, help, legal documents (st15) | | |
| 16 | b2c-payments-refunds | pay, receipt, B2C payment webhook, refunds, disputes, VAT/payments reports, storefront settings (st16) | b2c-paid, b2c-refund, b2c-chargeback | |
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
| **Total** | **14** |

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
- Run Bun entry points from the repo root: Bun reads `tsconfig.json` (decorator flags) from the working directory.
- `TRUST_PROXY` as a hop count becomes a trust function (Fastify 5.12 ignores numbers); use it only when the app port
  is reachable solely through the proxy chain, otherwise list the proxy addresses.
