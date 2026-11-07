# Contract tests (decision 009)

These tests keep the backend, the map and the frontend console telling the same story. They run inside `bun test`, so
`bun run check` fails when they do. The design is `docs/contract/TESTS.md`; this file is the workflow.

| Test file | What it proves | Typical failure and fix |
|---|---|---|
| `route-parity.test.ts` | The registry (`defineRoute`, `defineEvent`) equals the route manifest minus `pending.ts`; Fastify serves exactly the registry plus `DOCUMENTATION_ROUTES`; every route the console calls is built or pending. | `X is built but not expected`: the key is not in the manifest (typo) or the route is still listed in `pending.ts`. `X is expected but not built`: you removed a key from `pending.ts` without defining the contract. |
| `shape-parity.test.ts` | For every built route the console calls: the response, request and success status match what the console reads and sends; the harvested fixture satisfies the response schema. Deviations only through `allowlist.ts`. | Read the line: `GET /admin/orders [response] data[].status: backend value "x" unknown to the frontend (enum)`. Fix the contract, or record a decision in `docs/contract/MISMATCHES.md` and add an allowlist entry. |
| `error-parity.test.ts` | The error catalog equals `docs/contract/error-codes.md` (code, status); every code the console references exists with the status it expects; backend-only codes are printed. | A code was added to one side only. Add it to `error-codes.md` (via `lead-decisions.json`) and `src/common/errors/catalog.ts`. |
| `openapi-examples.test.ts` | Every example in `docs/contract/openapi.json` and `openapi.public.json` validates against the schema next to it (ajv, draft 2020-12, formats). | Fix the `examples` of the contract, then `bun run docs:openapi`. |
| `fixtures.test.ts` | The harvest covers every console GET route; each file belongs to one route; the mock answers obey the console's own types. | Re-run `bun run contract:harvest` after the console changed. |
| `lib/*.test.ts` | Unit tests of the comparator (every rule), of the route comparison and of the allowlist logic. | A rule changed: update the test that names it. |

The tests read the application through a child process (`lib/dump-app.ts`, snapshot in `lib/snapshot.ts`): bun runs all
test files in one process and other tests register fixture contracts (`/t/...`), so the child sees exactly the contracts
the application defines. It needs the test database like every integration test (`docker compose up -d`).

## What is compared (`lib/compare.ts`, route level in `lib/compare-http.ts`)

The frontend side is `docs/contract/frontend-endpoints.json` (its TypeScript types as JSON shapes); the backend side is
the zod contract as JSON Schema 2020-12 (`x-gsm-alias` marks `Money`, `Decimal`, `IsoDateTime`, `Id`). Both become one
type tree and are compared in the direction the data flows: a response is produced by the backend, a request by the
frontend. Every difference has a path (`data[].status`, `checks.*`, `body.roleId`) and a rule:

| Rule | Fires when |
|---|---|
| `required` | A field the consumer requires may be omitted by the producer (response: the console reads it as required, the schema makes it optional; request: the backend requires it, the console may omit it). A `default` makes a backend response field safe. |
| `missing-field` | A field is not declared on the other side (response: the console reads a field the backend never sends; request: the console sends a field the backend does not declare, or never sends one the backend requires). |
| `extra-field` | The backend sends a field the console type does not declare. Reported, never failing. |
| `type`, `array`, `record` | Different kinds (string vs number, object vs array, a free-form map vs fixed fields). |
| `alias` | `Money`, `Decimal`, `IsoDateTime` or `Id` on one side only (a `Money` is accepted where a `Decimal` is expected, an integer where an `Id` is). `DateOnly` is the exception: the console has no date-only type (ALIGNMENT § 1), so its `YYYY-MM-DD` params are plain strings and a plain string fits a backend `DateOnly` (an `IsoDateTime` does not). |
| `enum` | A backend value the console does not know (response), a console value the backend does not accept (request), or a free string where the other side knows a few values. |
| `nullable` | `null` is possible on the producing side and not accepted by the consuming side. |
| `unconstrained` | The backend schema accepts anything (`z.unknown()`, `z.date()`) where the console has a type, so it cannot be proven to fit. |
| `list-result` | The console reads `ListResult<T>` (an array plus `x-total-count`) and the route is not a `listQuery()` route. |
| `status` | The declared success status differs from `successStatus` in `docs/contract/extraction/*.json` (`void` is 204). |
| `fixture` | A harvested fixture does not satisfy the response schema. |

Path and query parameters are text on the wire, so numbers, booleans and strings are interchangeable there and enum
values are compared as strings. The list dialect (`_start`, `_end`, `_sort`, filters) is not compared field by field: the
`listQuery()` contract owns it. Error codes per route are not compared (the extraction mixes recorded and proposed codes).

## Building a route (the Phase 3 loop)

1. Write the contract as usual (`CONTRIBUTING.md`).
2. Delete the route's key from `pending.ts` (every endpoint of the map is listed there under its module). Dhru actions,
   supplier calls and events are keys too (`DHRU …`, `SUPPLIER …`, `EVENT …`); register them in `built` in
   `route-parity.test.ts` once their registry exists (Dhru actions and supplier calls have none yet).
3. Run `bun test test/contract`. If the console calls the route, `shape-parity` now compares it with the console's types and
   with the fixture of the route; fix what it reports.
4. The review fails if a built route is still in `pending.ts`.

## The allowlist (`allowlist.ts`)

Add an entry only when the lead decided to deviate and the decision is a B-entry in `docs/contract/MISMATCHES.md`:

```ts
{ route: 'GET /admin/orders', part: 'response', path: 'data[].status', rule: 'enum', mismatch: 'B16',
  reason: 'The backend sends needs_attention until the console learns the status.' }
```

`part` is `response` (default), `request`, `status` or `fixture`; `path` and `rule` are copied from the failure line. The
tests fail when the B-id does not exist, when the rule is unknown, when the reason is empty, and when an entry matches no
real deviation any more (delete it as soon as the deviation is fixed).

## The fixtures and the harvest

`fixtures/frontend/<METHOD>_<path>.json` holds `{ status, headers, body }`: what the console's mock layer (MSW handlers and
the demo seed) answers for each GET route and for every mutation that answers a body. They are committed, so `bun test`
never needs the frontend's dependencies. Values are not compared, only shapes and formats.

```bash
bun run contract:harvest      # needs `npm ci` once in ../frontend-admin (FRONTEND_DIR to override); Node >= 22.12
```

- It runs the frontend's own Vitest under Node with `harvest/vitest.config.mjs` (root, cache and output in this repository,
  alias `@` to the frontend's `src`). The script fails if `git status` of the frontend changed.
- `harvest/harvest.vitest.mjs` signs in as the Owner (demo password and code), reads every GET route, then runs the
  mutations on a fresh seed. The clock is frozen and `Math.random` seeded, so a second run writes identical files.
- Ids come from the lists the harvest reads first; bodies are built from the console's own types (required fields). Where
  the mock needs something specific (a pending payment, a valid metric), `harvest/plan.mjs` has an override. A mutation the
  mock refuses is printed as a `gap:` line and writes no fixture; a GET route without a fixture fails the run unless
  `harvest/known-gaps.json` explains why (`GET /admin/queues` has no mock: the console only links to it).
- Re-run it when the console's mock layer or `frontend-endpoints.json` changes (`bun run contract:extract` first).

## Known limits

- `GET /admin/permissions`: the console accepts `string[]` or `Permission[]` and normalises, so the extracted return type is
  `Permission[]` while ALIGNMENT § 4 fixes the wire form as `string[]`. The feature that builds the route needs an
  allowlist entry with a B-id (or an extraction fix).
- `GET /admin/files/:id` is documented as `302`: `defineRoute` takes `success: { status: 302 }` (a bodiless GET; the handler sets
  `Location`, the response interceptor refuses a 302 without it) and `compareResponse` skips the body of a redirect, so the route needs
  no allowlist entry (built by feature 5, MISMATCHES B154).
- `GET /admin/reports/payments`: the console function takes `{ start, end, sort, order }` and sends them as `_start`,
  `_end`, `_sort`, `_order`; the comparator sees the function's names, so a correct list contract reports
  `missing-field@query.start` etc. until the feature maps those names (or allowlists them with a B-id).
- Object unions: when no variant matches, the report is written against the first object variant, so a drift in
  another variant can read like several unrelated findings (for example `GET /admin/dashboard` `attention[]`).
- Fixture validation uses the backend output schemas, which forbid unknown properties: a field only the mock sends
  (not in the console type) fails it. Fields outside the console type are not part of the contract: relax the check for
  them instead of adding them to the backend.
- Mock answers can be less complete than the real API (they skip most server rules); a fixture shows a valid shape, not
  every shape.
