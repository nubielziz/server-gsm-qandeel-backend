# Contract layer (decision 008)

One zod contract per endpoint drives request validation, handler types, response serialisation and the OpenAPI
metadata. The contract's key is the manifest key (`docs/route-manifest.json`), so the contract tests (decision 009)
can compare the registry with the map and with the frontend's types.

```
defineRoute({ key: 'GET /admin/staff/:id', ... })   // checks the definition, freezes it, registers it
@Route(contract)                                    // on the controller method: path, status, pipes, docs
```

## Write a route

```ts
// modules/identity/contracts/staff.contracts.ts
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';

const StaffRow = z.object({ id: zId, name: z.string(), email: z.string(), createdAt: zIsoDateTime });

export const listStaff = defineRoute({
  key: 'GET /admin/staff',
  summary: 'List staff',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:read',
  query: listQuery({
    sorts: ['name', 'createdAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { status: { type: 'enum', values: ['active', 'invited', 'suspended'] }, 'role.id': { type: 'id' } },
    search: ['name', 'email'],
  }),
  success: { status: 200, schema: StaffRow }, // for a list: the schema of ONE row
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
});

export const showStaff = defineRoute({
  key: 'GET /admin/staff/:id',
  summary: 'Show a staff member',
  tags: ['staff'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: StaffRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
});
```

```ts
// modules/identity/controllers/staff.controller.ts
@Controller() // no prefix: the path comes from the contract key
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Route(listStaff)
  list(@Query() query: QueryOf<typeof listStaff>): Promise<ResultOf<typeof listStaff>> {
    return this.staff.list(query); // returns { rows, total }
  }

  @Route(showStaff)
  show(@Param() params: ParamsOf<typeof showStaff>): Promise<ResultOf<typeof showStaff>> {
    return this.staff.show(params.id); // throws new AppError('NOT_FOUND', { detail: '...' })
  }
}
```

Rules the layer enforces at boot (`defineRoute` throws): the key is `METHOD /path` with `:name` parameters; `params`
declares exactly the path parameters; header names are lower case; a GET has no body; `permission` exists for
`staff-permission` routes (the permission the role needs) and `api-key` routes (the scope the key must list, one action, no `area:*`) and for
no other; `surface` matches the path prefix; the success shape is a `schema` or a
`contentType` (never both, neither for 204); every `errors` entry is a catalog code (`docs/contract/error-codes.md`);
`examples` satisfy their schemas.

## Access, sessions, audit and CSRF (decision 018)

`access` says how a route authenticates; the guard dispatcher in the identity module (`src/modules/identity/security`) reads
it from the contract (`getContract(handler)`) and runs the guard of that kind. Three optional fields refine it:

| Field | Default | Meaning |
|---|---|---|
| `sessionStages` | `['active']` | The `sessions.stage` values a **session** route accepts (`staff-session`, `staff-permission`, `merchant-session`, `customer-session`). A pending session is refused with `401` everywhere else, so the sign-in routes name theirs: `2fa` accepts `['pending_totp', 'pending_totp_setup']`, `2fa/setup` `['pending_totp_setup']`, the forced password change `['pending_password']`, `logout` all four. A `staff-permission` route can only be `['active']`. |
| `audit` | `true` | Every staff mutation (an admin route that is not a GET) must write an `audit_logs` row with `AuditService.record(tx, ...)`; otherwise the request fails with a `500` in development and tests (and logs an error in production). `audit: false` opts out for routes that write none (the sign-in steps); the description must say why. |
| `csrf` | `true` | A mutation that authenticates with a session cookie always needs a matching `X-CSRF-Token` (`403 CSRF_FAILED`, never signs out). `csrf: false` is for routes that have no session to bind a token to (sign-in, password set by emailed token): they are refused unless the `Origin` header is in `CORS_ORIGINS` (on `/admin` and `/client`). It is refused on session routes. The field is declarative: the CSRF guard picks the token check or the Origin check by whether a session authenticated the request, so a session-less mutation gets the Origin check with or without it; set it anyway so the contract says what the route expects. |

```ts
export const verifyTwoFactor = defineRoute({
  key: 'POST /admin/auth/2fa',
  summary: 'Complete the sign-in with a TOTP code',
  description: 'The last sign-in step. It writes no audit row: the sign-in is recorded by the session itself.',
  tags: ['auth'],
  surface: 'admin',
  access: 'staff-session',
  sessionStages: ['pending_totp', 'pending_totp_setup'],
  audit: false,
  body: z.object({ code: z.string().regex(/^\d{6}$/) }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED', 'VALIDATION_FAILED', 'RATE_LIMITED'],
});
```

A route without a contract is refused by the dispatcher (`DOCUMENTATION_ROUTES` keep their own guard). The OpenAPI operation of a
session route carries `x-gsm-session-stages`, and that of a staff mutation `x-gsm-audit`.

## What happens to a request

1. **Validation** (a guard, then the pipe): every input the contract declares (`params`, `query`, `headers`, `body`) is
   parsed before the handler runs, even when the handler does not read it. A failure is `422 VALIDATION_FAILED`
   with one `errors[]` item per issue, `field` = dotted path equal to the request key (`lines.0.imei`; `body`, `query`,
   `params` or `headers` when the whole input is wrong). Read inputs with `@Param()`, `@Query()`, `@Body()` and
   `@ContractHeaders()` **without a key**; the handler receives the parsed value (path ids become numbers).
2. **Handler** returns the data; throw `new AppError('CODE', { detail, errors })` for business refusals.
3. **Response interceptor**: the result is parsed with `success.schema` (unknown keys are stripped, so nothing leaks
   by accident). A mismatch is logged and answered `500 RESPONSE_CONTRACT_VIOLATION`. `204` sends no body. A
   `contentType` route (CSV, PDF, HTML, text) is sent as the handler produced it with that media type.
4. **Lists**: a `listQuery()` route returns `{ rows, total }`; the answer is the array of rows plus `x-total-count`
   (rows matching the filters before the range). Repositories append the primary key last so the order is stable.

## Lists (ALIGNMENT § 2)

`listQuery({ sorts, defaultSort, filters, search, maxPage, extra })` parses `_start`/`_end` (default 0-25, at most
1000 rows), `_sort`/`_order`, `q` and field filters. A repeated key is IN; `_ne` repeated is NOT IN; `_gte _lte _gt
_lt _like` are single values. Filter types: `string`, `enum`, `boolean`, `number`, `decimal` (kept as an exact
string), `id`, `datetime` (parsed to `Date`). Anything not whitelisted (sort field, filter, operator, `q` without
`search`) is a 422 naming the parameter. `extra` adds endpoint parameters that are not part of the dialect (`from`,
`to`, `open`) with their own zod schemas. The handler gets `{ range, sort, filters, search, extra }`. The parsed values
are raw user text: repositories bind them as SQL parameters and escape `%` and `_` in `q` and `_like` values.

## Another status with the same body

Nest 12 writes the route status after the handler returns, so a handler cannot change it. Declare the extra status in
`success.alsoStatuses` and `throw respondWith(contract, 503, body)`; the exception filter sends it (used by
`GET /health?strict=1`). It is not an error: no problem+json, no `api_errors_total`.

## Shared types

`zMoney` (4-decimal string), `zDecimal`, `zIsoDateTime` (UTC, milliseconds, `Z`), `zId`/`zIdParam` (positive integer
up to 2^53 - 1; text in a path), `zDateOnly`, `zJsonObject`. Each carries the JSON Schema extension `x-gsm-alias`
(`Money`, `Decimal`, `IsoDateTime`, `Id`, `DateOnly`, `JsonObject`). Calculate with `Money` (`src/common/money.ts`),
never with numbers.

## Registry and documentation

- `contractRegistry` lists every contract by key (`get`, `has`, `all`, `keys`). Keys are unique per process; tests
  use their own keys (`/t/...`) or `contractRegistry.clear()` only in isolated runs.
- `getContract(handler)` returns the contract of a handler, for guards that need `access`/`permission`/`surface`.
- `@Route` adds the `@nestjs/swagger` metadata: operation id (`getAdminStaffById`), tags, parameters (list dialect
  included), request body with example, the success response, one `application/problem+json` response per error status
  listing its codes with an example each, `x-total-count`, `x-request-id`, security by `access`
  (`SECURITY_SCHEME`), and `x-gsm-key`, `x-gsm-access`, `x-gsm-surface`, `x-gsm-permission`, `x-gsm-session-stages` (session
  routes) and `x-gsm-audit` (staff mutations).
- The platform module turns that metadata into two documents (`src/modules/platform/docs`, decision 017):
  `docs/contract/openapi.json` (every route) and `openapi.public.json` (surfaces `v1` and `dhru`, plus the outgoing
  events as `webhooks`). It passes `autoTagControllers: false`, so a route's `tags` are the ones in its contract (use
  the map group; tags are grouped by surface and prefixed with it when two surfaces share one), and it defines every
  security scheme named in `SECURITY_SCHEME`. Regenerate with `bun run docs:openapi`; CI runs the `--check`.
- `defineEvent({ key: 'EVENT order.status_changed', summary, payload, example })` registers an outgoing webhook event in
  `eventRegistry` (same rules as `defineRoute`); the public document lists it under `webhooks`.
- Do not chain `.meta()`/`.describe()` on the result of `listQuery()`: zod clones the schema and drops its list marker.

## Testing a route

`test/support/app.ts` builds the real application (`AppModule` plus the bootstrap of `main.ts`) on Fastify `inject`;
`test/support/routes.ts` shows one contract per behaviour. Unit-test pure logic next to the code (`*.spec.ts`).
