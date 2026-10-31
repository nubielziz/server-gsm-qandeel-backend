# 014: Testing

Status: accepted, 2026-10-31.

**Context.** The runtime is Bun; the spike proved `bun test` with `@nestjs/testing` and Fastify `inject`.

**Decision.** `bun test` for every layer, configured in `bunfig.toml` (`[test]` preload `test/setup.ts`, timeout):
- Unit: `src/**/*.spec.ts` for pure domain logic (pricing, transitions, risk thresholds, each money event, money
  rounding, list-query parsing). No I/O.
- Integration: `test/integration/**` against the compose services: Postgres `gsm_test` (migrated once per run, lazily,
  by the first test that uses the database: `test/support/db.ts`, so `bun test ./src` needs no Docker), Redis DB 1 on
  both roles, bucket `gsm-files-test`. Under `NODE_ENV=test` the config uses only the `*_TEST` instances
  (`DATABASE_URL_TEST`, `REDIS_QUEUE_URL_TEST`, `REDIS_CACHE_URL_TEST`, `S3_BUCKET_TEST`) and ignores the normal ones,
  so a test can never touch development data; a parallel worktree points them at its own database. Isolation: `resetDb()` truncates every table except
  the migrations table (`TRUNCATE … RESTART IDENTITY CASCADE`) in `beforeEach`; Redis test DBs are flushed. Includes
  concurrency tests with real parallel connections (no overspend, duplicate webhook posts once, idempotency replay)
  and Redis failure tests (down at startup, restart during processing, shutdown with active jobs).
- Scenarios: `test/scenarios/<id>.e2e.ts`, one per map scenario (13), step by step through HTTP (`inject`) and the
  worker's processors run in-process, asserting the tables and statuses each step names.
- Contract: `test/contract/**` (decision 009). Dhru: `test/dhru/**`, one fixture test per action.
- Test files run sequentially (one shared database); `bun test --coverage` reports coverage.

**Consequences.** `bun run check` needs `docker compose up -d`. Seed data for local runs mirrors the frontend mocks.
