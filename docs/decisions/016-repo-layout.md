# 016: Repository layout and the two processes

Status: accepted, 2026-10-31.

**Decision.** One package (no monorepo): one codebase, two entry points.
```
src/main.ts, app.module.ts          API process (HTTP only)
src/worker.ts, worker.module.ts     worker process (BullMQ processors, job schedulers, outbox relay, /metrics)
src/config/                         env schema and AppConfig (decision 013)
src/common/                         contract layer, problem+json + error catalog, guards, interceptors, money, time, crypto
src/infra/                          db (Drizzle client, schema index, migrator), redis (two clients), queues, storage, http, cache
src/modules/<id>/                   one module per map domain (scripts/module-map.mjs):
  <id>.module.ts, README.md, index.ts (public API), contracts/, controllers/, application/, domain/, infra/ (repositories,
  external clients), db/schema.ts (owned tables), jobs/ (processors, used by the worker only)
drizzle/                            SQL migrations (drizzle-kit) and meta
test/                               integration, scenarios, contract, dhru, support
```
- Modules import other modules only through `src/modules/<id>/index.ts` (ESLint boundary rule); a module's tables are
  touched only by its own repositories. Cross-module foreign keys stay in the database for integrity.
- The worker imports the same domain modules plus `WorkerModule`, which registers the processors and schedulers the
  modules export. The API never starts BullMQ workers.

**Consequences.** Shared code is shared by import, not by packages; one `bun install`, one lockfile, one CI.
