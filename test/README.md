# Tests

`bun test ./src ./test` (decision 014). The global preload (`test/setup.ts`) only sets `NODE_ENV=test` and loads
`reflect-metadata`; it never touches a database.

| Folder              | What                                                                                       | Needs Docker (`docker compose up -d`) |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `src/**/*.spec.ts`  | unit tests of pure logic (no I/O)                                                          | no                                    |
| `test/schema/`      | structure of the Drizzle schema (ownership, columns, indexes, enum CHECKs)                 | no                                    |
| `test/integration/` | real Postgres (`gsm_test`), Redis (database 1), MinIO (`gsm-files-test`), the Nest app on Fastify `inject`, child processes | yes (Postgres, Redis, MinIO)          |
| `test/contract/`    | the backend against the map and the console: route, shape and error parity (decision 009)  | yes (a child process boots the app)   |
| `test/support/`     | shared helpers: `app.ts` (test app), `db.ts` (test database), `infra.ts` (Redis, cache, storage, HTTP modules on the test instances), `rejection.ts` (typed `expectRejection`), `fixtures.ts` (minimal rows) |                                       |

## Database tests

- `testDb()` (in `test/support/db.ts`) migrates `gsm_test` the first time a run needs it, then returns a pool and a
  Drizzle instance. A failed migration (Docker not running) is remembered, so every database test reports the same
  error. Call `closeTestDb()` in `afterAll` so the process can exit.
- `beforeEach(resetDb)` empties every table of the `public` schema (`TRUNCATE ... RESTART IDENTITY CASCADE`) and keeps
  the migrations table. It refuses a database whose name does not end in `_test`.
- Use `pgErrorOf(promise)` to assert on a refused statement: it unwraps Drizzle's error and returns the SQLSTATE and the
  constraint name.
- `fixtures.ts` inserts the smallest valid parents (currency, merchant, service, order); add to it instead of repeating
  insert chains in tests.
- `createTestApp({ withoutDatabase: true })` replaces the database module with an empty one, for tests of the health
  registry that register their own indicators.

## Migrating the test database by hand

`NODE_ENV=test bun run db:migrate` (the same command the first test would run). To start from nothing:
`docker exec gsm-backend-postgres-1 psql -U gsm -d gsm_test -c 'DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public'`
and migrate again.

## Infrastructure tests

`createInfra()` (in `test/support/infra.ts`) builds the real Redis, cache, rate-limit, crypto, storage and outbound-HTTP
modules on the test instances: Redis database 1 on both roles and the bucket `gsm-files-test` (under `NODE_ENV=test` the
`REDIS_*_URL`/`S3_BUCKET` variables are ignored; override the test instances with `REDIS_QUEUE_URL_TEST`,
`REDIS_CACHE_URL_TEST`, `S3_BUCKET_TEST`). It captures the log lines, so tests can assert that no secret is logged.

- Use unique keys (`randomUUID()`) and delete what you create; never `FLUSHDB`.
- "Redis down" tests point a role at a port nothing listens on (`deadRedisUrl()`); "store down" tests do the same for
  `S3_ENDPOINT`. The app must still start and answer.
- `createTestApp({ withoutInfrastructure: true })` leaves Redis, the cache and storage out (and their health indicators).
- Await failures with `expectRejection(promise, RangeError)` / `rejectionOf(promise)`, not `await expect(...).rejects`.

