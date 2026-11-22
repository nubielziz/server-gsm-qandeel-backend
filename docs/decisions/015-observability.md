# 015: Metrics, health and tracing

Status: accepted, 2026-10-31.

**Decision.**
- Metrics: prom-client, one registry per process. Default process metrics; `http_request_duration_seconds`
  (labels: method, route template, status, and the surface since feature 9, so System health can read the latency of one
  surface); BullMQ gauges per queue and state, read on scrape; business counters
  (orders placed/completed/rejected by channel, ledger transactions by kind, supplier calls by supplier, action and
  outcome with a duration histogram, webhook deliveries by outcome, cache hits/misses by key family). The API serves
  `GET /metrics`; the worker serves its own `/metrics` on `WORKER_METRICS_PORT`. Access (map rule "internal network
  or token"): with `METRICS_TOKEN` set the bearer token is required from every caller; without it only loopback and
  private addresses are allowed, and never a request carrying forwarding headers. Production requires
  `METRICS_TOKEN` (a proxy that adds no forwarding header would make public traffic look internal); Prometheus
  scrapes with it.
- Health: `GET /health` checks Postgres and both Redis roles and always answers 200 JSON
  `{ status: ok | degraded | down, checks }` (the console reads any non-2xx as "API unreachable");
  `GET /health?strict=1` answers 503 when the status is `down` (a critical dependency, Postgres, failed), for load
  balancers and readiness probes; `degraded` (cache Redis, queue Redis or storage down) stays 200 because the API still
  serves without them.
- History: a Prometheus server (`PROMETHEUS_URL`; added to compose) scrapes both processes; the System health
  metrics and errors routes query it with PromQL (`query_range`), time-boxed to 2 s; unset or unreachable →
  `503 MONITORING_UNAVAILABLE`. A worker job writes a per-minute health snapshot to the cache Redis, which
  `GET /admin/system/health` serves even during a Postgres outage (status `unknown` while monitoring is missing).
- Errors: every problem+json answer increments `api_errors_total{surface,method,route,status,code}`; a cache-Redis hash
  keeps first seen, last seen and the last request id per (route, code) for the System health errors table. Sentry
  (optional, `SENTRY_DSN`) receives unexpected 5xx only and supplies links.
- Sentry wiring (feature 24D, 2026-11-10): the official `@sentry/bun` SDK, errors only. `ErrorReporter`
  (`src/infra/observability`) is a no-op, and the SDK is never initialised, without `SENTRY_DSN` (no network, no timers: tests,
  `docs:openapi` and development stay offline). With a DSN it initialises with no default integrations, no tracing,
  `dataCollection` switched off (user info, cookies, headers, bodies, query parameters, local variables; SDK 11's replacement of `sendDefaultPii`), `release` = `<APP_VERSION>+<GIT_SHA>` and a `beforeSend` scrubber that removes request data, user,
  breadcrumbs, extra data and the host name and masks e-mail addresses and 12 to 19 digit runs in messages (the masks of decision
  012). Two call sites only: the exception filter's server-fault branch (an unhandled throw or `INTERNAL_ERROR`; a deliberate
  catalog 5xx such as `FX_PROVIDER_DOWN` or a planned `MAINTENANCE` is not sent) and the worker's final job failure (after the same
  throttle as its log line). `@sentry/nestjs` is not used (it is built on Node preload hooks). A reporter failure is logged at
  warn level and never reaches the caller. The System health `sentryUrl` stays `null` (B168).
- Tracing: OpenTelemetry is not added now; request-id correlation (decision 012) covers API → outbox → worker →
  supplier. Adding OTel later needs no code change outside `src/infra`.

**Consequences.** System health routes read live BullMQ counts and these metrics; Grafana/Prometheus can scrape both
processes.

**Amendment (feature 44, decision 054).** Error reports carry the sanitised error; the scrubber reads at most 1,320 characters
of any text.
