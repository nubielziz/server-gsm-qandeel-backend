# Progress

Single source of truth for status. The lead updates it after every step. Read it first.

## Resume here

**Phase 0 is done.** Next: **Phase 1, architecture and contract (Opus only)**:
1. `docs/contract/ALIGNMENT.md` from the frontend (`../frontend-admin`): transport conventions (Refine simple-rest
   `_start/_end/_sort/_order` + `x-total-count`, ids, dates, money, casing, enums), auth flow (staff session cookie,
   CSRF via readable `csrf_token` cookie / `X-CSRF-Token` header, login → 2FA, forced password change, invite/reset
   token, `ACCOUNT_SUSPENDED`, IP-not-allowed, expiry, `/admin/auth/me` + permissions), error contract
   (problem+json codes the frontend handles → `docs/contract/error-codes.md`), per-endpoint shapes for the 269
   frontend `@route` functions. Inputs to read first: frontend `docs/ASSUMED_CONTRACTS.md` (assumed bodies + backend
   questions), `docs/MISMATCHES.md`, `docs/decisions/005,006,007,011,016`, `src/lib/api/*`, `src/lib/auth/*`.
2. Decision records 008+ (validation/contract layer, contract sync mechanism, logging, config, money
   representation, ids, test tooling, metrics, tracing, repo layout, process code sharing, reference docs exposure,
   security details: token hashing, sessions, CSRF, encryption keys).
3. `docs/ARCHITECTURE.md` (≤ 4 pages, module diagram), review of `scripts/module-map.mjs` row placement, build order
   by stage (`st` 0→19), contract test design (`test/contract/`).

## Status (2026-10-31)

- Backend repo: `/home/saifi/gsm-project/backend`, branch `feat/backend` (from the NestJS 12 starter, `master`).
  Frontend: `/home/saifi/gsm-project/frontend-admin` (read-only; `FRONTEND_DIR` default `../frontend-admin`).
- Map verified: **274 rows, 382 endpoints, 9 surfaces, 66 tables, 13 scenarios, 13 money events, 14 ledger
  accounts**. `docs/route-manifest.json` holds all endpoints; the frontend's **269 `@route` tags** all exist in it
  (268 admin + `GET /health`).
- Module map (draft, reviewed in Phase 1): 12 modules, table ownership = map domains (system health takes 5 tables
  from domain G). Endpoints: identity 59, money 57, catalog 43, orders 40, platform 33, health 33, customers 28,
  storefront 25, suppliers 18, risk 17, commissions 15, support 14.
- Local stack (`compose.yaml`): Postgres 18.6 (`gsm`, `gsm_test`), queue Redis 8.10 (noeviction + AOF), cache Redis
  8.10 (allkeys-lru), MinIO (Chainguard image, buckets created by `minio-init`).
- Bun spike: **27/27 pass** on Bun 1.4.4 (decision 001). `bun run check` green (typecheck + routes:check).

## Phases

| Phase | Status | Commit | Agents used |
|---|---|---|---|
| 0 Setup + Bun spike | done | see `git log` (`chore: phase 0 ...`) | 0 |
| 1 Architecture + contract | next | | |
| 2 Foundation | | | |
| 3 Feature loop (by stage) | | | |
| 4 Frontend integration | | | |

## Agent budget

Limits (CLAUDE.md): 3 agents at once, depth 1, per feature ≤ 6 calls (≤ 2 implementer, ≤ 3 reader, 1 review + 1
re-review), max 2 review rounds.

| Step | Calls |
|---|---|
| Phase 0 | 0 (lead only) |
| **Total** | **0** |

## Decisions

001 runtime Bun · 002 package manager bun · 003 TypeScript 6.0 · 004 local S3 = Chainguard MinIO · 005 pg driver ·
006 two Redis roles · 007 argon2id via @node-rs/argon2.

## Blockers

None.

## Notes for later phases

- Phase 2 tests still to write for the Redis rules: Redis down at startup, Redis restart during processing (shutdown
  with an active job is proven by the spike).
- Retire `spike/` and the `postgres` and `argon2` dependencies once Phase 2 integration tests cover the spike checks.
- zod's JSON Schema output carries `$schema`; strip it when building OpenAPI components.
- The `origin` remote still points at `nestjs/typescript-starter` (never pushed; the user may change it).
