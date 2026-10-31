# Phase 3 feature recipe (every module brief follows it)

A Phase 3 brief names its routes, tables, scenarios and frontend features; this file says how to build them and when
they are done. Read `_common.md` first.

## Inputs, in this order
1. The brief: routes (manifest keys), out-of-scope list, decisions that matter, user-answered rules.
2. `docs/contract/endpoints/<module>.md`: per route the map rule, the frontend function and types, query/request/
   response semantics, errors, B-ids and the mock that answers it today.
3. `docs/contract/frontend-endpoints.json`: the exact request/response shapes (query with node, never read whole).
4. `docs/contract/RULES.md` for the brief's frontend features; `docs/contract/ANSWERS.md` for their questions.
5. `docs/slices/<module>.json`: owned tables, foreign tables (reach them only through their module's public
   service), scenario steps touching the module.
6. The frontend mock of each route (read-only): its seed mapping, list filters and refusals are the reference
   behaviour where the docs above are silent.

## Build order inside a feature
1. **Contracts** (`contracts/`): one `defineRoute` per route, shapes identical to the frontend types (camelCase,
   Money/IsoDateTime/Id aliases, enums ⊆ frontend), list contracts with their whitelisted filters, sorts and search
   fields, every error code the route can answer. Non-admin routes follow ALIGNMENT § 7.
2. **Repository** (`infra/`): Drizzle queries on the module's own tables only; list queries translate the parsed
   simple-rest query (filters, sort, range, search) to SQL with an exact `COUNT`; no N+1 (batch joins).
3. **Domain** (`domain/`): pure functions for rules, transitions, prices, thresholds, ledger lines; unit tests.
4. **Application** (`application/`): one use case per action, one DB transaction (`runInTransaction`), ownership and
   guard checks, `AuditService.record` for admin writes, outbox rows for async work, `afterCommit` cache
   invalidation, other modules only through their public services (passing `tx`).
5. **Controller** (`controllers/`): thin; `@Route(contract)`; maps the principal and inputs to the use case.
6. **Jobs and schedules** (`jobs/`): idempotent processors (ids only, re-read state, guarded transitions,
   deterministic job ids), retry policy, `job_runs` for scheduled runs; document each in `docs/queues.md`.
7. **Cache keys**: through `CacheKeys`, listed in `docs/cache-keys.md`, invalidated after commit; never cache money
   or decision-making state.
8. **Seed**: extend `scripts/seed/<module>.ts` so the frontend mock data appears through the real API (same ids,
   names and amounts where practical).
9. **Docs**: TSDoc on every exported symbol; the module `README.md` (routes, tables, jobs, events, cache keys,
   permissions, scenarios) updated; `test/contract/pending.ts` loses the built routes.

## Tests
- Unit: every domain function (each money event with the map's numbers, each transition, each price/threshold rule).
- Integration (real Postgres + Redis, `inject`): every route's success and each documented refusal (status + code +
  field), permission refusal, list filters/sorts/search/ranges with `x-total-count`, concurrency where money or
  stock moves (parallel requests never overspend or double-post), idempotency replays.
- Scenarios: when the feature completes a map scenario, `test/scenarios/<id>.e2e.ts` walks every step and asserts the
  tables and statuses the step names.
- Contract: the parity tests compare the new routes automatically once they leave `pending.ts`; they must pass
  without new allowlist entries unless a B-entry justifies one.

## Definition of done (mission § 12)
Routes match the manifest and the frontend contract exactly; map rules and scenario steps enforced server-side;
transactions, locking and idempotency correct; cache keys registered and invalidated; jobs idempotent with a
documented retry policy; OpenAPI complete with examples and errors (visible in Scalar); TSDoc on every exported
symbol and an updated module README; `bun run check` green; Opus review passed; committed by the lead;
`PROGRESS.md` updated.
