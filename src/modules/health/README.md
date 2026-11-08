# System health module (`health`)

Map domain G. Service health and operations: the health check, Prometheus metrics, service checks, alert rules, alerts, incidents, job runs and the queue board. Infrastructure modules register their health indicators with `src/infra/health`, so this module never imports them.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 015 observability. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: `GET /health` (health check), `GET /metrics` (Prometheus), the run log of jobs (`job_runs`, `JobRunsService`, in `job-runs/`) and,
with feature 9, the 16 `/admin/system/*` routes of the System health page, `GET /admin/queues` (Bull Board) and `GET /admin/dashboard`
(the Dashboard page; it lives here because it reads the same checks, queues and counts, and platform stays free of the cycle). With feature 12b
the 14 routes of the Alerts & incidents and Integrity tabs: `/admin/alert-rules*` (soft delete), `/admin/alerts*` (acknowledge), `/admin/incidents*`,
`GET /admin/system/integrity` and `POST /admin/system/integrity/run`, the alert evaluator (queue `alerts`, every minute) and the money integrity
check (queue `maintenance`, nightly 02:30 UTC and on demand). The alert messages go through the platform's notifications (feature 12a): see "Alert messages"
below. Not yet: the `gateway:<id>` checks (feature 8).

An idle supplier (P4a, B168): a supplier with no calls in the last 15 minutes gets an `unknown` check from the component checker, and
System health says `unknown` for it everywhere (component status, the overall status, `GET /admin/system/suppliers`, the check
history), never degraded or down; its attention list raises `supplier_down` or `supplier_degraded` only from a real check. The
Dashboard's supplier row reads `unknown` for it (B180, RESOLUTIONS identity-platform-9 amended): a supplier with no check yet or whose
latest check is `unknown` is idle, neither healthy nor failing, and the console shows it as a neutral "No recent calls" badge (its
M260); `up`, `degraded` and `down` come only from real results (`dashboardHealth` in `dashboard/attention.ts`). `GET /admin/suppliers`
keeps its own mapping (RESOLUTIONS orders-suppliers-5).

Layout of the admin part (`HealthAdminModule`, API process; `HealthJobsModule`, worker process):

| Folder | What it holds |
|---|---|
| `contracts/` | one `defineRoute` per System health route (`system-health`, `system-ops`, `system-pipeline`, `system-traffic`) and per alert route (`alert-rules`, `alerts`, `incidents`, `integrity`) |
| `controllers/` | thin controllers (`system-overview`, `system-ops`, `system-traffic`, `alert-rules`, `alerts`, `incidents`, `integrity`) |
| `application/` | the read models: `HealthSnapshotService` (overview, cached 10 s), `ChecksHistoryService`, `PipelineHealthService` (orders, suppliers), `StoresHealthService` (database, cache, webhooks), `QueueAdminService`, `JobsAdminService`, `TrafficService` + `PrometheusClient` (metrics, errors), `MaintenanceAdminService`, `ComponentChecker` (writes `service_checks`), `WebhookIntakeCounter`, `ApiHeartbeat`, `database-guard` (`503 DATABASE_UNAVAILABLE`); 12b: `AlertRulesService`, `AlertsService`, `IncidentsService`, `IntegrityService` (API) and `AlertEvaluator`, `AlertMetricReader` (the eleven metrics), `AlertNotifier` and its `NotificationAlertNotifier` (the alert messages, see "Alert messages"), `LedgerIntegrityCheck` (worker) |
| `dashboard/` | `GET /admin/dashboard`: contract, controller, service, the read queries (`dashboard-reads.ts`) and the attention rules (`attention.ts`: the fixed severity of each kind, RULES dashboard 3, and the ranking) |
| `domain/` | pure rules: `checks` (status words, uptime, overall verdict), `measure` (the metric specs and thresholds), `queue-verdict`, `cron-text`; 12b: `metric-registry` (the eleven alert metrics, their units and subjects), `alert-evaluation` (comparison, subject key, fire/resolve decision, the three ok minutes of a measured recovery, the reminder rounds), `alert-message` (the words of the alert messages), `incident-timeline`, `integrity` (the four checks, finding labels, the run result) |
| `infra/` | Drizzle queries on the module's own tables (`service-checks`, `job-runs-admin`, `alerts-read`; 12b: `alert-rules`, `alert-events`, `incidents`, `integrity-runs`) and the documented reads of other modules' tables: `foreign-reads.repository.ts` and (12b) `integrity-reads.repository.ts` (ledger entries, holds, payments); `sibling-modules.ts` (late-bound imports of the other modules' public API, decision 032) |
| `jobs/` | the six worker jobs and their schedules (`health-processors.ts`; 12b: `alerts-processors.ts`) |
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
- 12b itself: `METRIC_KEYS`, `METRICS` (the registry), `INTEGRITY_JOB`, `AlertEvaluator` (`evaluateAll`, `evaluateMetric`), `LedgerIntegrityCheck`, the
  two processors, and `AlertNotifier` with `NotificationAlertNotifier`: the abstract class the alert evaluator and the rule service tell when an alert
  opens (`fired`), repeats (`reminded`) or closes (`resolved`), each call with the transaction of the change as its first argument. `AlertNotifierModule`
  binds it once for the API and the worker.

## Owned tables

Only this module reads and writes these 5 tables and `alert_streaks` (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `service_checks` | Results of the periodic health checks: every minute the worker checks the database, the cache, storage, every supplier and every payment gateway, and writes the status and the response time. Uptime is computed from these rows and outages are detected from them. High-resolution metrics (requests, latency) are not stored here but in the monitoring system. Rows are deleted after 90 days. |
| `alert_rules` | Alert rules: metric, comparator, threshold, window, severity and channels (Telegram or email). A temporary mute, for example during maintenance, uses muted_until. |
| `alert_events` | Each time a rule fires: firing, then acknowledged, then resolved. It closes on its own when the value is back in range, and the message is not repeated until a staff member acknowledges it or the reminder interval passes. |
| `incidents` | Operational incidents: declared by a staff member or opened from a critical alert. Severity, affected components, the timeline (timeline jsonb), and the root cause and action taken at closing. |
| `job_runs` | Run log of scheduled and background jobs (price sync, ledger integrity check, expired-data deletion, reminders): start, end, result and error. result holds the job summary; the last money integrity result comes from it. |
| `alert_streaks` | Since when a rule has been breached (or, for an open alert, back in range) for one subject, so a reading of the moment fires or resolves an alert only after it held for the rule's whole window. A backend addition to the map's tables (feature 12b), migration `0012_alert_streaks.sql`; one row per rule and subject, rewritten each evaluation, deleted when the stretch ends. |

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

Staff permissions the contracts of this module's admin routes require: `alerts:create`, `alerts:delete`, `alerts:read`, `alerts:update`, `dashboard:read`, `incidents:create`,
`incidents:read`, `incidents:update` (B100: the map's `alerts:*` and `incidents:*` split by verb), `queues:read`, `system:manage`, `system:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none of its own. An alert that opens, repeats or closes calls the `AlertNotifier` in its own transaction, which
writes one `notifications` row per rule channel and a `notification.send` outbox event (platform, feature 12a; payload ids only) — see "Alert messages".
Consumed: none. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

The health jobs (queue `maintenance`, worker process, `jobs/health-jobs.module.ts`): `service_checks` every minute (writes `service_checks`
for the core components and every active supplier), `service_checks_purge` at 03:30 UTC (90 days of checks and finished runs),
`job_runs_reaper` every 5 minutes (`failStuck`, runs left `running` over 2 hours) and `db_size_sample` at 03:45 UTC. Details and retry
policy: `docs/queues.md`. Feature 12b adds `alert_evaluation` (queue `alerts`, every minute) and `ledger_integrity` (queue `maintenance`, 02:30 UTC): see
"Alerts and integrity (12b)" below. The run log:

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

## Alerts and integrity (12b)

- **Metric registry** (`domain/metric-registry.ts`): eleven keys with a fixed unit and subject (health-commissions-13 and -14): `supplier.timeout_rate`,
  `supplier.error_rate` (percent, one alert per supplier), `supplier.balance` (no unit, per supplier), `api.p95` (ms), `api.rate5xx` (percent),
  `queue.oldest_age` (s, one alert per queue), `orders.past_sla` (count), `ledger.mismatch_count` (count), `db.connection_usage`, `redis.memory_usage`,
  `webhooks.success_rate` (percent); the others raise a `system` alert. What the rule's window means depends on the metric (`window` in the registry):
  rates and percentiles (`supplier.*_rate`, `api.*`, `webhooks.success_rate`) are **measured** over it: they fire at the first breached evaluation and
  close only after three consecutive ok minutes (`RECOVERY_SECONDS` = 180, the `clear` stretch of `alert_streaks`, RULES health 8; a breach or a
  missing reading starts the three minutes again); readings of the moment (`supplier.balance`,
  `queue.oldest_age`, `orders.past_sla`, `db.connection_usage`, `redis.memory_usage`) are **held**: the alert opens only after every evaluation of the
  whole window saw the breach and closes only after every evaluation of the whole window saw the value back in range (`alert_streaks` keeps when the
  stretch began; a missing reading, a rule edited to judge differently, or more than 5 minutes unseen starts the window again; a mute keeps it running);
  `ledger.mismatch_count` is the outcome of a run and is judged at once (scenario system-integrity steps 2 and 7). Sources: Postgres (`supplier_api_logs`, `suppliers`, orders, webhook
  deliveries, `pg_stat_activity`, the last integrity run), BullMQ, both Redis roles and Prometheus (`api.*` only: while it is down those rules are
  skipped and the run says so in `result.unevaluated`, ANSWERS Q15).
- **Evaluator** (`AlertEvaluator`): a rule that is switched on and not deleted is judged each minute. Breached with no open alert for the subject opens one
  (unless muted), recovered closes it (an acknowledged one too), no data does neither, and a subject that has no reading any more (a supplier disabled
  or deleted) closes its alert. One open alert per rule and subject is the partial unique index `alert_events_open_uq (rule_id, subject_key)`: two
  overlapping runs open it once and only the run that opened it notifies. The rule is snapshotted onto the alert when it fires. The alert is opened in a
  transaction that first locks the rule as it is now (`FOR SHARE`; a change of the rule takes `FOR UPDATE`) and opens nothing for a rule that was
  switched off, deleted, muted or edited to judge differently while the run was reading its metric: nothing would ever close such an alert (later runs
  skip an inactive rule and no route resolves an alert), so either the alert commits first and the change resolves it, or the change commits first and
  the evaluator skips.
- **Rules** (`AlertRulesService`): a deleted rule keeps its row (`deleted_at`) and its alerts; switching a rule off, deleting it or changing its metric
  resolves its open alerts and sends their "resolved" messages in the same transaction; a mute (`muted_until`) stops new alerts and reminders only.
  Editing only `windowSeconds` keeps the running stretch (a longer window waits for it to grow, a shorter one counts it at once); editing the metric,
  comparator or threshold, or switching the rule off and on, starts the window again.
- **Alert messages** (`AlertNotifier`, `NotificationAlertNotifier`, `alert.fired` and `alert.resolved` in the platform's event registry, staff audience):
  one notification per channel of the rule (`telegram`, `email`), written in the same transaction as the alert insert, reminder or resolve, so a page is
  never lost between the change and the send. The recipients are the configuration's ops mailbox(es) `ALERTS_EMAIL_TO` (one email to all) and ops chat
  `ALERTS_TELEGRAM_CHAT_ID` (the lead's choice, the map names none); the pseudo-recipient is (`staff`, id 0), the address or chat travels in the payload
  and the notification log masks it. A channel with no configured recipient is recorded as a `failed` notification with "No alert recipient is
  configured for <channel>." and nothing is sent; the alert still opens. A firing alert that is not acknowledged repeats its message every 30 minutes
  (`REMINDER_INTERVAL_MS`, a lead default: RULES health 6 names none), counted from when it fired; a worker that was down sends one reminder (the round is
  in the dedupe key `alert-<id>:reminder-<n>:<channel>`), a mute or an acknowledgement stops them. The default English templates are migration
  `0013_alert_templates.sql` (kept equal to `DEFAULT_TEMPLATES` by `default-templates.spec.ts`); staff edit them in the console.
- **Incidents** (`IncidentsService`): the server writes the timeline; one incident per alert (pre-check and the unique index); a resolved incident is
  read-only (`INCIDENT_CLOSED`); the closing update is the `resolved` line (B104).
- **Integrity** (`LedgerIntegrityCheck`, job `ledger_integrity`): four checks in the map's order. The account comparison is money's
  `compareLedgerBalances` (same snapshot, same debit-positive differences as `POST /admin/ledger/reconcile`; `ReconcileService.compare` calls it too),
  a plain function loaded through the late import `money()` (decision 032: late imports are for functions only, never providers); the other three are read in `infra/integrity-reads.repository.ts`. The run's `result` keeps counters at the top and
  the checks (first 20 findings each) under `checks` (B99); `mismatchCount` (entries, accounts and payments, not stuck holds) is what the
  `ledger.mismatch_count` rule reads, and the processor judges that rule right after recording a run. It never corrects anything.
- **Audit verbs**: `added alert rule`, `changed alert rule` (`muted alert rule`, `unmuted alert rule`, `turned on alert rule`, `turned off alert rule`),
  `deleted alert rule`, `acknowledged alert`, `opened incident`, `updated incident`, `closed incident`, `ran job` (the integrity run).

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
data. `scripts/seed/health-alerts.ts` (12b) adds, each only into an empty table: the ten alert rules of the mock (ids 1 to 10; one muted, one off), ten
resolved alerts of the last month with their rule snapshot (nothing open: the console opens on Operational), four resolved incidents with their
timelines, and 14 clean nightly `ledger_integrity` runs. Test: `test/integration/health-seed.test.ts`.

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
