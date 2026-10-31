# GSM backend (NestJS 12 + Fastify on Bun)

One order engine, one supplier layer and one double-entry ledger behind 9 surfaces (Dhru, REST v1, merchant
portal, storefront, admin, incoming webhooks, outgoing events, supplier calls, system).
**Read `PROGRESS.md` first** (status, next step, agent counters, blockers). Architecture: `docs/ARCHITECTURE.md`;
decisions: `docs/decisions/`; contract: `docs/contract/`.

## Sources of truth
- What exists (routes, tables, rules): the map `reference/gsm-map/data/*.mjs`. Query `docs/route-manifest.json` and
  `docs/slices/<module>.json`; never load `routes.mjs`/`schema.mjs` whole; never open `reference/**/dist/**`.
- Exact wire format (names, casing, nesting, pagination, dates, money, ids, errors, auth flow): what the frontend
  (`FRONTEND_DIR`, default `../frontend-admin`, read-only) sends and parses: `src/lib/api`, `src/features/*/{api,types,mocks}`.
- Frontend vs map: log it in `docs/contract/MISMATCHES.md` (route, frontend, map, proposal). Map wins for rules,
  frontend for wire format, unless the user decides. Never pick silently.
- Each of the 13 scenarios in `system.mjs` is a business rule and an e2e test; each money event is a ledger test.

## Agents (hard limits)
- Lead = Opus 5.5: architecture, every tech decision, contract, money/concurrency/security design, every review.
  `implementer` = Sonnet 5.5 (code, tests, docs); `reader` = Haiku 5.5 (narrow lookups). Defs: `.claude/agents/`.
- Do the work yourself by default. Max 3 agents at once; depth 1 (subagents never spawn agents). Per feature
  ≤ 6 calls: ≤ 2 implementer, ≤ 3 reader, 1 review + 1 re-review. Never re-spawn the same task twice; no polling or
  sleep loops; max 2 review rounds; after 2 failed attempts write `BLOCKED: reason` in PROGRESS.md and move on.
  Subagent replies ≤ 200 words. Subagents never commit or run state-changing git; only the lead commits.
- Serena first: `get_symbols_overview` → `find_symbol` → `find_referencing_symbols` → `search_for_pattern`;
  whole-file reads last. Edit existing code with symbol tools.

## Architecture (details in docs/ARCHITECTURE.md)
- Modular monolith: one Nest module per domain in `src/modules/<id>` with a public service; a module never touches
  another module's tables (ownership: `scripts/module-map.mjs`). Controller (thin) → application service (use case,
  transaction) → domain (pure functions) → repository (Drizzle).
- Two processes, one codebase: `api` and `worker`. The API never does slow work inline: DB + outbox, then return.
- Money: only `postTransaction()`; append-only (corrections reverse); lines sum to zero (code + deferred trigger);
  unique `idempotency_key`; lock `ledger_accounts` `FOR UPDATE` in id order; never floats.
- Orders: explicit state machine, every transition writes `order_events`; B2C never dispatches before payment;
  supplier timeout → `needs_attention`, hold kept, no automatic re-send.
- Never `import type` a class that Nest injects (Bun needs the value import for decorator metadata).

## Redis, cache, workers
- Two Redis roles, never mixed: queue (noeviction, AOF) for BullMQ only; cache (allkeys-lru) for cache, rate limits,
  locks. One client per role; Queue producers `enableOfflineQueue: false`; Workers `maxRetriesPerRequest: null`;
  `error` listeners on every client, Queue and Worker.
- Keys `gsm:{env}:{module}:{entity}:{id}[:v{n}]`, always a TTL with ±10–20% jitter, `SCAN` never `KEYS`, values
  < ~100 KB. Register every pattern in `docs/cache-keys.md` (owner, TTL, invalidation).
- Cache-aside; delete the key after commit; version keys for bulk invalidation; `SET NX PX` stampede lock on hot keys;
  short negative caching. Never cache as truth: balances, ledger, holds, payment/order status used for decisions,
  risk decisions, idempotency results (Postgres, inside the transaction).
- Jobs carry ids only (no secrets or personal data); idempotent (re-read state, guarded `UPDATE … WHERE status = …`,
  deterministic `jobId`); backoff + jitter, `UnrecoverableError` for permanent errors; schedulers via
  `upsertJobScheduler`; every run writes `job_runs`; every queue documented in `docs/queues.md`.
- Shutdown: BullMQ workers close in `onModuleDestroy`, connections (pool, Redis, queues) in `onApplicationShutdown`.

## Code documentation
- TSDoc on every exported symbol: what; Why (business reason, map route or scenario); `@param`, `@returns`,
  `@throws` (error codes); side effects (DB writes, jobs, cache keys, notifications); `@see` route/scenario.
  Controllers add `@route METHOD /path`. Inline comments only for rules, invariants, lock order, idempotency and
  non-obvious choices. Every module has a README. Doc lint fails CI.

## Security
- argon2id passwords; tokens, sessions and API keys stored only as hashes (single-use, 1 h expiry where the map
  says); TOTP and supplier/gateway credentials AES-256-GCM with a key id; HMAC-SHA256 on outgoing webhooks, verified
  signatures + replay protection on incoming ones; HttpOnly/Secure/SameSite cookies and CSRF as the frontend expects;
  exact-origin CORS; security headers; body limits; pino redaction; no stack traces in production problem+json;
  parameterized SQL only. Every admin write writes `audit_logs`.

## Tests
- Unit: domain logic (pricing, transitions, risk thresholds, each money event). Integration: real Postgres + Redis
  (`docker compose up -d`), incl. concurrency (no overspend, duplicate webhook posts once, idempotency replay).
  One e2e test per scenario. Contract tests in `test/contract/`. Dhru fixture test per action. Seed = frontend mocks.

## Checks and git
- Done = `bun run check` green. Branch `feat/backend`; the lead commits once per finished feature (conventional
  message; body: routes, scenarios, queues/jobs, cache keys). Stage explicit paths. Never `--no-verify`, push,
  force-push or rewrite history.
- Code, comments, docs and commits in English; talk to the user in short Jordanian Arabic.
