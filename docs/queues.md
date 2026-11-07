# Queues

Every piece of asynchronous work runs on one of ten BullMQ queues on the **queue Redis** (decision 006: `noeviction`, AOF)
and is processed by the **worker process** only (decision 020). The code is in `src/infra/queues/`
(`README.md` there explains the API); this document lists every queue, job, payload, idempotency key, retry policy and
schedule, and is extended by the feature that adds a job. A test (`src/infra/queues/queue-definitions.spec.ts`) fails
when a queue is missing here or when the numbers in a section differ from `QUEUES` in `queue-definitions.ts`.

## Rules for every queue

- **Keys:** BullMQ keys live under the prefix `BULL_PREFIX`, default `gsm:<env>:bull` (`gsm:development:bull`,
  `gsm:production:bull`); tests use `gsm:test:bull` or a random suffix of it. Nothing else is stored on this Redis.
- **Payload: ids only.** No secrets and no personal data (CLAUDE.md). The processor re-reads what it needs from Postgres.
  `QueuesService.add` adds `requestId` (the request that caused the job) to the data, and the worker makes it the current
  request id while the job runs, so one id joins API, outbox, worker and supplier logs (decision 012).
- **Job ids are deterministic** where the same occurrence can be enqueued twice: `queueJobId('outbox', eventId)` gives
  `outbox-1042`. BullMQ ignores an `add` whose id is already taken while the first job is retained. **BullMQ refuses
  custom ids that contain `:` or are only digits**, so ids are `<kind>-<id>` with a hyphen (`outbox-<id>`,
  `manual-<run id>`; decision 020).
- **Processors are idempotent.** A job can run twice (a stalled job, a crash after the work but before the job was marked
  done, a retry): re-read the state, act through guarded updates (`UPDATE ... WHERE id = $1 AND status = $2`) and unique
  idempotency keys for ledger postings (decision 024).
- **Retries:** each queue has `attempts` and an exponential backoff with jitter (table below). A processor throws
  `UnrecoverableError` for a permanent failure (no retry); any other error is retried. `maxStalledCount` says how often a
  job whose worker vanished goes back to the queue: 0 means never (a supplier dispatch may already have reached the
  supplier, decision 025).
- **Retention:** completed jobs 24 hours (at most 10 000), failed jobs 14 days (decision 020), so the noeviction Redis stays
  bounded and staff can retry failed jobs from the console (`GET /admin/system/queues/:name/failed`).
- **Runs are recorded:** a scheduled or manual job wraps its work with `JobRunsService.run(...)` (health module), which
  writes `job_runs` (start, end, duration, items, result, error). `duration_ms` and `processed` are `NOT NULL DEFAULT 0`: both
  are 0 while the run is `running`, and finishing a run sets `duration_ms = finished_at - started_at` in milliseconds and
  `processed` = the job's count (the job-run service always sets both; a contract test checks a running run). Event-driven jobs (supplier dispatch, webhooks) are
  recorded by their own tables, not in `job_runs`. The outbox relay tick (every second) and the IP rule hit flush (every
  minute) are not recorded either: high-frequency housekeeping whose health is shown by metrics (decision 020).
- **Shutdown:** on SIGTERM the worker stops taking jobs, lets the running ones finish (at most 25 s), then closes its
  connections (decision 001).

| Queue | Concurrency | Attempts | Backoff | Stalled re-runs |
|---|---|---|---|---|
| `outbox-relay` | 1 | 1 | none | 1 |
| `supplier-dispatch` | 10 | 3 | 5 s, jitter 50 % | 0 |
| `supplier-poll` | 20 | 3 | 10 s, jitter 50 % | 1 |
| `merchant-webhooks` | 20 | 8 | 10 min, jitter 20 % | 1 |
| `notifications` | 10 | 5 | 30 s, jitter 50 % | 1 |
| `supplier-sync` | 2 | 3 | 1 min, jitter 50 % | 1 |
| `imports` | 2 | 1 | none | 0 |
| `files` | 4 | 3 | 10 s, jitter 50 % | 1 |
| `maintenance` | 2 | 3 | 1 min, jitter 50 % | 1 |
| `alerts` | 2 | 3 | 10 s, jitter 50 % | 1 |

Concurrency is per worker process. Backoff is exponential: the first retry waits the base time, the next twice as long, and
so on; jitter takes up to that share off each wait.

## outbox-relay

Ticks that move pending outbox rows to the queues of their event types.

- **Concurrency:** 1 per worker process.
- **Jobs:** `tick`, created every second by the scheduler `outbox-relay-tick`. Each tick runs one relay pass
  (`OutboxRelay.run`), the safety net behind the Postgres `NOTIFY outbox` wake-up. The processor is
  `OutboxRelayProcessor` (`src/modules/platform/outbox/`).
- **Payload:** none.
- **Idempotency:** the relay selects `outbox_events` rows with `processed_at is null` `ORDER BY id LIMIT 100 FOR UPDATE
  SKIP LOCKED`, adds one job per row with the job id `outbox-<event id>` and sets `processed_at` in the same transaction. A
  crash between the enqueue and the commit re-adds the same job id, which BullMQ ignores while the job is retained. Two
  relays (two workers, a tick and a wake-up) never take the same row.
- **Retry policy:** 1 attempt, no retry: the next tick is the retry. A row that cannot be handed over counts an attempt in
  `outbox_events.attempts` and waits 2^attempts seconds (at most 5 minutes) before it is tried again. While the queue Redis
  is down the rows stay pending and no attempt is counted.
- **Schedule:** every second (`outbox-relay-tick`, `src/modules/platform/outbox/outbox-relay.module.ts`). Tick jobs are
  kept briefly (20 completed, 1 000 failed for an hour) so a job per second does not fill the Redis.
- **Metrics:** `outbox_events_relayed_total{queue}`, `outbox_relay_lag_seconds`, `outbox_relay_failures_total{reason}`,
  `outbox_pending_events`, `outbox_oldest_pending_age_seconds` (worker `/metrics`).

## supplier-dispatch

Sends accepted orders to their supplier.

- **Concurrency:** 10 per worker process (the per-supplier limit is the semaphore of `RateLimitService`, decision 021).
- **Jobs:** none yet. Built by the suppliers feature (6): `dispatch` for an order that is ready to send.
- **Payload:** none yet (an `OutboxJobData` of the event that starts a dispatch: order id).
- **Idempotency:** none yet. Rule: re-read the order, move `dispatch_state` with a guarded update before the call; a
  timeout is never re-sent (the order goes to `needs_attention`, decision 025).
- **Retry policy:** 3 attempts, exponential backoff from 5 s (jitter 50 %); a processor throws `UnrecoverableError` for a
  send that may have reached the supplier. Stalled jobs are not re-run (`maxStalledCount` 0).
- **Schedule:** none (event-driven).

## supplier-poll

Asks suppliers for the status of orders they accepted.

- **Concurrency:** 20 per worker process.
- **Jobs:** none yet. Built by the suppliers feature (6): `poll` per sent order.
- **Payload:** none yet (order id).
- **Idempotency:** none yet. Rule: job id `order-poll-<order id>-<n>`; a poll re-reads the order and acts through guarded
  transitions.
- **Retry policy:** 3 attempts, exponential backoff from 10 s (jitter 50 %). The poll rhythm (every minute for one hour,
  then every 5 minutes, then every 30 minutes) is a new delayed job per poll, not a retry (decision 025).
- **Schedule:** none (each poll schedules the next).

## merchant-webhooks

Delivers signed events to the webhook endpoints of merchants.

- **Concurrency:** 20 per worker process.
- **Jobs:** none yet. Built by the merchant API feature (7b): one job per delivery of `order.status_changed`,
  `wallet.low_balance` and `invoice.paid`.
- **Payload:** none yet (event id, endpoint id; the body is rebuilt from Postgres).
- **Idempotency:** none yet. Rule: one `webhook_deliveries` row per delivery; the job id is `webhook-<delivery id>`.
- **Retry policy:** 8 attempts, exponential backoff from 10 min (jitter 20 %), about 21 hours in total, matching the public
  rule "8 attempts over about 24 h" (`docs/contract/ALIGNMENT.md` § 7); every attempt is recorded in `webhook_deliveries`.
- **Schedule:** none (event-driven).

## notifications

Sends emails and Telegram messages.

- **Concurrency:** 10 per worker process.
- **Jobs:** the merchant mails of the identity module (feature 2b), one named job per outbox event type:
  `merchant.email_verification`, `merchant.password_reset` and `merchant.invited` (processors in
  `src/modules/identity/jobs/merchant-mail.processors.ts`). The queue has named processors only, so feature 12a adds its
  `send` job under its own name (a catch-all next to named processors stops the worker). Still to build by 12a: `send` per
  `notifications` row.
- **Payload:** `OutboxJobData` of the event: `aggregateId` is the merchant (`clients.id`), `payload.tokenId` the
  `auth_tokens` row of the link; never the token or the email address. 12a's `send` job: the notification id.
- **Idempotency:** a merchant mail job re-reads the merchant and the link row and sends nothing when the merchant is gone or
  suspended, or the link was used, voided or has expired (`skipped` in the job result); the job id is `outbox-<event id>`, so
  the relay never adds a second job for one event. A job that runs twice sends twice (a mail is not exactly-once). 12a's
  rule: job id `notification-<id>`; a sent row is not sent again.
- **Retry policy:** 5 attempts, exponential backoff from 30 s (jitter 50 %); a provider's "retry after" is honoured by the
  processor.
- **Schedule:** none (event-driven).

## supplier-sync

Refreshes supplier services, prices and balances.

- **Concurrency:** 2 per worker process.
- **Jobs:** none yet. Built by the suppliers feature (6): the price sync (every 15 minutes in the console's job list) and the
  supplier balance check (every 30 minutes). The balance check sets `suppliers.balance_checked_at` and the price sync sets
  `suppliers.prices_synced_at` at the end of a successful run; `GET /admin/system/suppliers` reports `lastSyncAt` as the
  greater of the two. The supplier client writes an `outcome` (`ok | error | timeout`) on every `supplier_api_logs` row,
  which the System health error and timeout rates read.
- **Payload:** none yet (supplier id).
- **Idempotency:** none yet. Rule: a sync replaces the supplier's rows in one transaction and is safe to repeat.
- **Retry policy:** 3 attempts, exponential backoff from 1 min (jitter 50 %).
- **Schedule:** none yet (registered with `JobSchedulerRegistry` by the owning feature).

## imports

Runs bulk imports (service lists, inventory codes) started by staff.

- **Concurrency:** 2 per worker process.
- **Jobs:** none yet. Built by the catalog and suppliers features: `import`.
- **Payload:** none yet (import id or file id).
- **Idempotency:** none yet. Rule: an import records its progress and can be started again by staff, so it is not retried
  automatically.
- **Retry policy:** 1 attempt, no retry. Stalled jobs are not re-run (`maxStalledCount` 0).
- **Schedule:** none (started by staff).

## files

Processes uploaded and generated files (exports, result files).

- **Concurrency:** 4 per worker process.
- **Jobs:** none yet. Built by the orders and platform features: `export` for CSV exports and result-file handling.
- **Payload:** none yet (file id).
- **Idempotency:** none yet. Rule: job id `file-<file id>`; the output is written under a key derived from the file id.
- **Retry policy:** 3 attempts, exponential backoff from 10 s (jitter 50 %).
- **Schedule:** none (event-driven).

## maintenance

Scheduled housekeeping: group promotion, data retention, integrity checks, FX refresh.

- **Concurrency:** 2 per worker process.
- **Jobs:** `ip_rule_hits_flush`, every minute (identity module, below). The others are built by their features, each
  registered with `@QueueProcessor('maintenance', '<job name>')` and wrapped with `JobRunsService.run`:
  `client_group_promotion` (feature 4a, nightly), `ledger_integrity` (12b, nightly 02:30 UTC), `data_retention` (nightly
  03:00 UTC), `fx_refresh` (hourly), `accruals` (daily 01:00 UTC), `reminders` (every 10 minutes). The names are the
  console's job names (`GET /admin/system/jobs`). `data_retention` erases `imei_checks` older than `imeiRetentionDays` by
  setting `imei_enc`, `imei_hash` and `cached_until` to NULL together (no marker column; the wire then shows the TAC followed
  by bullets up to 15 characters), the same erasure `POST /admin/customers/:id/anonymize` applies to the customer's checks.
- **Payload:** none for `ip_rule_hits_flush`. A manual run of the others carries `{ runId }` of the `job_runs` row that
  `POST /admin/system/jobs/:name/run` inserted; the job id is `manual-<run id>`.
- **Idempotency:** `ip_rule_hits_flush` takes the whole Redis hash of counters and deletes it in one Lua step, so a second or
  parallel run finds nothing and no hit is written twice. For the others: each run is safe to repeat; `JobRunsService.run`
  skips a run while another run of the same job is going on.
- **Retry policy:** 3 attempts, exponential backoff from 1 min (jitter 50 %); each attempt of a scheduled run is its own
  `job_runs` row. A manual run is one row: a retry after it failed ends the job as failed (`UnrecoverableError`), a retry
  after it succeeded returns it unchanged.
- **Schedule:** `ip-rule-hits-flush` every minute (`src/modules/identity/security/ip-rules/ip-rule-hits-flush.module.ts`); the
  others are registered with `JobSchedulerRegistry` by the owning features.

### `ip_rule_hits_flush` (identity module)

The API counts the requests an IP rule decided in the cache Redis hash `gsm:{env}:identity:ip-rule-hits:pending`
(`IpRuleHits.record`, fire and forget); this job writes the totals to `ip_rules.hit_count` and `last_hit_at` in one `UPDATE`.

- **Not recorded in `job_runs`** (decision 020 extends the outbox relay's exception to it): it runs every minute, a row a
  minute would only bury the real runs. Its health is in the worker metrics `ip_rule_hits_flush_last_success_timestamp_seconds`
  (alert when it stops moving), `ip_rule_hits_flush_failures_total` and `ip_rule_hits_flushed_total`; the API counts
  `ip_rule_hit_record_failures_total{reason}` for hits it could not count.
- **Attempts:** one (the scheduler sets `attempts: 1`): the next tick is the retry. A failed database write puts the counts back
  in Redis, added to hits that arrived meanwhile, and fails the job. A crash between taking the counters and writing them, or
  Redis evicting the hash, loses at most a minute of counts: they are statistics, not truth.
- **Retention:** 10 completed and 100 failed jobs (24 hours) are kept, so a job a minute does not fill the Redis.

## alerts

Evaluates alert rules and sends their messages.

- **Concurrency:** 2 per worker process.
- **Jobs:** none yet. Built by the alerts feature (12b): `evaluate_rules` every minute, alert reminders.
- **Payload:** none yet (rule id or alert id).
- **Idempotency:** none yet. Rule: an alert event is opened once per rule while it is firing (guarded insert).
- **Retry policy:** 3 attempts, exponential backoff from 10 s (jitter 50 %).
- **Schedule:** none yet (registered by the alerts feature).

## Outbox event types

An event type maps to exactly one queue; the module that produces it registers the mapping in `onModuleInit` with
`OutboxRouteRegistry.register({ type, queue, jobName? })`, and `OutboxService.add` refuses a type that is not registered.
The job name on the queue is the event type unless `jobName` is given. The job data is `OutboxJobData`
(`src/modules/platform/outbox/outbox.types.ts`): `{ eventId, type, aggregateType, aggregateId, payload, requestId }`, where
`payload` is the ids the use case passed and `requestId` the request that wrote the event (`outbox-<event id>` when there was
none); the job id is `outbox-<event id>`.

| Event type | Queue | Job name | Payload (ids only) | Registered by |
|---|---|---|---|---|
| `merchant.email_verification` | `notifications` | `merchant.email_verification` | `tokenId` (aggregate: `clients`, the merchant) | identity (`MerchantMailOutbox`), written by `POST /client/auth/register` |
| `merchant.password_reset` | `notifications` | `merchant.password_reset` | `tokenId` (aggregate: `clients`) | identity (`MerchantMailOutbox`), written by `POST /client/auth/password/forgot` |
| `merchant.invited` | `notifications` | `merchant.invited` | `tokenId` (aggregate: `clients`) | identity (`MerchantMailOutbox`), written by `POST /admin/clients` (feature 2a) |

The map's outgoing events (`order.status_changed`, `wallet.low_balance`, `invoice.paid`) are registered by the features
that produce them.

## Schedulers

Registered with `JobSchedulerRegistry.register` in `onModuleInit`; the worker upserts all of them on every boot (idempotent).

| Scheduler id | Queue | Job | Schedule | Owner |
|---|---|---|---|---|
| `outbox-relay-tick` | `outbox-relay` | `tick` | every second | platform (`src/modules/platform/outbox/`) |
| `ip-rule-hits-flush` | `maintenance` | `ip_rule_hits_flush` | every minute | identity (`src/modules/identity/security/ip-rules/`) |

## Adding a queue or a job

1. A new queue: add it to `QUEUES` in `src/infra/queues/queue-definitions.ts` and give it a section above (the test fails
   until the section exists and its numbers match).
2. A new job: write the processor in `src/modules/<id>/jobs/`, mark it `@QueueProcessor('<queue>', '<job name>')`, provide
   it in the module, and import that module in `src/worker.module.ts`. Replace the "none yet" lines of the queue section.
3. An event from a use case: `OutboxService.add(tx, { type, aggregateType, aggregateId, payload })`, and register the type
   (table above).
4. A schedule: `JobSchedulerRegistry.register({ id, queue, jobName, every | pattern })`; add a row to the table above.
5. Test it: an integration test that runs the processor twice (idempotency), and one that fails it once (retry).
