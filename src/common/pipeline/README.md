# Request pipeline (`src/common/pipeline`)

The checks that run on every request **before authentication** (decision 018, `docs/ARCHITECTURE.md` § 3). They are Fastify
hooks, cheap and independent of the Nest guards, and they run in one explicit order:

| # | Stage (`PIPELINE_STAGES`) | Owner                                                      | Refusal                                              |
| - | ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 0 | CORS preflight, request id | Nest's Fastify adapter, `registerRequestIdHooks`          | (answered first; a refusal below still has CORS headers) |
| 1 | `ip-rules`                | identity: `src/modules/identity/security/ip-rules/`        | `403 IP_NOT_ALLOWED`                                 |
| 2 | `maintenance`             | platform: `src/modules/platform/maintenance/`              | `503 MAINTENANCE` (Dhru envelope on `/api/index.php`) |
| 3 | `rate-limit`              | rate-limit infrastructure: `src/infra/rate-limit/public-ip-limit.hook.ts` | `429 RATE_LIMITED` with `Retry-After` |

Authentication, CSRF and permissions are Nest guards and run after these.

## How it fits together

- `RequestPipeline` (`request-pipeline.ts`, provided by the global `PipelineModule`, imported by the API's root module only)
  holds one handler per stage and phase. A module registers its handler in `onModuleInit`:
  `pipeline.register('ip-rules', (request) => this.handle(request))`. A handler returns to let the request pass and throws an
  `AppError` to refuse it.
- `configureApp` (`src/app.bootstrap.ts`) calls `pipeline.install(fastify)` **after** CORS, the request id, cookies and helmet
  are registered. Fastify runs `onRequest` hooks in the order they were added, so the pipeline runs after them and a refusal
  carries the CORS and security headers. `install` adds one hook per phase that walks `PIPELINE_STAGES` in order; handlers are
  looked up per request, so it does not matter in which order the modules start.
- A refusal is answered by `ProblemExceptionFilter.handle` (problem+json, `api_errors_total`, the access log, and the surface's
  own envelope through `ErrorFormatterRegistry`: Dhru, decision 026). The registry then returns the reply so Fastify stops.
- Two phases exist: `onRequest` (before the body is read; almost everything) and `preValidation` (after the body is parsed,
  still before any guard). Only maintenance uses the second, to see the Dhru `action` field.
- A stage without a handler is skipped; `onApplicationBootstrap` logs a warning naming it (a test app without Redis has none).
  The real application has all three, which `test/integration/pipeline-hooks.test.ts` checks.

## Deciding by path: `requestPath`

Fastify's router decodes percent-escapes before it matches (`/%61dmin/staff` reaches `/admin/staff`), so a hook must not judge
the raw request target. `requestPath(request)` returns the **route template** of a matched route (`/admin/staff/:id`) and the
decoded path of an unknown route. All three stages use it.

## Adding a stage

1. Add its name to `PIPELINE_STAGES` at the position it must run (and update `request-pipeline.spec.ts`, which pins the list).
2. Write the handler next to the code that owns the rule, as an `@Injectable()` that registers itself in `onModuleInit`; put it
   in a small module that the API's root module (or its domain module) imports.
3. Decide its **failure policy** and write it in the class comment: security rules fail closed (IP rules answer
   `503 DATABASE_UNAVAILABLE` when they cannot be read), courtesy rules fail open (maintenance lets the request through).
4. Make `test/support/app.ts` (`createTestApp`, `withoutInfrastructure` / `withoutDatabase`) replace the new module when it needs
   Redis or Postgres, so the tests that leave them out still build.
5. Add integration tests to `test/integration/pipeline-hooks.test.ts`: the order against the other stages, the refusal's
   headers, and "before authentication" (the sample guard `TestAuthGuard` answers 401 to every `/t/` route).

## Shared helpers

`src/common/ip-address.ts` parses addresses and networks (IPv4, IPv6, CIDR, IPv4-mapped IPv6) and builds the rate-limit key
(IPv4 address, or the /64 network of an IPv6 address); `src/common/short-memo.ts` keeps a loaded value for a second and serves the
last good one when a reload fails. The client address is `request.ip`, which Fastify derives from the socket or, with
`TRUST_PROXY`, from the proxies you trust.
