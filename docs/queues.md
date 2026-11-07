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
- **Jobs:** one catch-all processor, `MerchantWebhooksProcessor` (`src/modules/platform/webhooks/`), for two kinds of job (a queue cannot have a catch-all next to named processors, and the
  event types are registered by several features, so no other processor may be added to this queue):
  - an outbox event of a merchant, named by its type (`order.status_changed`, registered by feature 5; `wallet.low_balance`, written by the money module's `WalletLowBalanceWatch`;
    `invoice.paid`, registered by feature 8; `service.price_changed`, written by the catalog's price change scan). The processor fans it out (`WebhookFanOut`): one
    `webhook_deliveries` row per active endpoint of `payload.clientId` that subscribed to the type, then one `webhook.deliver` job per row;
  - `webhook.deliver`, one attempt of one delivery (`WebhookDeliveries.deliver`).
- **Payload:** the outbox jobs carry `OutboxJobData` (`payload.clientId` is required; the money strings of
  `wallet.low_balance` and `service.price_changed` are the merchant's own public figures); `webhook.deliver` carries `{ deliveryId, attempt }` and nothing else: the body, the address and the encrypted secret are read from
  Postgres at send time.
- **Idempotency:** the outbox job id is `outbox-<event id>`. A fan-out run twice inserts nothing the second time (unique `(endpoint_id, event_id)`, the event id is a keyed hash of the event, or of the change for a price
  change) and re-adds the jobs of deliveries it finds pending. A delivery job has the id `webhook-<delivery id>-<attempt>`; the row says which attempt is current, and a write is guarded by
  `status = 'pending' and attempt = <this attempt>`, so a job that runs twice, or after a manual retry, records nothing twice. A job whose row has moved on only makes sure the current attempt has its job. Sends are at least
  once; the same `X-GSM-Event-Id` on every retry lets the receiver drop repeats.
- **Retry policy:** 8 attempts, exponential backoff from 10 min (jitter 20 %), about 21 hours in total, matching the public rule "8 attempts over about 24 h" (`docs/contract/ALIGNMENT.md` § 7). The worker itself schedules the retries of an HTTP outcome and writes them to the row: a failed attempt n (a non-2xx answer, no answer within 10 s, a refused connection) sets `attempt = n + 1`, `next_retry_at` to `10 min x 2^(n-1)` shortened by up to 20 % at random, and adds the delayed job `webhook-<delivery>-<n + 1>`; after the 8th attempt the delivery is `failed` (a manual retry by staff is one more attempt, never a new ladder). A refusal that cannot change (the address no longer passes the SSRF guard) fails the delivery at once. The queue's own policy above only covers a job that throws (Postgres or Redis failed); every such run is safe to repeat.
- **Schedule:** none (event-driven). Open point: nothing re-queues a pending delivery whose job was lost with the queue Redis's data; `webhook_deliveries_retry_idx` supports a sweep.

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
- **Jobs:** `ip_rule_hits_flush`, every minute, `session_purge`, daily at 03:15 UTC, `client_group_promotion`, nightly at 03:30 UTC (identity module, below), and `service_price_scan`, event-driven (catalog module, below). The others are built by their features, each
  registered with `@QueueProcessor('maintenance', '<job name>')` and wrapped with `JobRunsService.run`:
  `ledger_integrity` (12b, nightly 02:30 UTC), `data_retention` (nightly
  03:00 UTC), `fx_refresh` (hourly), `accruals` (daily 01:00 UTC), `reminders` (every 10 minutes). The names are the
  console's job names (`GET /admin/system/jobs`). `data_retention` erases `imei_checks` older than `imeiRetentionDays` by
  setting `imei_enc`, `imei_hash` and `cached_until` to NULL together (no marker column; the wire then shows the TAC followed
  by bullets up to 15 characters), the same erasure `POST /admin/customers/:id/anonymize` applies to the customer's checks.
- **Payload:** none for `ip_rule_hits_flush`, `session_purge` and `client_group_promotion` (a manual run of the last two carries `{ runId }` like the others). A manual run of the others carries `{ runId }` of the `job_runs` row that
  `POST /admin/system/jobs/:name/run` inserted; the job id is `manual-<run id>`.
- **Idempotency:** `ip_rule_hits_flush` takes the whole Redis hash of counters and deletes it in one Lua step, so a second or
  parallel run finds nothing and no hit is written twice. `session_purge` deletes by a cutoff computed from the clock, so a
  repeat or a parallel run only finds fewer rows (a deleted row cannot be deleted twice, live sessions are never touched). For the others: each run is safe to repeat; `JobRunsService.run`
  skips a run while another run of the same job is going on.
- **Retry policy:** 3 attempts, exponential backoff from 1 min (jitter 50 %); each attempt of a scheduled run is its own
  `job_runs` row. A manual run is one row: a retry after it failed ends the job as failed (`UnrecoverableError`), a retry
  after it succeeded returns it unchanged.
- **Schedule:** `ip-rule-hits-flush` every minute (`src/modules/identity/security/ip-rules/ip-rule-hits-flush.module.ts`);
  `session-purge` at 03:15 UTC (`src/modules/identity/jobs/session-purge.module.ts`);
  `client-group-promotion` at 03:30 UTC (`src/modules/identity/jobs/group-promotion.module.ts`); the
  others are registered with `JobSchedulerRegistry` by the owning features.

### `service_price_scan` (catalog module)

Finds the merchants who would now pay another price than their last order's for a service they ordered in the last 30 days, and writes one `service.price_changed` outbox event (queue `merchant-webhooks`) for each.

- **Trigger:** event-driven, not scheduled. Every move of the catalog price version (`CatalogPriceVersion.bump`, called after the commit of every write that can change a resolved price) asks for a scan: a delayed job (60 s) with the
  id `price-scan-<minute>`, so a burst of price edits is one scan and there is at most one a minute. A failed request is only logged: the next price change asks again.
- **Payload:** none. The scan reads `orders`, `clients` and the pricing tables (page by page, 500 merchant and service pairs a step) and compares the resolver's price (floor included) with the unit price of the merchant's latest order.
- **Idempotency:** a difference is written only when no outbox row of the same service holds the same `clientId`, `previousPrice` and `price` (`OutboxService.hasEvent`); the webhook fan-out is idempotent on the same change too. A repeat or
  a parallel run writes nothing new.
- **Not recorded in `job_runs`** (event-driven, like the merchant mail jobs). 3 attempts with the queue's backoff.

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

### `session_purge` (identity module)

Deletes `sessions` rows that ended more than 30 days ago: revoked (`revoked_at`) or past their absolute end (`expires_at`). An
ended session stays readable for 30 days (an incident review, the sessions list's 404), then only costs space; a session that is merely
idle-dead but not yet past `expires_at` is not "ended" for the purge and goes when its absolute end passes. No other table references
`sessions`.

- **Recorded in `job_runs`** (`JobRunsService.run`, trigger `schedule`, or `manual` with `{ runId }`): `processed` and `result.deleted`
  are the number of rows deleted. 03:15 UTC sits between the nightly 02:30 integrity check and 03:00 retention job runs.
- **Batches:** 1000 rows per statement (`DELETE ... WHERE id IN (SELECT id ... ORDER BY id LIMIT 1000)`), repeated until a batch is short,
  so no statement holds a long lock and the job can be interrupted at any point.
- **Attempts and retry:** the queue's policy (3 attempts, exponential backoff from 1 min, jitter 50 %); a retry deletes what is left.
- **Cutoff:** `clock.now() - 30 days` (decision 031): exactly 30 days is kept, one millisecond older is deleted.

### `client_group_promotion` (identity module)

Promotes merchants to a higher merchant group by their cumulative completed-order spend (user rule 1, ANSWERS merchants Q7). A
merchant moves up, never down, to the merchant group with the highest `client_groups.earn_threshold` above zero that the spend
reaches and that is above the threshold of the group it is in; a group at 0 and the storefront group (`b2c_retail`) are never
targets; staff change a group by hand at any time (`PATCH /admin/clients/:id`) and the job never undoes that.

- **Spend:** `MerchantSpend.completedSpend` (money module): the sum of the `order_settle` debits on the merchant's `client_hold`
  account in USD, minus the settlements that were reversed (a transaction with the idempotency key `reverse:<settlement id>`
  exists, decision 024). Read from the ledger, never cached. Every merchant reads as zero until feature 5 settles orders.
- **Who:** `active` merchants, read by id in batches of 500 (`PROMOTION_BATCH_SIZE`). A merchant below the lowest threshold is
  skipped without further queries.
- **Per promotion:** one transaction that locks the merchant row (`FOR UPDATE`) and the target group row (`FOR SHARE`), re-reads
  the merchant's group and the thresholds, checks the credit rule (ip-3: a target without `overdraft_allowed` is skipped, and
  logged, while the merchant has a credit limit above zero; it is tried again the next night), updates `clients.group_id`, writes
  an `audit_logs` row (action `promoted merchant to group`, entity `merchant`, actor `system`, before and after group, spend
  and threshold) and clears the merchant's cached session views (`SessionService.invalidateSubject`, after the commit).
- **Idempotency:** a merchant already in the target group is not a candidate (the target must be above its threshold), and the
  locked re-read makes a parallel run or a staff move in between skip the merchant. `JobRunsService` also skips a run while
  another run of the job is going.
- **Recorded in `job_runs`** (`JobRunsService.run`, trigger `schedule` or `manual` with `{ runId }`): `processed` = merchants
  promoted, `result` = `{ checked, promoted, skipped }`.
- **Attempts and retry:** the queue's policy (3 attempts, exponential backoff from 1 min, jitter 50 %); a retry only finds what
  is left to promote.
- **Schedule:** 03:30 UTC (after the 02:30 integrity check, the 03:00 retention job and the 03:15 session purge).

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
| `session-purge` | `maintenance` | `session_purge` | daily 03:15 UTC | identity (`src/modules/identity/jobs/`) |
| `client-group-promotion` | `maintenance` | `client_group_promotion` | daily 03:30 UTC | identity (`src/modules/identity/jobs/`) |

## Adding a queue or a job

1. A new queue: add it to `QUEUES` in `src/infra/queues/queue-definitions.ts` and give it a section above (the test fails
   until the section exists and its numbers match).
2. A new job: write the processor in `src/modules/<id>/jobs/`, mark it `@QueueProcessor('<queue>', '<job name>')`, provide
   it in the module, and import that module in `src/worker.module.ts`. Replace the "none yet" lines of the queue section.
3. An event from a use case: `OutboxService.add(tx, { type, aggregateType, aggregateId, payload })`, and register the type
   (table above).
4. A schedule: `JobSchedulerRegistry.register({ id, queue, jobName, every | pattern })`; add a row to the table above.
5. Test it: an integration test that runs the processor twice (idempotency), and one that fails it once (retry).
