# Contributing

How to work in the GSM backend: run it, add an endpoint, a job, a cache key or a money event, and what the checks
enforce. Read `CLAUDE.md` (rules for agents), `PROGRESS.md` (status) and `docs/ARCHITECTURE.md` first; decisions are in
`docs/decisions/`, the wire format in `docs/contract/ALIGNMENT.md`.

Pieces that arrive with the Phase 2 features (database `runInTransaction`, Redis `CacheService`, BullMQ registry,
guards and `AuditService`, the contract-parity tests) are marked **(P2.n)**. The briefs in `docs/briefs/` say what each
one provides; this guide shows where it plugs in.

## Run everything locally

Requirements: Bun ≥ 1.4.4, Docker with Compose, and the frontend repo next to this one (`../frontend-admin`,
read-only; override with `FRONTEND_DIR`).

```bash
bun install --frozen-lockfile
cp .env.example .env          # optional outside production: every value has a local default
docker compose up -d          # Postgres, queue Redis, cache Redis, MinIO, Prometheus
bun run check                 # everything CI runs (see below)
bun run dev                   # API on :3000
bun run dev:worker            # worker process: queue workers, schedulers, outbox relay (its own /metrics on :9464)
```

- API documentation: <http://localhost:3000/docs> (public: REST v1, Dhru, webhook events), <http://localhost:3000/reference>
  (internal: every route; `REFERENCE_DOCS=open` outside production, `staff` in production).
- Run Bun entry points from the repository root: Bun reads `tsconfig.json` (decorator flags) from the working directory.
- `scripts/ci.sh` is the whole pipeline in one command (install, services, `bun run check`); see the README.

### The checks

`bun run check` is the gate before every commit. It runs, in order:

| Script | Fails when |
|---|---|
| `typecheck` | TypeScript (strict) reports an error |
| `lint` | ESLint reports an error: type-aware rules, TSDoc on exports, module boundaries, `process.env` and `console` rules |
| `routes:check` | `docs/route-manifest.json` or `docs/slices/*` are stale against the map |
| `contract:check` | the extracted frontend contract or the contract docs are stale |
| `docs:openapi:check` | `docs/contract/openapi.json` or `openapi.public.json` differ from what the contracts generate |
| `test` | any unit, integration, contract (`test/contract`, see its README) or lint-rule test fails |

Other scripts: `lint:fix`, `format` / `format:check` (Prettier: single quotes, trailing commas, 120 columns; Markdown,
YAML and generated JSON are not formatted), `docs:openapi` (regenerate), `routes:build`, `contract:docs`,
`contract:harvest` (re-record the console's mock answers into `test/contract/fixtures`; needs the frontend checkout with
`npm ci`).

## Add an endpoint end to end

Every endpoint is a zod contract (decision 008) that drives validation, handler types, serialisation and the OpenAPI
document. The contract layer is explained in `src/common/contract/README.md`; the order of work is:

1. **Check the manifest.** The route must exist in the map: `node -e 'const m=require("./docs/route-manifest.json");
   console.log(m.endpoints.filter(e=>e.key==="GET /admin/staff/:id"))'`. Read `docs/slices/<module>.json` (owned tables,
   scenario steps), `docs/contract/endpoints/<module>.md` (rules, errors, frontend function) and the exact shapes in
   `docs/contract/frontend-endpoints.json` (query it with node, never read it whole). A disagreement between the map and
   the frontend goes to `docs/contract/MISMATCHES.md` first; never pick silently.
2. **Write the contract** in `src/modules/<id>/contracts/<resource>.contracts.ts` with `defineRoute`: the key is the
   manifest key; `surface`, `access` and (for staff) `permission` as in the manifest; `tags` is the route's map group
   (`docs/route-manifest.json` → `groups`; the documents group tags by surface and prefix a tag that two surfaces share);
   every error code the route can answer, taken from `docs/contract/error-codes.md` (a new code is added to that file and
   to `src/common/errors/catalog.ts` first); an `examples` pair for the docs (validated against the schemas). The guards
   read the contract: `access` picks who authenticates, `permission` is checked against the role (`x:*` grants every action of
   `x`, `*` everything, a required `x:*` needs `x:*` or `*`; an `api-key` route names the scope the key must list, exactly), and a session route may name the sign-in stages it accepts
   (`sessionStages`, default `['active']`). A staff mutation must write an audit row; `audit: false` (with the reason in the
   `description`) opts out, and `csrf: false` marks a route that has no session to bind a CSRF token to (see
   `src/common/contract/README.md`).
3. **Write the controller** in `src/modules/<id>/controllers/`: a bare `@Controller()` and one `@Route(contract)` method
   per route that only maps inputs to a use case and returns its result. Add `@route METHOD /path` to the TSDoc.
4. **Write the use case** in `application/`: one DB transaction **(P2.3)** (`runInTransaction`), ownership and guard
   checks (`assertOwnerTargetAllowed` for actions on an Owner), `AuditService.record(tx, ...)` for staff writes **(P2.5a)**
   (the request fails in development and tests when a staff write has none), and, when an account changes, the session
   calls of the identity module (`revokeAllOf`, `invalidateSubject`, `RolePermissions.invalidate`; see its README), an outbox row for async work (`OutboxService.add`, see "Add an
   outbox event"), `afterCommit` cache invalidation. Reach other modules only through their `index.ts` (lint rule `gsm/module-boundaries`).
5. **Write the repository** in `infra/`: Drizzle queries on this module's own tables only; list contracts translate the
   parsed list query (filters, sort, range, search) to SQL with an exact `COUNT`.
6. **Test it.** Unit tests for domain functions (`*.spec.ts` next to the code); integration tests in `test/integration/`
   with `createTestApp` (`test/support/app.ts`): success, each documented refusal (status, code, field), permission
   refusal, list filters and `x-total-count`, idempotency replays, and concurrency where money or stock moves. Delete the
   route's key from `test/contract/pending.ts`: the contract tests then compare it with the frontend types, the harvested
   fixture and the OpenAPI examples (`test/contract/README.md` explains each failure and the allowlist).
7. **Regenerate the documents:** `bun run docs:openapi`, then commit `docs/contract/openapi.json` and
   `openapi.public.json` with the change; the diff shows the contract change. `GET /reference` (internal) and, for REST
   v1, Dhru and webhook events, `GET /docs` show the result.
8. **Update the module `README.md`** (routes built, permissions, jobs, events, cache keys) and the TSDoc, then run
   `bun run check`.

### Code documentation rules

ESLint (`eslint.config.mjs`) fails the build when an exported function, class, public method, interface, type alias or
constant has no TSDoc description, or an exported function misses `@param` or `@returns`. The project convention
(`docs/briefs/_common.md`) also asks for a `Why:` line (the business reason, decision or map route), `@throws` with error
codes, side effects (DB writes, jobs, cache keys, notifications) and `@see`; controllers add `@route METHOD /path`.
Every file starts with one to three comment lines saying what it is. Inline comments only for rules, invariants, lock
order and non-obvious choices.

Other lint rules: `process.env` is read only under `src/config` (decision 013); no `console` in `src` (use the logger);
`any` needs a one-line reason (`// eslint-disable-next-line @typescript-eslint/no-explicit-any -- why`); do **not**
enable `consistent-type-imports` and never `import type` a class that Nest injects (Bun needs the value import for
decorator metadata). `src/common` and `src/infra` never import from `src/modules`; modules import each other only through
`src/modules/<id>/index.ts`, with exactly two exceptions, both for the Drizzle schema: a module's `db/schema.ts` may
import another module's `db/schema.ts` for foreign keys, and `src/infra/db/schema.ts` re-exports them all.

### Outgoing webhook events

An event a merchant receives is a contract too: `defineEvent({ key: 'EVENT order.status_changed', summary, payload,
example })` (`src/common/contract/define-event.ts`) registers it, and the public document lists it under `webhooks` with
the delivery envelope `{ id, type, createdAt, data }`, the `X-GSM-Signature` header and the retry rule. Regenerate the
documents afterwards.

## Add a job **(P2.4)**

Jobs run only in the worker process (decision 020); the API writes the database and an outbox row, then returns. The code is
in `src/infra/queues/` (its `README.md` has an example); every queue, job and schedule is listed in `docs/queues.md`.

1. **Queue and processor.** Use a queue of `QUEUES` (`src/infra/queues/queue-definitions.ts`; a new queue also needs its
   section in `docs/queues.md`). Write the processor in `src/modules/<id>/jobs/`, mark it `@QueueProcessor('<queue>',
   '<job name>')`, provide it in the module and import that module in `src/worker.module.ts`. Only the worker process turns
   it into a BullMQ `Worker`.
2. **Payload: ids only.** No secrets, no personal data. The processor re-reads the state it needs. `QueuesService.add` adds
   the request id; the worker restores it while the job runs.
3. **Idempotency.** The processor must be safe to run twice: guarded updates (`UPDATE … WHERE id = $1 AND status =
   $2`), a deterministic `jobId` built by `queueJobId('order-poll', orderId)` (`order-poll-77`; BullMQ refuses `:` in ids,
   decision 020), unique idempotency keys for ledger postings.
4. **Retry policy.** The queue's attempts and exponential backoff with jitter apply to transient errors; throw
   `UnrecoverableError` for permanent ones. A supplier dispatch never retries a timed-out send (the order goes to needs
   attention, decision 025).
5. **Schedules** register with `JobSchedulerRegistry.register` in the module's `onModuleInit`; the worker upserts them on
   every boot (idempotent).
6. **Record the run:** scheduled and manual runs write `job_runs` through `JobRunsService.run` (health module, exported from
   `src/modules/health`; import `JobRunsModule`). It skips a run while another run of the same job is going on.
7. **Document it** in `docs/queues.md` (queue, job, payload, idempotency key, retry policy, schedule) and in the module
   README ("Jobs and schedules"), and add an integration test that runs the processor twice.

### Add an outbox event **(P2.4)**

A state change that needs async work (a supplier call, a webhook, an email) writes an `outbox_events` row in the same
transaction; the worker's relay turns it into a BullMQ job with the id `outbox-<event id>`.

1. In the module's `onModuleInit`, register the event type: `outboxRoutes.register({ type: 'order.status_changed', queue:
   'merchant-webhooks' })` (`OutboxRouteRegistry`, exported by `src/modules/platform`). `OutboxService.add` refuses a type
   that is not registered.
2. In the use case, inside `runInTransaction`: `await outbox.add(tx, { type, aggregateType: 'orders', aggregateId,
   payload: { orderId } })`. The payload is ids and short codes only (whole numbers, strings up to 64 characters, no
   nesting, no money); `meta.requestId` is added for you.
3. Write the consumer as a `@QueueProcessor` that receives `OutboxJobData` (`eventId`, `type`, `aggregateType`,
   `aggregateId`, `payload`, `requestId`) and re-reads the aggregate.
4. The module that registers the event type must also be loaded by the worker (`src/worker.module.ts`): the relay only
   knows the routes registered in its own process. A row whose type the worker does not know stays pending as
   `unmapped_type` (retried, never lost) until it does.
4. Add the event type to the table in `docs/queues.md` and to the module README ("Events").

## Add a cache key **(P2.4)**

The cache Redis holds cache entries, rate limits and locks only; BullMQ uses the queue Redis (decision 006). Never cache
balances, ledger rows, holds, payment or order status used for decisions, risk decisions or idempotency results
(decision 022).

1. Add a builder to `CacheKeys` (`src/infra/cache/cache-keys.ts`): keys are `gsm:{env}:{module}:{entity}:{id}[:v{n}]`, never
   built by hand, and the cache API only accepts what a builder returns.
2. Read through `CacheService.getOrLoad(key, ttlSeconds, loader, options)`: TTL always set (jitter is added), values
   under about 100 KB, negative caching only for hammered misses.
3. **Invalidate after commit:** inside a use case call `afterCommit(() => cache.del(key))`; bulk invalidation bumps a
   version key. Never delete before the transaction commits.
4. Register the key family twice: a row in `CACHE_KEY_FAMILIES` (builder name, pattern, owner, TTL, invalidation) and the
   same row in `docs/cache-keys.md`. `src/infra/cache/cache-keys.spec.ts` fails when a builder, its family or its row is
   missing. Add it to the module README ("Cache keys"). The behaviour of `getOrLoad` (lock, stale-while-revalidate,
   negative caching) is in `src/infra/cache/README.md`.

## Other infrastructure services **(P2.4)**

Each has a README next to its code with the rules and an example:

- Rate limits and the per-supplier semaphore: `src/infra/rate-limit/README.md`. Add or change a limiter in
  `limiters.ts` only; refuse with `RateLimitService.enforce` (429 `RATE_LIMITED` with `Retry-After`).
- Encryption at rest, token hashes, passwords, webhook signatures: `src/infra/crypto/README.md`. Tune the argon2 cost on the
  production host with `bun run bench:argon2`.
- Files: `src/infra/storage/README.md`. Outbound calls (suppliers, gateways, merchant webhooks): `src/infra/http/README.md`;
  never call `fetch` directly.
- Redis clients and health: `src/infra/redis/README.md`. Queues, workers and schedulers: `src/infra/queues/README.md`.
- Checks that run on every request before authentication (IP rules, maintenance, the per-IP limit), their fixed order and how
  to add one: `src/common/pipeline/README.md`. A route that changes IP rules, the access restriction or maintenance must call
  `IpRuleCache.invalidate()` or `MaintenanceService.invalidate()` in `afterCommit`.
- Tests run on **separate instances** so they never touch development data: database `gsm_test`, Redis database 1 on both
  roles and the bucket `gsm-files-test` (`DATABASE_URL_TEST`, `REDIS_QUEUE_URL_TEST`, `REDIS_CACHE_URL_TEST`,
  `S3_BUCKET_TEST`; under `NODE_ENV=test` the normal variables are ignored). `createTestApp({ withoutInfrastructure: true })`
  leaves Redis, the cache and storage out for tests that only need the HTTP pipeline.

## Add a money event **(P2.3 and the money feature)**

All money moves through `postTransaction()` in the money module, the only ledger writer (decision 024). The map defines
13 money events (`reference/gsm-map/data/system.mjs`); money is `Money` (decimal.js behind `src/common/money.ts`), never a
float (decision 011).

1. **Builder.** One pure function per event returns the journal lines exactly as the map writes them (account, debit,
   credit), in the account kinds of decision 024; a zero-amount line is dropped. No I/O, no clock.
2. **Unit test with exact numbers.** Use the map's own example amounts and assert every line, the zero-sum, and the
   rounding points (`Money.mul`, `Money.pct`, ROUND_HALF_UP at 4 decimals).
3. **Idempotency key.** Choose a deterministic key per business occurrence (for example `order_event:<event id>`): a
   replay returns the first result and posts nothing.
4. **Call it inside the caller's transaction** with the `tx` the use case owns; accounts are locked `FOR UPDATE` in id
   order by `postTransaction`, so never lock ledger rows yourself.
5. **Concurrency and replay tests:** two parallel postings on one wallet never overspend; a duplicate call posts once.
   A correction is a reversing transaction, never an update.
6. Add the scenario step assertions when the event completes a map scenario (`test/scenarios/<id>.e2e.ts`).

## The API documentation pages

- `GET /openapi.json` and `GET /docs` are map routes (public document: REST v1, the Dhru reference, webhook events).
  `GET /reference/openapi.json` and `GET /reference` are the internal reference (every route); they are documentation
  routes without contracts (`DOCUMENTATION_ROUTES` in `src/modules/platform`).
- `REFERENCE_DOCS` = `open` (default outside production), `off` (404) or `staff` (default in production). `staff`
  asks the guard provided under `REFERENCE_DOCS_GUARD` (the identity module provides `StaffSystemReadGuard`: a staff
  session with `system:read`, `401`/`403` otherwise); a deployment without any provider answers `404`.
- Only the two pages relax `default-src 'none'`: they allow the Scalar script of one pinned version (with its Subresource
  Integrity hash), their inline starter script by hash, Scalar's fonts, and requests to the same origin.
- To bump Scalar: change `SCALAR_VERSION` and `SCALAR_BUNDLE_INTEGRITY` in
  `src/modules/platform/docs/scalar-page.ts` (the comment gives the `openssl` command), run the tests, and open `/docs` and
  `/reference` in a browser to see them render.
- Generated documents never connect to infrastructure: `scripts/gen-openapi.ts` creates the Nest application without
  `init()` and refuses any network connection. **Providers must not connect in their constructors**; connect in
  `onModuleInit` and close in `onApplicationShutdown`.

## Commits

Conventional commits, one per finished feature, made by the lead after review and green checks; stage explicit paths.
Never push, force-push, skip hooks (`--no-verify`) or rewrite history. Code, comments, docs and commits are in English.
