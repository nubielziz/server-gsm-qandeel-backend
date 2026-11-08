# Contract tests (design)

How CI proves the backend answers exactly what the map defines and the frontend expects (decision 009). The tests
live in `test/contract/` and run in `bun run check`; a red contract test blocks the commit.

## Inputs

| Input | Produced by | What it is |
|---|---|---|
| `docs/route-manifest.json` | `scripts/build-route-manifest.mjs` (`--check` in CI) | every map row expanded to endpoints (all 9 surfaces) |
| `docs/contract/frontend-endpoints.json` | `scripts/extract-frontend-contract.mjs` (`--check` in CI) | the frontend's request/response shapes for its 269 `@route` functions |
| `test/contract/fixtures/frontend/*.json` | `bun run contract:harvest` (`scripts/contract-harvest.mjs`, see below) | one example response per console GET route and per mutation that answers a body, from the frontend mock layer |
| contract registry | `src/common/contract` (imported) | every backend `defineRoute()`, Dhru action, supplier call and event schema |
| `docs/contract/error-codes.md` + `src/common/errors/catalog.ts` | hand-written | the error catalog |
| `test/contract/allowlist.ts` | hand-written | accepted deviations, each naming its `docs/contract/MISMATCHES.md` id |

## Tests

1. **`route-parity.test.ts`**
   - HTTP: the registry's keys equal the manifest's `kind: http` keys (all surfaces), and the Fastify router serves
     exactly those routes plus the documentation routes (no route without a contract, no contract without a route).
   - Dhru actions = manifest `DHRU …` keys; supplier calls (`defineSupplierCall`, the calls the supplier client
     makes) = `SUPPLIER …`; outgoing event schemas = `EVENT …`.
   - Every key in `frontend-endpoints.json` is a backend route.
2. **`shape-parity.test.ts`**: for each frontend endpoint, compare its shapes with the backend JSON Schema
   (zod → JSON Schema 2020-12) of the same route:
   - Response (2xx): every property the frontend reads as required is required in the backend schema (or has a
     default); types match (`string`, `number`, `boolean`, arrays, objects, records); `Money` ↔ money pattern,
     `IsoDateTime` ↔ `date-time`, `Id` ↔ integer, `DateOnly` ↔ `date` (in requests a plain console string fits a
     backend `DateOnly`: the console has no date-only type); the backend enum ⊆ the frontend enum (the backend never sends a
     value the frontend does not know, which includes `LedgerTransaction.refType`: a stored `client` reaches the wire as
     `system`, so the wire set stays inside the console's 8 words); a nullable backend field must be nullable in the frontend; `ListResult<T>` ↔
     array of `T` + `x-total-count`. Extra backend fields are allowed and reported.
   - Request: every field the frontend sends is accepted with a compatible type; every field the backend requires is
     sent by the frontend (required in its type).
   - Success status: the backend's declared 2xx status equals what the frontend expects (204 = no body).
   - Fixtures: each harvested fixture validates against the backend response schema.
   - OpenAPI: every example in `docs/contract/openapi.json` validates against its schema.
3. **`error-parity.test.ts`**: the catalog equals `error-codes.md` (code, status; titles live in the catalog only); every code the frontend
   references exists in the catalog with the status the frontend expects; codes the frontend never handles are
   printed as a report (not a failure).
4. **`docs-drift`** (CI script, not a test file): `routes:check`, `extract-frontend-contract --check` and an
   OpenAPI regeneration diff: the committed documents must match.

The comparator works on two normalised trees (frontend shape JSON, backend JSON Schema) and reports a path per
difference (`GET /admin/orders → data[].status: backend enum value "needs_attention" unknown to the frontend`). A
deviation passes only through an allowlist entry `{ route, path, rule, mismatch: 'B12' }`.

## Fixture harvest

The frontend mock layer (MSW handlers + the demo seed) is the reference behaviour. The harvest runs those handlers
in Node from a config that lives in this repo (the frontend repo stays untouched, its caches redirected here), calls
every console GET route once with representative parameters (and every mutation that answers a body), and writes
`test/contract/fixtures/frontend/<METHOD>_<path>.json` (`{ status, headers: { x-total-count? }, body }`). It runs on
demand (`bun run contract:harvest`) and when the frontend changes; fixtures are committed so CI does not need the
frontend's dependencies. Exact entry points and env shims: see `ALIGNMENT.md` § 8; the workflow is in
`test/contract/README.md`.

## Scope per phase

- Phase 2 (`contract-tests` feature): comparator, the four tests, harvest tool, allowlist, CI wiring. Routes not
  built yet are listed in `test/contract/pending.ts` (generated from the manifest, shrinking as features land).
- Phase 3: each feature removes its routes from `pending.ts`; its review fails if any of them remains.
- Phase 4: `pending.ts` is empty; `COVERAGE.md` is generated from the same registry.
