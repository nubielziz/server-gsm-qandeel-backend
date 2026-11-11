# 020: Outbox and queues

Status: accepted, 2026-10-31.

**Decision.**
- A state change that needs async work writes an `outbox_events` row in the same DB transaction
  (`OutboxService.add(tx, { type, aggregateType, aggregateId, payload })`; payload = ids only).
- The worker's relay runs every second (job scheduler) and on Postgres `NOTIFY outbox` (wake-up only): it selects
  pending rows `ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, adds one BullMQ job per row with `jobId = outbox-<id>`
  on the queue mapped from the event type, and sets `processed_at` in the same transaction. A crash between enqueue
  and commit re-enqueues the same jobId, which BullMQ ignores while the job is retained. (BullMQ refuses custom ids that
  contain `:` or are only digits, so every deterministic id is `<kind>-<id>`: `outbox-<id>`, `manual-<run id>`.)
- Queues (BullMQ prefix `gsm:<env>:bull`), each with its own concurrency: `outbox-relay`, `supplier-dispatch`,
  `supplier-poll`, `merchant-webhooks`, `notifications`, `supplier-sync`, `imports`, `files`, `maintenance`,
  `alerts` (and, since feature 23, `notification-broadcasts`). Every queue, job, payload, idempotency key, retry policy and schedule is listed in `docs/queues.md`.
- Defaults: `attempts` with exponential backoff and jitter for transient errors, `UnrecoverableError` for permanent
  ones; `removeOnComplete { age: 24 h, count: 10 000 }`, `removeOnFail { age: 14 days }`. Supplier dispatch never
  retries a timed-out send (the order goes to needs-attention; map scenario `timeout`).
- Every scheduled or manual run writes `job_runs`, except two pieces of high-frequency housekeeping whose health is shown by
  metrics instead: the outbox relay's one-second tick (86 400 rows a day would bury the real runs; its metrics are pending
  events, oldest pending age and relay lag) and the IP rule hit counter flush `ip_rule_hits_flush` (every minute, queue
  `maintenance`: it moves the Redis hit counters of the IP rules to `ip_rules.hit_count`; its metrics are the timestamp of
  the last successful flush, flush failures and hits flushed). Amended with P2.5b. A third, since feature 6: the
  supplier poll tick `supplier_poll_tick` (every minute, it only queues the `poll` jobs of sent orders, which write their
  own supplier call logs). System health's jobs list leaves the three out and a manual run of one is `404` (feature 9,
  `UNRECORDED_JOBS`).

- Amended with feature 12a: an event type may have **several routes, one per queue** (`OutboxRouteRegistry.register` throws only for the same
  type on the same queue twice; `routesOf(type)` lists them, `get(type)` keeps answering the first). The relay adds one job per route, each with
  `jobId = outbox-<id>` (ids are per queue), and sets `processed_at` only when every route took its job; after a crash between two routes the retry
  adds the same id again on the route that has it, which BullMQ ignores. So the consumers of one event stay independent: an order change reaches the
  merchant's webhooks (`merchant-webhooks`) and its notifications (`notifications`, job `notification.plan`) without the producer knowing either.

- Amended with feature 23 (notification center): an eleventh queue, `notification-broadcasts`, carries the email and Telegram messages of
  notification campaigns. A broadcast is **one** outbox event per campaign (`notification.campaign_fanout`), never one per recipient: the relay
  is FIFO, 100 rows a pass, and 50 000 rows would hold order dispatch and password resets behind it. The fan-out job walks the audience in short
  chunk transactions and hands each chunk's send jobs to the new queue with `QueuesService.addBulk` (one round trip per 1 000 jobs; an existing
  job id is left as it is). The queue has a BullMQ **limiter** (`QueueDefinition.limiter`: 30 jobs a second across every worker); BullMQ's limiter
  is per queue, which is why bulk mail has a queue of its own and transactional mail keeps `notifications` without a limit. Per-channel provider
  limits are a second, lower budget (decision 021: limiters `broadcast-email`, `broadcast-telegram`). The minute sweep that sends scheduled
  campaigns records its runs through the `JOB_RUN_RECORDER` port health provides (platform cannot import health).

**Consequences.** The API stays fast and consistent: no job is enqueued for a rolled-back change, and no committed
change loses its job.
