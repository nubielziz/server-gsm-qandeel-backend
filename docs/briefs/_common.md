# Rules for every implementer brief

You implement one brief in the GSM backend. These rules apply to every brief; the brief adds the scope.

## Where you work
- Repository: `/home/saifi/gsm-project/backend` unless the brief names a worktree path (then only that path).
- The `CLAUDE.md` injected into your context belongs to the **frontend** repo (this session started there): ignore
  its workflow rules. Read `/home/saifi/gsm-project/backend/CLAUDE.md` first and follow it.
- Your Bash working directory resets to the frontend repo after every command: always run
  `cd <repo> && <command>`.
- Serena (`mcp__serena__serena_repl`) is bound to the frontend repo in this session: use it only to read frontend
  code. For backend files use Read, Grep, Glob, Edit and Write.
- Never change git state (no add, commit, checkout, stash, reset, merge), never spawn agents, never edit the frontend
  repo or anything under `reference/`.

## Sources
- Decisions: `docs/decisions/` (the brief names the ones that matter). Architecture: `docs/ARCHITECTURE.md`.
  Wire conventions: `docs/contract/ALIGNMENT.md`. Per-endpoint contract: `docs/contract/endpoints/<module>.md` and
  `docs/contract/frontend-endpoints.json` (query it with node; never read it whole). Error codes:
  `docs/contract/error-codes.md`. Map data: `docs/route-manifest.json`, `docs/slices/<module>.json` (never load
  `reference/gsm-map/data/*.mjs` whole, never open `reference/**/dist/**`).
- Library APIs: when unsure, use Context7 (load `mcp__context7__resolve-library-id` and `mcp__context7__query-docs`
  with ToolSearch). Installed: Bun 1.4.4 (runtime, `bun test`, `bun add`), NestJS 12.3 + @nestjs/platform-fastify
  (Fastify 5.12), @nestjs/swagger 12.0, @scalar/nestjs-api-reference 1.2, zod 4.6, drizzle-orm 0.45 + pg 8.23 +
  drizzle-kit 0.31, ioredis 6, bullmq 6.5, prom-client 15, @aws-sdk/client-s3 3, @node-rs/argon2 2, TypeScript 6.0
  (type-check only). Add packages with `bun add` (never npm); prefer packages without install scripts.
- Local services are running (`docker compose up -d`): Postgres 5432 (`gsm`/`gsm`, databases `gsm` and `gsm_test`),
  queue Redis 6379, cache Redis 6380, MinIO 9000 (`gsm-minio`/`gsm-minio-secret`, buckets `gsm-files`,
  `gsm-files-test`). Tests use `gsm_test` and Redis DB 1.

## Code rules
- TypeScript strict; no `any` without a one-line reason; no floats for money (decision 011).
- Every file starts with 1–3 comment lines: what it is and which decision or route group it serves.
- TSDoc on every exported symbol: one-line summary; a "Why" line (business reason, decision or map route/scenario;
  derived types such as `typeof table.$inferSelect` or `(typeof VALUES)[number]` need only the summary);
  `@param`, `@returns`, `@throws` (with error codes); side effects (DB writes, jobs, cache keys, notifications); `@see`.
  Controllers add `@route METHOD /path`. Inline comments only for rules, invariants, lock order, idempotency and
  non-obvious choices. No comments that restate the code.
- Never `import type` a class that Nest injects (Bun needs the value import for decorator metadata).
- Time (decision 031): inject `@Inject(CLOCK) private readonly clock: Clock` (`src/common/clock.ts`) and read `clock.now()` /
  `clock.nowMs()`; `Date.now()` and `new Date()` without arguments are lint errors in `src/`. SQL that decides (expiry, age,
  due dates, holds) takes the clock's time as a parameter instead of `now()`; column defaults may stay. Tests pass a `TestClock`
  (`createTestApp({ clock })`) and move it with `advance`; they never `Bun.sleep` or write a time into a row to fake age.
- `process.env` is read only in `src/config`. Modules import other modules only through their `index.ts`.
- Errors are `AppError('<CODE>')` with codes from the catalog; never invent a code without adding it to
  `docs/contract/error-codes.md` and the catalog (and say so in your report).

## Finish
- Run `bun run format`, then `bun run check` (typecheck, lint, format check, route/contract/OpenAPI checks, all tests;
  integration tests need the docker services); leave it green, or report exactly what fails and why. Every
  `eslint-disable` comment needs a reason (`-- why`). After changing a route contract, run `bun run docs:openapi` and
  include the regenerated `docs/contract/openapi*.json`; after removing keys from `test/contract/pending.ts`, run
  `bun run coverage:build` (`docs/COVERAGE.md`).
- Never run `docker compose` from a worktree (it would re-create the shared containers with the worktree's paths).
- Reply in at most 200 words: files created/changed (by folder), what is covered, tests added, open questions,
  anything you could not do (BLOCKED: reason).
