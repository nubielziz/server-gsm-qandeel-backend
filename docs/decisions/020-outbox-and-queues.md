# 020: Outbox and queues

Status: accepted, 2026-10-31.

**Decision.**
- A state change that needs async work writes an `outbox_events` row in the same DB transaction
  (`OutboxService.add(tx, { type, aggregateType, aggregateId, payload })`; payload = ids only).
- The worker's relay runs every second (job scheduler) and on Postgres `NOTIFY outbox` (wake-up only): it selects
  pending rows `ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, adds one BullMQ job per row with `jobId = outbox:<id>`
  on the queue mapped from the event type, and sets `processed_at` in the same transaction. A crash between enqueue
  and commit re-enqueues the same jobId, which BullMQ ignores while the job is retained.
- Queues (BullMQ prefix `gsm:<env>:bull`), each with its own concurrency: `outbox-relay`, `supplier-dispatch`,
  `supplier-poll`, `merchant-webhooks`, `notifications`, `supplier-sync`, `imports`, `files`, `maintenance`,
  `alerts`. Every queue, job, payload, idempotency key, retry policy and schedule is listed in `docs/queues.md`.
- Defaults: `attempts` with exponential backoff and jitter for transient errors, `UnrecoverableError` for permanent
  ones; `removeOnComplete { age: 24 h, count: 10 000 }`, `removeOnFail { age: 14 days }`. Supplier dispatch never
  retries a timed-out send (the order goes to needs-attention; map scenario `timeout`).
- Every scheduled or manual run writes `job_runs`.

**Consequences.** The API stays fast and consistent: no job is enqueued for a rolled-back change, and no committed
change loses its job.
