# System health module (`health`)

Map domain G. Service health and operations: the health check, Prometheus metrics, service checks, alert rules, alerts, incidents, job runs and the queue board. Infrastructure modules register their health indicators with `src/infra/health`, so this module never imports them.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 015 observability. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: `GET /health` (health check) and `GET /metrics` (Prometheus), both in `controllers/` with their contracts in `contracts/health.contracts.ts`. The run log of jobs (`job_runs`): `JobRunsService`, in `job-runs/`.

## Public API (`index.ts`)

Exports `HealthModule` and the `HealthReport` type, and the run log for the processors of other modules: `JobRunsModule`,
`JobRunsService` (`run`, `start`, `finish`, `findRunning`, `failStuck`) and the types `JobRunReport`, `RunJobOptions`,
`RunOverlap`, `StartJobRunInput`, `JobRunOutcome`, `JobRun`, `JobStatus`, `JobTrigger`. `JobRunsModule` is separate from
`HealthModule` so that the worker loads the service without the health controllers.

## Owned tables

Only this module reads and writes these 5 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `service_checks` | Results of the periodic health checks: every minute the worker checks the database, the cache, storage, every supplier and every payment gateway, and writes the status and the response time. Uptime is computed from these rows and outages are detected from them. High-resolution metrics (requests, latency) are not stored here but in the monitoring system. Rows are deleted after 90 days. |
| `alert_rules` | Alert rules: metric, comparator, threshold, window, severity and channels (Telegram or email). A temporary mute, for example during maintenance, uses muted_until. |
| `alert_events` | Each time a rule fires: firing, then acknowledged, then resolved. It closes on its own when the value is back in range, and the message is not repeated until a staff member acknowledges it or the reminder interval passes. |
| `incidents` | Operational incidents: declared by a staff member or opened from a critical alert. Severity, affected components, the timeline (timeline jsonb), and the root cause and action taken at closing. |
| `job_runs` | Run log of scheduled and background jobs (price sync, ledger integrity check, expired-data deletion, reminders): start, end, result and error. result holds the job summary; the last money integrity result comes from it. |

## Routes

33 endpoints (admin 31, system 2). Source: `docs/slices/health.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (31)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/alert-rules/:id` | staff-permission · `alerts:*` | Alert rules: metric, threshold, window, severity and channels, with a temporary mute through muted_until. | 12 |
| `GET /admin/alert-rules` | staff-permission · `alerts:*` | Alert rules: metric, threshold, window, severity and channels, with a temporary mute through muted_until. | 12 |
| `GET /admin/alert-rules/:id` | staff-permission · `alerts:*` | Alert rules: metric, threshold, window, severity and channels, with a temporary mute through muted_until. | 12 |
| `GET /admin/alerts` | staff-permission · `alerts:read` | Fired alerts and their status: firing, acknowledged or resolved. | 12 |
| `GET /admin/alerts/:id` | staff-permission · `alerts:read` | Fired alerts and their status: firing, acknowledged or resolved. | 12 |
| `GET /admin/incidents` | staff-permission · `incidents:*` | Incidents: declare an incident, update its timeline and close it with the cause and the action taken. | 12 |
| `GET /admin/incidents/:id` | staff-permission · `incidents:*` | Incidents: declare an incident, update its timeline and close it with the cause and the action taken. | 12 |
| `GET /admin/queues` | staff-permission · `queues:read` | Bull Board UI for monitoring the queues. | 9 |
| `GET /admin/system/cache` | staff-permission · `system:read` | Redis: memory used out of the limit, evictions, hit rate, clients and latency. | 9 |
| `GET /admin/system/checks` | staff-permission · `system:read` | Check history of a component over a time range: uptime bars and response time. | 9 |
| `GET /admin/system/database` | staff-permission · `system:read` | Postgres: connections out of the maximum and pool wait, slowest queries (pg_stat_statements), locks and long transactions, replica lag, size and growth, and pending migrations. | 9 |
| `GET /admin/system/errors` | staff-permission · `system:read` | Most frequent errors by code and endpoint over a time range, with first and last seen, request_id and a Sentry link. | 9 |
| `GET /admin/system/health` | staff-permission · `system:read` | Overall status (Operational, Degraded or Outage), the running build (version, commit, environment), the status of each component, uptime over 24 hours, 7 and 30 days, open alerts, ongoing incidents and the maintenance state. | 9 |
| `GET /admin/system/integrity` | staff-permission · `system:read` | Money integrity checks: every entry sums to zero, every account balance equals the sum of its lines, holds stuck over 24 hours, confirmed payments without an entry, and the last result. | 12 |
| `GET /admin/system/jobs` | staff-permission · `system:read` | Scheduled jobs: name, schedule, last run, next run and result; ?job= returns the run history of one job. | 9 |
| `GET /admin/system/metrics` | staff-permission · `system:read` | API performance per surface over a time range: requests/min, latency p50, p95 and p99, 4xx and 5xx rates, 429 count and the 10 slowest endpoints. Read from the monitoring system. | 9 |
| `GET /admin/system/orders-health` | staff-permission · `system:read` | Order pipeline health: orders stuck beyond SLA per status, dispatch time p95, success and failure rate per service type, and orders held by risk. | 9 |
| `GET /admin/system/queues` | staff-permission · `system:read` | BullMQ counters per queue: waiting, active, delayed, failed, age of the oldest job, rate and number of workers. Deep details stay in Bull Board. | 9 |
| `GET /admin/system/queues/:name/failed` | staff-permission · `system:read` | Failed jobs with the failure reason and the number of attempts. | 9 |
| `GET /admin/system/suppliers` | staff-permission · `system:read` | Health of each supplier: up or down, last successful call, response time, error and timeout rate, circuit-breaker state, last sync and our balance with them. Pausing uses PATCH /admin/suppliers/:id (status = paused). | 9 |
| `GET /admin/system/webhooks` | staff-permission · `system:read` | Delivery health of outgoing webhooks to merchants and incoming ones from gateways: success rate, failures, attempts and the oldest undelivered message. | 9 |
| `PATCH /admin/alert-rules/:id` | staff-permission · `alerts:*` | Alert rules: metric, threshold, window, severity and channels, with a temporary mute through muted_until. | 12 |
| `PATCH /admin/incidents/:id` | staff-permission · `incidents:*` | Incidents: declare an incident, update its timeline and close it with the cause and the action taken. | 12 |
| `POST /admin/alert-rules` | staff-permission · `alerts:*` | Alert rules: metric, threshold, window, severity and channels, with a temporary mute through muted_until. | 12 |
| `POST /admin/alerts/:id/ack` | staff-permission · `alerts:update` | Acknowledge: stops repeated messages and records the staff member and the time. | 12 |
| `POST /admin/incidents` | staff-permission · `incidents:*` | Incidents: declare an incident, update its timeline and close it with the cause and the action taken. | 12 |
| `POST /admin/system/integrity/run` | staff-permission · `system:manage` | Run the integrity check now as a background job; the result appears in GET /admin/system/integrity. | 12 |
| `POST /admin/system/jobs/:name/run` | staff-permission · `system:manage` | Run a job now by hand (for example the price sync); the run is recorded in job_runs with trigger = manual. | 9 |
| `POST /admin/system/queues/:name/pause` | staff-permission · `system:manage` | Pause or resume processing of a queue (paused: true or false) during an incident. | 9 |
| `POST /admin/system/queues/:name/retry` | staff-permission · `system:manage` | Retry one failed job or all failed jobs. | 9 |
| `PUT /admin/system/maintenance` | staff-permission · `system:manage` | Maintenance mode with a scope (store, checkout, API orders or all), a message and an expected time. The chosen scope answers 503 MAINTENANCE; the admin console is never affected, so staff are not locked out. The switch is stored in settings. | 9 |

### System (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /health` | public | Service health check: Postgres and Redis. | 0 |
| `GET /metrics` | internal-or-token | Prometheus metrics: requests, latency and queues. Internal network or token only; the admin health page reads it. | 9 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `system-alert`: Alert and incident: a supplier slows down (tables: `alert_events`, `alert_rules`, `incidents`, `service_checks`)
- `system-integrity`: Ledger mismatch and maintenance mode (tables: `alert_events`, `alert_rules`, `job_runs`)

## Permissions

Staff permissions the map requires on this module's admin routes: `alerts:*`, `alerts:read`, `alerts:update`, `incidents:*`, `queues:read`, `system:manage`, `system:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None of this module's own jobs exist yet (the checks, alerts and integrity features add them). The run log is built:

- **`JobRunsService.run({ job, trigger, runId?, triggeredBy?, overlap? }, work)`** is the wrapper processors use around their
  scheduled or manual work. It inserts a `running` row, runs `work(run)`, and closes the row as `succeeded` (or `skipped`
  when the report says `skipped: true`) with the duration (database clock), `processed` and the `result` counters (no secrets,
  no personal data); when `work` throws it closes the row as `failed` with the message (cut at 1 000 characters) and
  rethrows, so BullMQ retries as the queue says (each attempt is its own row). A failure while recording the end is logged
  and never hides the job's own outcome.
- **One run per job at a time.** `overlap` is `skip` for `run` (default: a second run records a `skipped` row with
  `result.runningRunId` and does not call `work`), `refuse` (`start` throws `AppError('JOB_ALREADY_RUNNING')`, 409, for the
  manual-run route) or `allow`. Starters of one job queue up on a transaction advisory lock, so two workers cannot both
  start it.
- **Manual runs.** `POST /admin/system/jobs/:name/run` (health feature) calls `start({ trigger: 'manual', triggeredBy,
  overlap: 'refuse' })`, adds the job with `{ runId }` and the job id `manual-<run id>`, and the processor adopts the row with
  `run({ ..., runId })`. A row that is no longer `running` (closed by the reaper) is not run again.
- **`failStuck(maxAgeMs)`** closes runs that stayed `running` too long (a worker that was killed), so the guard cannot block
  a job for ever. The health feature schedules it.
- Event-driven jobs (dispatch, webhooks) are not recorded here, and neither is the outbox relay tick (one run per second).

Queues, jobs and schedules: `docs/queues.md`.

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").
