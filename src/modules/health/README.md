# System health module (`health`)

Map domain G. Service health and operations: the health check, Prometheus metrics, service checks, alert rules, alerts, incidents, job runs and the queue board. Infrastructure modules register their health indicators with `src/infra/health`, so this module never imports them.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 015 observability. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: `GET /health` (health check), `GET /metrics` (Prometheus), the run log of jobs (`job_runs`, `JobRunsService`, in `job-runs/`) and,
with feature 9, the 16 `/admin/system/*` routes of the System health page, `GET /admin/queues` (Bull Board) and `GET /admin/dashboard`
(the Dashboard page; it lives here because it reads the same checks, queues and counts, and platform stays free of the cycle). Not yet:
alert rules, alerts, incidents and the integrity job (feature 12b), the `gateway:<id>` checks (feature 8).

Layout of the admin part (`HealthAdminModule`, API process; `HealthJobsModule`, worker process):

| Folder | What it holds |
|---|---|
| `contracts/` | one `defineRoute` per System health route (`system-health`, `system-ops`, `system-pipeline`, `system-traffic`) |
| `controllers/` | thin controllers (`system-overview`, `system-ops`, `system-traffic`) |
| `application/` | the read models: `HealthSnapshotService` (overview, cached 10 s), `ChecksHistoryService`, `PipelineHealthService` (orders, suppliers), `StoresHealthService` (database, cache, webhooks), `QueueAdminService`, `JobsAdminService`, `TrafficService` + `PrometheusClient` (metrics, errors), `MaintenanceAdminService`, `ComponentChecker` (writes `service_checks`), `WebhookIntakeCounter`, `ApiHeartbeat`, `database-guard` (`503 DATABASE_UNAVAILABLE`) |
| `dashboard/` | `GET /admin/dashboard`: contract, controller, service, the read queries (`dashboard-reads.ts`) and the attention rules (`attention.ts`: the fixed severity of each kind, RULES dashboard 3, and the ranking) |
| `domain/` | pure rules: `checks` (status words, uptime, overall verdict), `measure` (the metric specs and thresholds), `queue-verdict`, `cron-text` |
| `infra/` | Drizzle queries on the module's own tables (`service-checks`, `job-runs-admin`, `alerts-read`) and `foreign-reads.repository.ts` (the documented reads of other modules' tables), `sibling-modules.ts` (late-bound imports of the other modules' public API, decision 032) |
| `jobs/` | the four worker jobs and their schedules |
| `queues-board/` | the read-only Bull Board mount behind the staff gate |

## Public API (`index.ts`)

Exports `HealthModule`, `HealthAdminModule`, `HealthJobsModule` and the `HealthReport` type, and the run log for the processors of
other modules: `JobRunsModule`, `JobRunsService` (`run`, `start`, `finish`, `findRunning`, `failStuck`) and the types `JobRunReport`,
`RunJobOptions`, `RunOverlap`, `StartJobRunInput`, `JobRunOutcome`, `JobRun`, `JobStatus`, `JobTrigger`. `JobRunsModule` is separate from
`HealthModule` so that the worker loads the service without the health controllers.

For the billing (8), mail (12a) and alerts (12b) features:

- `WebhookIntakeCounter.record(outcome)`: billing's gateway callback handler counts each incoming callback (`delivered`, `failed`,
  `retrying`), which `GET /admin/system/webhooks` reports.
- `MAIL_PROBE` and `HealthProbe`: 12a provides a probe under this token and the checker records the `mail` component.
- 12b's metric sources: `METRIC_SPECS`, `measure`, `stateOf`, `worst` (thresholds and units, one place), `PrometheusClient`,
  `OLDEST_WAITING_GAUGE`, `ALERT_EVALUATION_JOB`, `CORE_COMPONENTS`, `TIME_RANGES`, and the job names and retention of the health jobs.

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

Outbox events produced (types, payload ids): none. Consumed: none. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

The health jobs (queue `maintenance`, worker process, `jobs/health-jobs.module.ts`): `service_checks` every minute (writes `service_checks`
for the core components and every active supplier), `service_checks_purge` at 03:30 UTC (90 days of checks and finished runs),
`job_runs_reaper` every 5 minutes (`failStuck`, runs left `running` over 2 hours) and `db_size_sample` at 03:45 UTC. Details and retry
policy: `docs/queues.md`. Alerts and integrity add theirs in 12b. The run log:

- **`JobRunsService.run({ job, trigger, runId?, triggeredBy?, overlap? }, work)`** is the wrapper processors use around their
  scheduled or manual work. It inserts a `running` row, runs `work(run)`, and closes the row as `succeeded` (or `skipped`
  when the report says `skipped: true`) with the duration (the injected clock, decision 031), `processed` and the `result` counters (no secrets,
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
  a job for ever. The `job_runs_reaper` job schedules it.
- Event-driven jobs (dispatch, webhooks) are not recorded here, and neither are three high-frequency ticks: the outbox relay `tick`
  (every second), `ip_rule_hits_flush` and `supplier_poll_tick` (every minute). Their processors ignore `data.runId`, so
  `domain/unrecorded-jobs.ts` (`UNRECORDED_JOBS`) keeps them out of `GET /admin/system/jobs` and a manual run of one is 404: a
  manual run would insert a `running` row that nothing closes. A new scheduler whose processor does not use `JobRunsService.run`
  is added to that list.

Queues, jobs and schedules: `docs/queues.md`.

## Cache keys

All in `docs/cache-keys.md`, built by `CacheKeys`: `heartbeat` (the API's 30 s heartbeat, TTL 120 s), `healthSnapshot` (`current` 10 s and
`last` 1 day: the copy served while Postgres is down), `healthChecks` (check history, 30 s), `dashboard` (the dashboard payload, 15 s) and
`webhookIntake` (hourly counters of incoming gateway callbacks, 48 h). Nothing that decides is cached: they are display read models, and the
maintenance state is read live on top of the cached snapshot.

## Seed

`scripts/seed/health.ts` (run last by `scripts/seed/run.ts`, after the suppliers): a week of `service_checks` at one sample per half hour for
the six core components and every active demo supplier (calm, with two blips: a supplier slow for an hour two days ago and the queue Redis
down for one sample four days ago; the newest sample of each is `ok`), and the run history of the scheduled jobs (`price_sync`,
`balance_check`, `session_purge`, `client_group_promotion`, `service_checks_purge`, `db_size_sample`; one old failed price sync, and
`db_size_sample` rows that show 4.3 MB of growth a day). It writes only into empty tables, because the worker's own rows are the real
data; the alert rules, alerts and incidents are seeded by 12b. Test: `test/integration/health-seed.test.ts`.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `health-commissions-5` · GET /admin/alerts
- `health-commissions-6` · GET /admin/system/health, GET /admin/system/checks
- `health-commissions-7` · GET /admin/system/health, GET /admin/system/checks, GET /admin/system/suppliers
- `health-commissions-8` · GET /admin/system/suppliers
- `health-commissions-9` · GET /admin/system/integrity
- `health-commissions-10` · GET /admin/system/orders-health
- `health-commissions-13` · GET /admin/alert-rules
- `health-commissions-14` · GET /admin/alerts
- `health-commissions-15` · POST /admin/incidents
- `health-commissions-16` · GET /admin/system/jobs, POST /admin/system/jobs/:name/run, GET /admin/system/integrity, POST /admin/system/...
- `health-commissions-17` · GET /admin/alerts, GET /admin/incidents, GET /admin/alert-rules, GET /admin/system/webhooks
- `identity-platform-9` · GET /admin/dashboard
- `identity-platform-10` · GET /admin/dashboard
- `orders-suppliers-1` · GET /admin/orders
