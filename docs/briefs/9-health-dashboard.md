# 9 health-dashboard

Phase 3, map stage 9 (admin surface). Read `_common.md` and `_feature.md` first: this brief only names the scope. Modules:
health (system health, checks, queues, jobs, maintenance) and platform (the dashboard). Wave 4, after 5 (orders: the
`pastSla` predicate and the order counts), 6 (suppliers: their health and call outcomes) and 7b (webhook deliveries); in
parallel with 8 (billing). Scenarios: none completed here (system-alert and system-integrity are 12b's). Decisions 015
(observability, Prometheus, B114), 020 (queues, job runs), 022 (cache), 031 (clock).

The console pages are the Dashboard and System health (the newest console feature, 30 endpoints: its design is
`FRONTEND_DIR/docs/system-health-design.md`, its questions to the backend `FRONTEND_DIR/docs/ASSUMED_CONTRACTS.md`
§ system-health, answered in `docs/contract/ANSWERS.md`).

## Routes (18; remove them from `test/contract/pending.ts`)
- Dashboard (platform): `GET /admin/dashboard`.
- System health (health): `GET /admin/system/health`, `GET /admin/system/checks`, `GET /admin/system/metrics`,
  `GET /admin/system/errors`, `GET /admin/system/orders-health`, `GET /admin/system/suppliers`, `GET /admin/system/queues`,
  `GET /admin/system/queues/:name/failed`, `POST /admin/system/queues/:name/retry`, `POST /admin/system/queues/:name/pause`,
  `GET /admin/system/jobs`, `POST /admin/system/jobs/:name/run`, `GET /admin/system/database`, `GET /admin/system/cache`,
  `GET /admin/system/webhooks`, `PUT /admin/system/maintenance`.
- Queues board: `GET /admin/queues` (Bull Board UI behind the staff gate; the console only links to it; test it under Bun
  again, P2.4b notes).

Per-route semantics: `docs/contract/endpoints/health.md` and `platform.md`; shapes: `docs/contract/frontend-endpoints.json`;
console callers (read-only): `FRONTEND_DIR/src/features/system-health/{api,types,mocks}` (the mock scenarios `?mock=` show
every state the pages expect) and `src/features/dashboard/{api,types,mocks}`.

## Rules that matter (beyond the endpoint docs)
- **Checks (health-commissions-6, -7).** A scheduled checker writes `service_checks` for the core components (`api`,
  `postgres`, `redis`, `redis_queue`, `storage`, `workers`, `mail`) and per supplier (`supplier:<id>`, through feature 6's
  health computation) and gateway (`gateway:<id>`, when 8 exists): `detail` null when ok, a short English text when
  degraded or down; for a disabled supplier the wire says 'checks are off' (no row). `?component=` matches the stored key
  exactly. Idempotent scheduled job with `job_runs` (decision 020); the old checks are purged on a schedule.
- **Jobs (health-commissions-16, P2.4b notes).** `GET /admin/system/jobs` from `job_runs` (a running run has `durationMs` 0
  and `processed` 0: contract test); `POST /admin/system/jobs/:name/run` enqueues a manual run `manual-<run id>` (BullMQ
  refuses `:` in job ids) with overlap refused; schedule `JobRunsService.failStuck`.
- **Queues.** Counts, failed jobs (no payload secrets: jobs carry ids only), retry and pause through the queues service of
  P2.4b; both writes audited with the demo's verb phrases (ANSWERS audit Q3).
- **Metrics and errors (B114, decision 015).** Read from Prometheus (`PROMETHEUS_URL`); without it `503 MONITORING_UNAVAILABLE`;
  measures are JSON numbers where the console types numbers (B115).
- **Database and cache.** Postgres from `pg_stat_*` and sizes; the cache Redis from `INFO` (both Redis roles, never mixed);
  no secrets or hostnames on the wire.
- **Orders and suppliers health.** `GET /admin/system/orders-health` uses feature 5's exported `pastSla` predicate (one
  age-only rule, orders-suppliers-1 / health-commissions-10) and queue derivation; `GET /admin/system/suppliers` keeps the
  check words (`ok|degraded|down|unknown`, orders-suppliers-5) with the call outcome rates of health-commissions-8 (6 writes
  the outcome on every supplier call log).
- **Webhooks.** `GET /admin/system/webhooks` summarises 7b's `webhook_deliveries` (success rate, failures, the oldest
  pending).
- **Maintenance.** `PUT /admin/system/maintenance` through the platform's `MaintenanceService` (P2.5b), audited; the console's
  banner reads it.
- **Dashboard (identity-platform-8, -9, -10, catalog-1, b2c-10).** Money in USD as 4-dp strings (orders are stored in USD;
  payments, refunds and disputes convert per row at the checkout's locked rate or the current `rate_to_base`, the sum rounded
  once); supplier health from the latest check (`ok→up`, `degraded→degraded`, `down→down`, unknown or none → `degraded`;
  attention items only from real down/degraded results: contract test of the four mappings); queues and `pastSla` counts
  with 5's predicate; `services_below_floor` on the effective cost (user rule 9); the storefront block from
  `storefrontFunnel(days)`, a read-only function in the customers module's public index (b2c-10: zeros until 14a/16 create
  checkouts; feature 19 reuses it).
- During a database outage the reads that need rows answer `503 DATABASE_UNAVAILABLE` (health-commissions-17).
- Reads of other modules' tables without a public read follow the documented foreign-reads pattern.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
identity-platform-8, -9, -10, catalog-1, orders-suppliers-1, -5, health-commissions-6, -7, -8, -10, -16, -17, b2c-10. Migration
0003 ships their schema changes; add a migration only for what it lacks.

## Out of scope
Alert rules, alerts, incidents and the integrity job (12b), the reports (11), billing (8).
