# Observability (`src/infra/observability`)

Reports unexpected server errors to Sentry (decision 015, feature 24D). Metrics, health and logging live in their own folders.

| What | Where |
| --- | --- |
| `ErrorReporter`: `capture(error, context)`, `flush()`, `enabled`; starts the SDK in `onModuleInit` only when `SENTRY_DSN` is set, closes it on shutdown | `error-reporter.ts` |
| `scrubEvent`, `scrubText`: what may leave the process (no request, user, breadcrumbs, extra data or host name; e-mail addresses and 12 to 19 digit runs masked) | `scrub.ts` |
| `ObservabilityModule`: global, imported by `ErrorsModule` (API) and `QueueWorkersModule` (worker) | `observability.module.ts` |

## Behaviour

- Without `SENTRY_DSN` nothing is initialised: no network, no timers, `capture` returns at once.
- Two call sites: the exception filter's server-fault branch (an unhandled throw or an `INTERNAL_ERROR`; deliberate catalog 5xx
  answers and planned maintenance are not sent) and the worker's final job failure.
- Every capture carries tags: `process` (`api` or `worker`) and, where known, `request_id`, `surface`, `route`, `method`, `code`,
  `queue`, `job`.
- Tests replace the transport through `ERROR_REPORTER_OPTIONS` and read the events from memory; nothing in the suite sends.
- Every capture is sanitised (decision 054): a database failure is reported as its SQLSTATE, table, constraint and a fixed sentence,
  never the statement or its values (`sanitizeError`).
- The scrubber reads at most 1,320 characters of any text (the 1,000 it keeps plus room for an address or a digit run that the cut
  splits), cuts any database statement first, and its e-mail pattern is bounded, so no input makes it work long.
