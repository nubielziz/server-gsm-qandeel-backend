# 12b alerts-integrity

Phase 3, map stage 12 (admin surface). Read `_common.md` and `_feature.md` first: this brief only names the scope. Module:
health. Wave 5, after 9 (checks, metrics, queues and the System health shell) and 3 (the ledger reconciliation it reuses).
Scenarios completed: **system-alert** and **system-integrity** (write `test/scenarios/{system-alert,system-integrity}.e2e.test.ts`,
every step of `docs/slices/health.json` `scenarios` with these ids). Decisions 015 (observability), 020 (jobs, `job_runs`),
024 (ledger), 031 (clock).

## Routes (14; remove them from `test/contract/pending.ts`)
- Alert rules: `GET|POST /admin/alert-rules`, `GET|PATCH|DELETE /admin/alert-rules/:id` (delete is a soft delete:
  `alert_rules.deleted_at`, B116).
- Alerts: `GET /admin/alerts`, `GET /admin/alerts/:id`, `POST /admin/alerts/:id/ack` (and the open filter the console asks
  for: `docs/contract/endpoints/health.md`).
- Incidents: `GET|POST /admin/incidents`, `GET|PATCH /admin/incidents/:id`.
- Integrity: `GET /admin/system/integrity`, `POST /admin/system/integrity/run`.

Per-route semantics: `docs/contract/endpoints/health.md`; shapes: `docs/contract/frontend-endpoints.json`; console callers
(read-only): `FRONTEND_DIR/src/features/system-health` (Alerts & incidents and Integrity tabs) with its `types/` and `mocks/`.

## Rules that matter (beyond the endpoint docs)
- **Metric registry (health-commissions-13, -14).** Eleven metrics with fixed units and subjects: `supplier.timeout_rate`,
  `supplier.error_rate` (percent, subject supplier), `supplier.balance` (no unit), `api.p95` (ms), `api.rate5xx` (percent),
  `queue.oldest_age` (s, subject queue), `orders.past_sla` (count), `ledger.mismatch_count` (count), `db.connection_usage`,
  `redis.memory_usage`, `webhooks.success_rate` (percent); every other subject is `system`. Values come from the sources 9
  already reads (Prometheus, the queues, feature 5's `pastSla`, 6's supplier call outcomes, 7b's deliveries).
- **Evaluation job.** A scheduled, idempotent evaluator compares each active rule over its window and fires or resolves
  `alert_events`, snapshotting the rule at fire time (health-commissions-5); one open alert per rule and subject; firing
  notifies through the notification feature when it exists (12a) and never pages twice for one open alert; `job_runs` per run.
- **Incidents (health-commissions-15):** one incident per alert (422 on `alertEventId` otherwise, also mapped from the
  unique violation); status and timeline per the endpoint doc; audited.
- **Integrity (health-commissions-9, -16).** The nightly job and the manual run reuse money's `ReconcileService.compare`
  (feature 3) plus the per-entry zero-sum check, store the findings with the labels and refs of health-commissions-9, record a
  `job_runs` row (running: duration 0, processed 0), and a mismatch raises the `ledger.mismatch_count` alert. Never corrects
  anything.
- Reads during a database outage answer `503 DATABASE_UNAVAILABLE` (health-commissions-17). Staff writes are audited with the
  demo's verb phrases (ANSWERS audit Q3: `acknowledged alert`, `opened incident`, `changed alert rule`, ...).

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
health-commissions-5, -9, -13, -14, -15, -16, -17. Migration 0003 ships their schema changes; add a migration only for what
it lacks.

## Out of scope
Notification templates and delivery (12a), the system health reads (9), supplier calls (6).
