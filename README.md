# GSM backend

The supplier server behind the GSM admin console, the merchant portal, the storefront and the Dhru Fusion / REST v1
APIs: IMEI, Server, Remote and File services sold to B2B merchants (prepaid wallet) and B2C storefront customers
(pay first, then dispatch), on one order engine, one supplier layer and one double-entry ledger.

Stack: NestJS 12 on Fastify, run by Bun 1.4 · Drizzle ORM + PostgreSQL 18 · BullMQ on Redis 8 (a queue instance and
a cache instance) · S3-compatible storage (MinIO locally) · zod contracts → OpenAPI 3.1 → Scalar.

> Status: Phase 0 (setup, Bun spike) and Phase 1 (architecture, contract alignment) are done; see `PROGRESS.md`.

## Run locally

Requirements: Bun ≥ 1.4.4 (`npm i -g bun`), Docker with Compose, and the frontend repo next to this one
(`../frontend-admin`, read-only input; override with `FRONTEND_DIR`).

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d          # Postgres, queue Redis, cache Redis, MinIO (+ bucket init)
bun run check                 # typecheck + route manifest/slices + contract docs + tests
bun run dev                   # API on :3000 (GET /health, GET /metrics)
bun run dev:worker            # worker process (its own /metrics on :9464)
bun run spike                 # Bun compatibility spike: every dependency as real processes
```

Local services (host ports can be changed with `GSM_PG_PORT`, `GSM_REDIS_QUEUE_PORT`, `GSM_REDIS_CACHE_PORT`,
`GSM_S3_PORT`, `GSM_S3_CONSOLE_PORT`):

| Service | Port | Notes |
|---|---|---|
| Postgres 18 | 5432 | user/password/db `gsm`; tests use `gsm_test` |
| Redis (queue) | 6379 | `noeviction`, AOF: BullMQ only |
| Redis (cache) | 6380 | `allkeys-lru`, no persistence |
| MinIO | 9000 (console 9001) | `gsm-minio` / `gsm-minio-secret`; buckets `gsm-files`, `gsm-files-test` |

## Scripts

| Script | What it does |
|---|---|
| `bun run dev` / `start` | API process (watch / plain) |
| `bun run dev:worker` / `start:worker` | Worker process (watch / plain) |
| `bun run typecheck` | `tsc --noEmit` (TypeScript 6, decision 003) |
| `bun run test` | Unit tests (`src/**/*.spec.ts`) and integration tests (`test/integration`) with `bun test` |
| `bun run test:unit` / `test:integration` | Only one of the two |
| `bun run routes:build` | Rebuild `docs/route-manifest.{json,md}` and `docs/slices/*.json` from the map |
| `bun run routes:check` | Fail when those files are stale (CI) |
| `bun run contract:extract` | Re-extract the frontend's endpoint types into `docs/contract/frontend-endpoints.json` |
| `bun run contract:docs` | Re-render the contract docs from the extraction and `docs/contract/lead-decisions.json` |
| `bun run contract:check` | Fail when the extract or the contract docs are stale (CI) |
| `bun run spike` | Re-run the Bun compatibility spike (decision 001) |
| `bun run check` | Everything CI runs today (typecheck, route manifest, contract docs, tests) |

## Where things are

- `reference/` → symlink to `../frontend-admin/reference`: the API design map (`gsm-map/data/*.mjs`) and the static
  demo (`gsm-admin`). Never open `reference/**/dist/**`.
- `docs/route-manifest.json`: all 274 map rows expanded to 382 endpoints with access rules, owning module and, for
  admin routes, the frontend function that calls them. `docs/slices/<module>.json`: the brief input per module.
- `scripts/module-map.mjs`: which module owns each table and each route.
- `docs/ARCHITECTURE.md`: the system on four pages. `docs/contract/ALIGNMENT.md`: the wire conventions every route
  follows; `docs/contract/endpoints/<module>.md`: per-endpoint contract; `error-codes.md`, `MISMATCHES.md`,
  `ANSWERS.md`, `RULES.md`, `OPEN-QUESTIONS.md`, `TESTS.md` next to it.
- `docs/decisions/`: decision records. `CLAUDE.md`: working rules for agents. `PROGRESS.md`: status.
- `spike/bun-compat/`: the Phase 0 spike (removed once Phase 2 tests cover the same ground).
