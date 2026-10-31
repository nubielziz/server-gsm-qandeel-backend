# GSM backend

The supplier server behind the GSM admin console, the merchant portal, the storefront and the Dhru Fusion / REST v1
APIs: IMEI, Server, Remote and File services sold to B2B merchants (prepaid wallet) and B2C storefront customers
(pay first, then dispatch), on one order engine, one supplier layer and one double-entry ledger.

Stack: NestJS 12 on Fastify, run by Bun 1.4 · Drizzle ORM + PostgreSQL 18 · BullMQ on Redis 8 (a queue instance and
a cache instance) · S3-compatible storage (MinIO locally) · zod contracts → OpenAPI 3.1 → Scalar.

> Status: see `PROGRESS.md`. The Phase 0 Bun compatibility spike (decision 001) is retired: the integration tests under
> `test/integration/` (queues, worker process, outbox, Redis, storage, process) prove the same checks.

## Run locally

Requirements: Bun ≥ 1.4.4 (`npm i -g bun`), Docker with Compose, and the frontend repo next to this one
(`../frontend-admin`, read-only input; override with `FRONTEND_DIR`).

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d          # Postgres, queue Redis, cache Redis, MinIO (+ bucket init), Prometheus
bun run check                 # typecheck + lint + route manifest/slices + contract docs + OpenAPI documents + tests
bun run dev                   # API on :3000 (GET /health, GET /metrics, API docs at /docs and /reference)
bun run dev:worker            # worker process: queue workers, schedulers, outbox relay (its own /metrics on :9464)
```

Local services (host ports can be changed with `GSM_PG_PORT`, `GSM_REDIS_QUEUE_PORT`, `GSM_REDIS_CACHE_PORT`,
`GSM_S3_PORT`, `GSM_S3_CONSOLE_PORT`, `GSM_PROMETHEUS_PORT`):

| Service | Port | Notes |
|---|---|---|
| Postgres 18 | 5432 | user/password/db `gsm`; tests use `gsm_test` |
| Redis (queue) | 6379 | `noeviction`, AOF: BullMQ only; tests use database 1 |
| Redis (cache) | 6380 | `allkeys-lru`, no persistence: cache, rate limits, locks; tests use database 1 |
| MinIO | 9000 (console 9001) | `gsm-minio` / `gsm-minio-secret`; buckets `gsm-files`, `gsm-files-test` (tests) |
| Prometheus | 9090 | scrapes the API (`:3000`) and the worker (`:9464`) running on the host; `PROMETHEUS_URL=http://localhost:9090` |

Prometheus (decision 015) is configured in `docker/prometheus/prometheus.yml`. Locally the API answers `/metrics` to private
addresses without a token, so the container scrapes it as it is. In production `METRICS_TOKEN` is required, so Prometheus
must send `Authorization: Bearer <token>`: the comment at the top of that file shows the `credentials_file` setting.

## Scripts

| Script | What it does |
|---|---|
| `bun run dev` / `start` | API process (watch / plain) |
| `bun run dev:worker` / `start:worker` | Worker process (watch / plain) |
| `bun run typecheck` | `tsc --noEmit` (TypeScript 6, decision 003) |
| `bun run lint` / `lint:fix` | ESLint (type-aware typescript-eslint, TSDoc on exports, module boundaries, `process.env` only in `src/config`, no `console` in `src`); `lint:fix` applies the safe fixes |
| `bun run format` / `format:check` | Prettier over the code (Markdown, YAML and generated JSON are left alone) |
| `bun run docs:openapi` | Regenerate `docs/contract/openapi.json` (every route) and `openapi.public.json` (REST v1, Dhru reference, webhook events) from the route contracts, without any infrastructure |
| `bun run docs:openapi:check` | Fail when those two files differ from what the contracts generate (CI) |
| `bun run test` | Unit tests (`src/**/*.spec.ts`), integration tests (`test/integration`) and the lint-rule tests (`test/lint`) with `bun test` |
| `bun run test:unit` / `test:integration` | Only one of the two |
| `GSM_TEST_DOCKER=1 bun test test/integration/queue-redis-restart.test.ts` | Restarts the queue Redis container (`docker restart`) while a worker runs; skipped unless `GSM_TEST_DOCKER=1` |
| `bun run routes:build` | Rebuild `docs/route-manifest.{json,md}` and `docs/slices/*.json` from the map |
| `bun run routes:check` | Fail when those files are stale (CI) |
| `bun run contract:extract` | Re-extract the frontend's endpoint types into `docs/contract/frontend-endpoints.json` |
| `bun run contract:docs` | Re-render the contract docs from the extraction and `docs/contract/lead-decisions.json` |
| `bun run contract:check` | Fail when the extract or the contract docs are stale (CI) |
| `bun run bench:argon2` | Print the time of one argon2id hash for candidate settings (aim for 50-150 ms on the production host) |
| `bun run check` | Everything CI runs: typecheck, lint, route manifest, contract docs, OpenAPI documents, tests |
| `scripts/ci.sh` | The CI pipeline in one command: `bun install --frozen-lockfile`, start the Docker services, `bun run check`; exits non-zero on any failure |

## CI

There is no hosted CI file yet (the hosting is not decided); any CI system can run `scripts/ci.sh`. It needs Bun, Docker
(or `CI_SKIP_SERVICES=1` with the services provided elsewhere) and the frontend checkout next to this repo
(`FRONTEND_DIR`, default `../frontend-admin`: `contract:check` reads its TypeScript). It runs
`bun install --frozen-lockfile`, starts the Docker services that are not running yet (`docker compose up -d --wait`,
only for the missing ones: running services are left alone, because `docker compose up` from a second checkout such as a
git worktree would recreate them), waits until they are healthy, then runs `bun run check` and prints the step that
failed.

## API documentation

Generated from the route contracts (decisions 008, 009, 017) and committed under `docs/contract/`:

| URL | What |
|---|---|
| `GET /openapi.json`, `GET /docs` | Public: REST API v1, the Dhru Fusion reference and the webhook events we send (Scalar page) |
| `GET /reference/openapi.json`, `GET /reference` | Internal: every route. `REFERENCE_DOCS` = `open` (default outside production), `staff` (default in production; needs a staff session with `system:read`) or `off` (404) |

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
  `CONTRIBUTING.md`: how to run everything, add an endpoint, a job, a cache key or a money event.
- `src/modules/<id>/README.md`: per module its purpose, owned tables, routes, scenarios, permissions, events, jobs and
  cache keys. `docs/contract/openapi.json` and `openapi.public.json`: the generated API documents.
- `docs/queues.md`: every BullMQ queue with its jobs, payloads, idempotency keys, retry policy and schedules; `docs/cache-keys.md`:
  every cache key family. `src/infra/queues/README.md`: how to add a job.
