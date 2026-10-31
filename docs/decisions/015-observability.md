# 015: Metrics, health and tracing

Status: accepted, 2026-10-31.

**Decision.**
- Metrics: prom-client, one registry per process. Default process metrics; `http_request_duration_seconds`
  (labels: method, route template, status); BullMQ gauges per queue and state, read on scrape; business counters
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
- Tracing: OpenTelemetry is not added now; request-id correlation (decision 012) covers API → outbox → worker →
  supplier. Adding OTel later needs no code change outside `src/infra`.

**Consequences.** System health routes read live BullMQ counts and these metrics; Grafana/Prometheus can scrape both
processes.
