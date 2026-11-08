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

- **Concurrency:** 10 per worker process (the per-supplier limits are `suppliers.max_concurrency`, a semaphore of `RateLimitService`, and
  `suppliers.rate_limit_per_min`, the `supplier` limiter, decision 021).
- **Jobs:** one catch-all processor, `SupplierDispatchProcessor` (`src/modules/suppliers/jobs/`), for the outbox event `order.dispatch_requested`
  (the relay names the job by the event type). The logic is `SupplierDispatch.run`.
- **Payload:** the `OutboxJobData` of the event (`payload: { orderId }`, written by the orders feature at placement and by every move that
  makes an order dispatchable again: staff `dispatch`, `change-supplier` with `dispatch: true`, a risk release). Ids only.
- **Idempotency:** the job id is `outbox-<event id>`. The run re-reads the order and does nothing unless it is open with `dispatch_state =
  'pending'`. It then claims the order with the guarded update `UPDATE orders ... WHERE dispatch_state = 'pending' AND sent_at IS NULL`
  (it also pins `supplier_id`, `supplier_service_id` and refreshes `unit_cost` and `total_cost` from the chosen link) BEFORE the supplier call, so
  two runs never send twice. The call is made outside any transaction; its answer moves the order in one transaction: a REFERENCEID gives
  `sent` (status `processing`, `supplier_ref` stored once, an `ack` event), an explicit refusal, a timeout, any other failure, or no eligible
  link gives `needs_attention` (status unchanged, a `review` event with the reason, the hold kept). A run that finds a claim whose answer was
  never recorded (`sent_at` set, still `pending`: a crash, or a recording that failed) does not send again: it moves the order to
  `needs_attention`. A staff dispatch clears `sent_at` in the same transaction that queues the new job.
- **Eligibility** (automatic dispatch only): the first active link by priority whose supplier is `active` (not paused, not disabled), whose
  supplier service is still listed by the supplier and whose cost (`credit x credit_rate`) is not above the price charged for one unit
  (user rule 9, B117 (6)); never a failover to a costlier link. An order that already names a supplier service (a staff choice) goes there as it
  is, whatever it costs.
- **Retry policy:** 3 attempts, exponential backoff from 5 s (jitter 50 %). Only a busy supplier (its semaphore or its rate limit is full)
  throws, so the queue retries; on the last attempt a busy supplier sends the order to `needs_attention` instead. A processor throws
  `UnrecoverableError` for a payload without an order id. A supplier timeout is never retried (decision 025). Stalled jobs are not re-run
  (`maxStalledCount` 0).
- **Schedule:** none (event-driven).

## supplier-poll

Asks suppliers for the status of orders they accepted.

- **Concurrency:** 20 per worker process.
- **Jobs:** one catch-all processor, `SupplierPollProcessor`, for two job names: `supplier_poll_tick`, created every minute by the scheduler
  `supplier-poll-tick`, finds the sent orders that are due a poll and adds one `poll` job for each (at most 500 a tick); `poll` asks one supplier
  (`getimeiorder`) about one order (`SupplierPoll.check`). Neither is recorded in `job_runs`: they are high-frequency housekeeping.
- **Payload:** `poll` carries `{ orderId }` (ids only); the tick carries nothing.
- **Idempotency:** the tick keeps no state: an order is due when its `sent_at`, and the `created_at` of its newest `getimeiorder` row in
  `supplier_api_logs`, are older than the rhythm (every minute during the first hour, every 5 minutes after it, every 30 minutes once the order is
  older than the setting `orders.poll_slow_after_hours`, default 24). The `poll` job id is `order-poll-<order id>-<minute>`, so two ticks in
  the same minute queue one job. A poll re-reads the order, and STATUS 4 (the CODE becomes `result_code`) or STATUS 3 (the supplier's text is the
  reason) settles it through `OrderTransitions` (ledger, events, outbox); still running changes nothing; an order that moved on (staff replied) is
  left alone; an unreachable supplier leaves the order as it is for the next round.
- **Retry policy:** 3 attempts, exponential backoff from 10 s (jitter 50 %). The poll rhythm is the tick, not a retry (decision 025).
- **Schedule:** `supplier-poll-tick`, every minute (`src/modules/suppliers/jobs/supplier-jobs.module.ts`).

## merchant-webhooks

Delivers signed events to the webhook endpoints of merchants.

- **Concurrency:** 20 per worker process.
- **Jobs:** one catch-all processor, `MerchantWebhooksProcessor` (`src/modules/platform/webhooks/`), for two kinds of job (a queue cannot have a catch-all next to named processors, and the
  event types are registered by several features, so no other processor may be added to this queue):
  - an outbox event of a merchant, named by its type (`order.status_changed`, registered and written by feature 5 with `{ orderId, clientId, fromStatus, toStatus }`; `wallet.low_balance`, written by the money module's `WalletLowBalanceWatch`;
    `invoice.paid`, registered by the money module (feature 8, `InvoiceOutbox`); `service.price_changed`, written by the catalog's price change scan). The processor fans it out (`WebhookFanOut`): one
    `webhook_deliveries` row per active endpoint of `payload.clientId` that subscribed to the type, then one `webhook.deliver` job per row;
  - `webhook.deliver`, one attempt of one delivery (`WebhookDeliveries.deliver`).
- **Payload:** the outbox jobs carry `OutboxJobData` (`payload.clientId` is required: `null` says the event has no merchant, a storefront order, and is skipped; a missing one fails the job for good; the money strings of
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
- **Jobs:** named jobs only (a catch-all next to named processors stops the worker).
  - `notification.send` (`NotificationSendProcessor`, `src/modules/platform/notifications/notification.processors.ts`): sends one `notifications` row. Added by the
    relay for the outbox event `notification.send` (written with the row by `NotificationService.enqueue`), and, delayed, for a digest row.
  - `notification.plan` (`NotificationPlanProcessor`): turns an outbox event a merchant may want to hear about into notifications (`EventNotifier`): `wallet.low_balance`,
    `order.status_changed` (`order.completed`, `order.failed` for merchants who opted in), `service.price_changed` (the daily digest) and, once the lead adds their routes at
    the merge of feature 8, `invoice.paid` and `deposit.approved`. It is registered next to the event's other consumer (the merchant webhooks): one outbox event, one job per queue.
  - `merchant.email_verification`, `merchant.password_reset`, `merchant.invited` (identity, `src/modules/identity/jobs/merchant-mail.processors.ts`, feature 2b/12a): rotate the
    link's token on its `auth_tokens` row and send the mail with the clear link as a secret that is never stored.
  - `customer.magic_link`, `customer.password_reset`, `customer.invited`, `customer.email_verification` (customers,
    `src/modules/customers/jobs/customer-mail.processors.ts`, feature 14b, handled by `CustomerMailJobs`): the storefront customer's links.
    Built like the merchant mails (decision 033): the job re-reads the customer and the link, sends nothing when the customer is not
    active (suspended, blocked, anonymized) or the link was used, voided or has expired, rotates the link's token on its `auth_tokens` row
    and sends the mail (`<STORE_BASE_URL>/sign-in`, `/set-password` or `/verify-email` with `?token=`) through `NotificationService.sendNow`
    with the clear link as a secret that is never stored or logged. One `notifications` row per mail (`outbox-<event id>:email`, with its
    attempts); a repeat after a delivered mail is skipped before it can spoil the link that arrived.
- **Payload:** `OutboxJobData` of the event (ids only). `notification.send` carries the row (`aggregateId` = the `notifications.id`; a digest job carries `{ notificationId }`). The
  merchant mail jobs carry `aggregateId` = the merchant and `payload.tokenId`; the customer mail jobs carry `aggregateId` = the customer and `payload.tokenId`. Never a token, a link, an address or a message text: the job re-reads the row, the recipient and the
  active template.
- **Idempotency:** the outbox job id is `outbox-<event id>` (per queue). A `notifications` row has a `dedupe_key` (`outbox-<event id>:<channel>` for the planning job,
  `telegram-update-<update id>` for the bot's answer, `digest:<event>:<channel>:<merchant>:<day>` for a digest, unique where not null): a job that runs twice makes no second row.
  A send is guarded (`status = 'queued'` on the update): a row already `sent` or `failed` is skipped, so a job that runs twice records one send; the row's id is the
  `Message-ID` of the mail (`<notification-<id>@<domain of MAIL_FROM>>`), so a provider that dedupes drops the rare repeat after a crash between the provider's answer and the update.
  A digest job has the id `notification-<id>` and a delay up to the end of its period (06:00 UTC), at least 10 seconds (`MIN_DIGEST_DELAY_MS`: a job added before its transaction commits must not run before the row is visible); the send job closes the digest first (`payload.closed`), so a change that arrives
  later joins the next period's row. A merchant or customer mail job asks the row's status before it rotates the token, so a repeat after a delivered mail never spoils the link that arrived.
- **Retry policy:** 5 attempts, exponential backoff from 30 s (jitter 50 %). A transient failure (an SMTP 4xx or a dropped connection, a Telegram 429 or 5xx, a timeout) records the
  attempt on the row and throws, so the queue retries; the last attempt marks the row `failed` with the reason and throws. A refusal that cannot change (an SMTP 5xx, a Telegram
  400, 403 or 404, a missing template, no address, a recipient that is gone) marks the row `failed` at once and ends the job. The queue's own backoff applies as it is: a provider's
  `retry_after` (Telegram's is a few seconds) is shorter than the first wait, so the processors do not read it.
- **Schedule:** none (event-driven).

## supplier-sync

Refreshes supplier services, prices and balances.

- **Concurrency:** 2 per worker process.
- **Jobs:** one catch-all processor, `SupplierSyncProcessor`, for three job names: `supplier_sync` (one supplier: `imeiservicelist` and
  `accountinfo`, asked by staff through `POST /admin/suppliers/:id/sync`, which waits for it), `price_sync` (every supplier that is not
  disabled, every 15 minutes) and `balance_check` (`accountinfo` of every supplier that is not disabled, every 30 minutes). The two scheduled
  jobs are recorded in `job_runs` (`price_sync`, `balance_check`; the console's job list). The balance check sets `suppliers.balance` and
  `balance_checked_at`; the price sync sets `suppliers.prices_synced_at` at the end of a successful run, and `GET /admin/system/suppliers`
  reports `lastSyncAt` as the greater of the two. The supplier client writes an `outcome` (`ok | error | timeout`) on every
  `supplier_api_logs` row, which the System health error and timeout rates read.
- **Payload:** `supplier_sync` carries `{ supplierId, trigger }` (`api` or `schedule`); the scheduled jobs carry nothing (a manual run, feature 9,
  carries `runId`).
- **Idempotency:** a sync takes the supplier row `FOR UPDATE`, upserts `supplier_services` by `(supplier_id, remote_id)` in one transaction (a
  changed credit sets `price_changed_at`; a service not listed is marked unavailable), recomputes the effective cost of every linked service and
  moves the catalog price version after the commit; nothing is written unless both supplier calls worked. It is safe to repeat. A staff request
  has the job id `manual-sync-<supplier id>-<ms>` and `attempts: 1` (a click is its own retry); `supplier_sync` returns its outcome (a supplier
  failure is a value, so the API answers `409 SUPPLIER_UNAVAILABLE`), and the API answers `504 SUPPLIER_TIMEOUT` when the job is still
  running after `timeout_ms + 5 s` (the job goes on).
- **Retry policy:** 3 attempts, exponential backoff from 1 min (jitter 50 %).
- **Schedule:** `supplier-price-sync` (`*/15 * * * *`) and `supplier-balance-check` (`*/30 * * * *`) (`src/modules/suppliers/jobs/supplier-jobs.module.ts`).

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
- **Jobs:** `ip_rule_hits_flush`, every minute, `session_purge`, daily at 03:15 UTC, `client_group_promotion`, nightly at 03:30 UTC (identity module, below), `payment_auto_credit`, every minute, and `fx_refresh`, hourly (money module, below), `service_price_scan`, event-driven (catalog module, below), and the four health jobs `service_checks` (every minute), `service_checks_purge` (03:30 UTC), `job_runs_reaper` (every 5 minutes) and `db_size_sample` (03:45 UTC) (health module, below). The others are built by their features, each
  registered with `@QueueProcessor('maintenance', '<job name>')` and wrapped with `JobRunsService.run`:
  `ledger_integrity` (12b, nightly 02:30 UTC), `data_retention` (nightly
  03:00 UTC), `accruals` (daily 01:00 UTC), `reminders` (every 10 minutes). The names are the
  console's job names (`GET /admin/system/jobs`, which lists only the jobs that write `job_runs`: `ip_rule_hits_flush` does not, so it is not listed and a manual run of it is 404). `data_retention` erases `imei_checks` older than `imeiRetentionDays` by
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
  `client-group-promotion` at 03:30 UTC (`src/modules/identity/jobs/group-promotion.module.ts`);
  `payment-auto-credit` every minute (`src/modules/money/jobs/payment-auto-credit.module.ts`); `fx-refresh` every hour at minute 0
  (`src/modules/money/jobs/fx-refresh.module.ts`); the health jobs in
  `src/modules/health/jobs/health-jobs.module.ts`; the others are registered with `JobSchedulerRegistry` by the owning
  features.

### Health jobs (health module, `src/modules/health/jobs/`)

Four jobs of the worker's `maintenance` queue keep the System health page truthful. Each is wrapped with `JobRunsService.run`
(one `job_runs` row per run; a manual run carries `{ runId }` and the job id `manual-<run id>`). Jobs carry no other payload.

- **`service_checks`** (every minute, `ComponentChecker`): writes one `service_checks` row for each core component (`api`,
  `postgres`, `redis`, `redis_queue`, `storage`, `workers`, `mail`) and for each active supplier (`supplier:<id>`, through the
  suppliers module's health computation). `detail` is null when ok and a short English text when degraded or down; a disabled
  supplier gets no row (the page says "checks are off"). `gateway:<id>` checks are added by the billing feature (8) at the merge.
  The API proves it is alive by a 30 s heartbeat in the cache Redis. Idempotent: a repeat only adds another sample (a row per
  component per run). The scheduler sets `removeOnComplete` to one hour so a job a minute does not fill the noeviction Redis.
  Retry: the queue's policy; the next tick is the real retry.
- **`service_checks_purge`** (03:30 UTC, `RETENTION_DAYS` = 90): deletes `service_checks` and finished `job_runs` older than 90
  days, by a cutoff computed from the clock, so a repeat finds fewer rows.
- **`job_runs_reaper`** (every 5 minutes): `JobRunsService.failStuck(STUCK_RUN_MS)` closes runs left `running` for more than 2 hours
  (their worker died), so the one-run-at-a-time guard cannot block a job for ever. A closed run is never run again.
- **`db_size_sample`** (03:45 UTC): records `pg_database_size` in the run's `result.bytes`; `GET /admin/system/database` reads these
  samples for the growth per day.

### `payment_auto_credit` (money module)

Credits the wallet of confirmed top-ups of automatic gateways by themselves (user rule 6, RESOLUTIONS money-3).

- **Trigger:** the scheduler `payment-auto-credit` every minute. A tick lists the pending top-ups whose `auto_credit_at` has come and that are not `review_required` (at most 50, oldest due first; the partial index `payments_auto_credit_idx` covers it). `auto_credit_at` is the confirmation time plus the larger of the setting `payments.auto_credit_delay_minutes` (default 10) and the gateway's `hold_hours`.
- **Payload:** none (a manual run carries `{ runId }`). The job reads everything it needs from Postgres.
- **What it does, per payment:** asks the gateway's API again through the driver (no row lock is held across the call); then, under `SELECT ... FOR UPDATE` on the payment, re-checks that it is still pending and not flagged and (a) credits it (`deposit` from `gateway_clearing`, key `deposit:payment:<id>`, invoice paid, `invoice.paid` outbox row, audit `credited deposit of` by the system) when the gateway still says confirmed (a crypto gateway only after its required confirmations), (b) sets `review_required` with the reason (audit `sent deposit to review`) when the gateway no longer confirms, the invoice is no longer payable or the payment stayed unconfirmed for 24 hours, or (c) moves `auto_credit_at` 5 minutes ahead while the gateway has not confirmed yet or cannot be reached.
- **Idempotency:** the payment row lock plus the unique ledger key make a double credit impossible, whether two ticks overlap or a staff decision races the job (the loser changes nothing; staff get `PAYMENT_ALREADY_REVIEWED`). A failure of one payment never stops the others; it stays due for the next tick.
- **Recorded in `job_runs`** (job `payment_auto_credit`, `processed` = payments credited, `result` = the counts) only for a tick that had payments due and for every manual run: a run every minute with nothing due would bury the jobs list (like the outbox tick, decision 020). Retry policy: the queue's (3 attempts, backoff from 1 min); the next minute's tick is the real retry.

### `fx_refresh` (money module)

Refreshes the exchange rates every hour, with the same code as `POST /admin/currencies/refresh-fx` (`FxRefreshService`, decision 029).

- **Trigger:** the scheduler `fx-refresh` every hour at minute 0 (`0 * * * *`); a manual run from the Jobs tab carries `{ runId }`. The processor is `FxRefreshProcessor` (`src/modules/money/jobs/`).
- **Payload:** none (a manual run carries `{ runId }`).
- **What it does:** asks the configured provider (`FX_PROVIDER`, `FX_API_KEY`) for the latest rate of every active non-base currency, in one call outside any transaction, then writes the rates in one transaction (rows locked in code order, `rate_updated_at` from the clock) with one `audit_logs` row, `refreshed exchange rate`, written by the system actor (no request is behind the job). A currency the provider does not offer, or sends an unusable rate for, is counted as failed and keeps its old rate.
- **No provider configured** (`manual`, or `openexchangerates` without a key): it asks nothing and changes nothing, writes no audit row, and the run is recorded as `succeeded` with `processed` 0 and `result.reason` (`no provider configured`); a `skipped` run would show a warning in the console every hour. This is not an error and is not retried.
- **No active non-base currency** (a configured provider): it ends without a call, a transaction or an audit row (`processed` 0, `result` `{ source, refreshed: 0, failed: 0 }`). The admin route still audits its empty refresh, because every staff write is audited.
- **Idempotency:** a repeat only writes the newer rates again; two runs at once are serialised by the row locks and `JobRunsService.run`, which skips a run while another run of `fx_refresh` is going on.
- **Recorded in `job_runs`** (job `fx_refresh`): `processed` = the rates refreshed, `result` = `{ source, refreshed, failed }`. A provider that is configured but cannot answer (timeout, refusal, unreadable answer, none of our currencies offered) fails the run (`FX_PROVIDER_DOWN`, the old rates stay): the queue's retry policy applies (3 attempts, backoff from 1 min, each attempt its own run) and the next hour's tick is the real retry. The dashboard's `fx_stale` item and the currencies panel show rates older than 24 hours as stale.

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

An event type maps to one or more queues, one route per queue (decision 020, amended by feature 12a); the module that produces it, or one that consumes
it, registers a route in `onModuleInit` with `OutboxRouteRegistry.register({ type, queue, jobName? })`, and `OutboxService.add` refuses a type that is not
registered. Registering the same type on the same queue twice stops the app at boot. The relay adds one job per route (the same id `outbox-<id>` on each queue,
which are separate id spaces), and marks the row relayed only when every route took its job. The job name on a queue is the event type unless `jobName` is given. The job data is `OutboxJobData`
(`src/modules/platform/outbox/outbox.types.ts`): `{ eventId, type, aggregateType, aggregateId, payload, requestId }`, where
`payload` is the ids the use case passed and `requestId` the request that wrote the event (`outbox-<event id>` when there was
none); the job id is `outbox-<event id>`.

| Event type | Queue | Job name | Payload (ids only) | Registered by |
|---|---|---|---|---|
| `merchant.email_verification` | `notifications` | `merchant.email_verification` | `tokenId` (aggregate: `clients`, the merchant) | identity (`MerchantMailOutbox`), written by `POST /client/auth/register` |
| `merchant.password_reset` | `notifications` | `merchant.password_reset` | `tokenId` (aggregate: `clients`) | identity (`MerchantMailOutbox`), written by `POST /client/auth/password/forgot` |
| `merchant.invited` | `notifications` | `merchant.invited` | `tokenId` (aggregate: `clients`) | identity (`MerchantMailOutbox`), written by `POST /admin/clients` (feature 2a) |
| `notification.send` | `notifications` | `notification.send` | none (aggregate: `notifications`, the row) | platform (`NotificationRoutes`), written by `NotificationService.enqueue` together with the row |
| `order.status_changed` | `merchant-webhooks`, `notifications` | `order.status_changed` on the webhooks, `notification.plan` on `notifications` | `orderId`, `clientId` (null for a storefront order), `fromStatus`, `toStatus` (aggregate: `orders`) | orders (`OrderOutbox`: the webhooks route, loaded by the API and the worker) and platform (`NotificationRoutes`: the notifications route); written by every transition that changes the status: accept, reply, reject, cancel, reopen, refund, verification refund. Consumers: the webhook fan-out (7b) and the order result notifications (12a) |
| `wallet.low_balance` | `merchant-webhooks`, `notifications` | `wallet.low_balance` / `notification.plan` | `clientId`, `currency`, `available`, `threshold` (aggregate: `ledger_accounts`) | platform (`MerchantEventRoutes` webhooks route, `NotificationRoutes` notifications route), written by the money module's `WalletLowBalanceWatch` |
| `service.price_changed` | `merchant-webhooks`, `notifications` | `service.price_changed` / `notification.plan` | `clientId`, `serviceId`, `previousPrice`, `price`, `currency` (aggregate: `services`) | platform (both routes), written by the catalog's price change scan |
| `order.dispatch_requested` | `supplier-dispatch` | `order.dispatch_requested` | `orderId` (aggregate: `orders`) | orders (`OrderOutbox`), written by placement of an automatic order with an active supplier link (and by a staff dispatch, feature 6). No processor yet: the dispatch job is feature 6 |
| `invoice.paid` | `merchant-webhooks` | `invoice.paid` | `invoiceId`, `clientId` (aggregate: `invoices`) | money (`InvoiceOutbox`, loaded by the API and the worker), written by every credit of a top-up: a staff approval (`POST /admin/payments/:id/approve`) and the automatic credit job. The fan-out re-reads the invoice (7b) |

`invoice.paid` (feature 8) routes to `merchant-webhooks` (`InvoiceOutbox`) and to `notifications` (`notification.plan`, registered by the platform's `NotificationRoutes` since the 12a merge): every credited top-up tells the merchant once. `deposit.approved` has a registry entry and default templates but no producer: a credited top-up already writes `invoice.paid`, and emitting both would send two messages per top-up (B-entry of 12a). A test app plans a job directly through `test/support/notifications.ts` (`eventJob`).

## Schedulers

Registered with `JobSchedulerRegistry.register` in `onModuleInit`; the worker upserts all of them on every boot (idempotent).

| Scheduler id | Queue | Job | Schedule | Owner |
|---|---|---|---|---|
| `outbox-relay-tick` | `outbox-relay` | `tick` | every second | platform (`src/modules/platform/outbox/`) |
| `ip-rule-hits-flush` | `maintenance` | `ip_rule_hits_flush` | every minute | identity (`src/modules/identity/security/ip-rules/`) |
| `session-purge` | `maintenance` | `session_purge` | daily 03:15 UTC | identity (`src/modules/identity/jobs/`) |
| `client-group-promotion` | `maintenance` | `client_group_promotion` | daily 03:30 UTC | identity (`src/modules/identity/jobs/`) |
| `payment-auto-credit` | `maintenance` | `payment_auto_credit` | every minute | money (`src/modules/money/jobs/`) |
| `service-checks` | `maintenance` | `service_checks` | every minute | health (`src/modules/health/jobs/`) |
| `service-checks-purge` | `maintenance` | `service_checks_purge` | daily 03:30 UTC | health (`src/modules/health/jobs/`) |
| `job-runs-reaper` | `maintenance` | `job_runs_reaper` | every 5 minutes | health (`src/modules/health/jobs/`) |
| `db-size-sample` | `maintenance` | `db_size_sample` | daily 03:45 UTC | health (`src/modules/health/jobs/`) |

## Adding a queue or a job

1. A new queue: add it to `QUEUES` in `src/infra/queues/queue-definitions.ts` and give it a section above (the test fails
   until the section exists and its numbers match).
2. A new job: write the processor in `src/modules/<id>/jobs/`, mark it `@QueueProcessor('<queue>', '<job name>')`, provide
   it in the module, and import that module in `src/worker.module.ts`. Replace the "none yet" lines of the queue section.
3. An event from a use case: `OutboxService.add(tx, { type, aggregateType, aggregateId, payload })`, and register the type
   (table above).
4. A schedule: `JobSchedulerRegistry.register({ id, queue, jobName, every | pattern })`; add a row to the table above.
5. Test it: an integration test that runs the processor twice (idempotency), and one that fails it once (retry).
