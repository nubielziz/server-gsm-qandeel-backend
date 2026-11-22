# Queues

Every piece of asynchronous work runs on one of twelve BullMQ queues on the **queue Redis** (decision 006: `noeviction`, AOF)
and is processed by the **worker process** only (decision 020). The code is in `src/infra/queues/`
(`README.md` there explains the API); this document lists every queue, job, payload, idempotency key, retry policy and
schedule, and is extended by the feature that adds a job. A test (`test/unit/infra/queues/queue-definitions.spec.ts`) fails
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
- **Failure text:** a job's stored failure (`failedReason`, its stack, `job_runs.error`) never carries a database statement or its
  values: the worker stores the sanitised error (SQLSTATE, table, constraint and a fixed sentence; decision 054).
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
| `notification-broadcasts` | 10 | 6 | 1 min, jitter 50 % | 1 |
| `search-index` | 1 | 8 | 30 s, jitter 50 % | 1 |

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
  makes an order dispatchable again: staff `dispatch`, `change-supplier` with `dispatch: true`, a risk release, and the `dispatch_sweep`'s
  new request for an order whose request was lost, decision 044). Ids only.
- **Idempotency:** the job id is `outbox-<event id>`. The run re-reads the order and does nothing unless it is open with `dispatch_state =
  'pending'`. It then claims the order with the guarded update `UPDATE orders ... WHERE dispatch_state = 'pending' AND sent_at IS NULL`
  (it sets `dispatch_state = 'dispatching'` with `sent_at`, pins `supplier_id`, `supplier_service_id` and refreshes `unit_cost` and
  `total_cost` from the chosen link; decision 044) BEFORE the supplier call, so two runs never send twice. The call is made outside any
  transaction; its answer moves the order in one transaction, and only while the order is `dispatching` with the `sent_at` of that claim: a
  REFERENCEID gives `sent` (status `processing`, `supplier_ref` stored once, an `ack` event), an explicit refusal or a timeout gives
  `needs_attention` (status unchanged, a `review` event with the reason, the hold kept). No eligible link, or a supplier too busy on the
  last attempt, stops a waiting order in `needs_attention` the same way. An answer that finds the order moved on (staff acted, the sweep
  moved it, a newer claim exists) is not applied; a late acceptance is recorded in its own transaction (the reference is stored where the order
  has none and still names that supplier, a `review` line names the supplier and the reference, an order waiting in `pending` for another
  send goes to `needs_attention` so that it is not sent twice, an error log line and an error report). A run that finds a claim of an earlier
  release (`pending` with `sent_at` set) never sends it again: it moves the order to `needs_attention`. A staff dispatch clears `sent_at` in
  the same transaction that queues the new job. A call log row that cannot be written is logged (error line) and reported and never stops the
  answer from being recorded. When the answer's own transaction fails for any reason other than "the order moved on" and the supplier accepted,
  the acceptance is kept the same way (the reference stored where the order has none, one `review` line that says the answer could not be
  recorded, an error log line and an error report; the order keeps its claim, so the sweep moves it later and staff can then fetch the result)
  and the original error fails the job: the retry finds the claim and sends nothing. If keeping the acceptance fails too, that is logged and
  reported and never rethrown.
- **Eligibility** (automatic dispatch only): the first active link by priority whose supplier is `active` (not paused, not disabled), whose
  supplier service is still listed by the supplier and whose cost (`credit x credit_rate`) is not above the price charged for one unit
  (user rule 9, B117 (6)); never a failover to a costlier link. An order that already names a supplier service (a staff choice) goes there as it
  is, whatever it costs.
- **Retry policy:** 3 attempts, exponential backoff from 5 s (jitter 50 %). Only a busy supplier (its semaphore or its rate limit is full, or
  its limits cannot be read because the cache Redis does not answer), or an answer that could not be recorded (after the acceptance was kept,
  and the retry sends nothing), throws, so the queue retries; on the last attempt such a supplier sends the
  order to `needs_attention` instead. A processor throws `UnrecoverableError` for a payload without an order id. A supplier timeout is never
  retried (decision 025). Stalled jobs are not re-run (`maxStalledCount` 0): the `dispatch_sweep` moves their order.
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
  - `staff.invited`, `staff.password_reset` (identity, `src/modules/identity/jobs/staff-mail.processors.ts`, feature 20, handled by `StaffMailJobs`): the invitation and the
    set-password link of a staff member. Built like the merchant mails: the job re-reads the member and the link, sends nothing when the member is gone or suspended, the link
    was used, voided or has expired, or its template is missing or switched off (and abandons the `queued` row of an earlier attempt), rotates the link's token on its `auth_tokens`
    row and sends the mail (`<CONSOLE_BASE_URL>/set-password?token=`) through `NotificationService.sendNow` with the clear link as a secret that is never stored or logged. One
    `notifications` row per mail (`outbox-<event id>:email`); a repeat after a delivered mail is skipped before it can spoil the link that arrived. Written by `POST /admin/staff`
    (onboarding `invite`) and `POST /admin/staff/:id/password` (`reset_link`, five an hour per member: limiter `account-mail`). Both processes load `StaffMailModule`.
  - The storefront money mails (feature 16, `StorefrontMails` in the money module) have no job of their own: `order.received` (the capture), `order.completed` and `order.failed` (the order
    transition, or the approval of a refund request for an order the system rejected), `payment.failed` (the gateway's failure event) and `refund.declined` (the decline) are written with
    `NotificationService.enqueue` in the transaction of the change they report, so each is a `notifications` row (dedupe key `order.received:<order>`, `order.completed:<order>:<n>`,
    `order.failed:<order>`, `payment.failed:<payment>`, `refund.declined:<refund>`) plus a `notification.send` event that commits and rolls back with the change.
  - The store balance mails (feature 21, `CustomerWalletMails` in the money module, events registered at boot by `CustomerWalletEventRegistration`, English
    templates) have no job of their own either: `wallet.topup_credited` (a credited top-up), `wallet.topup_rejected` (a rejected one), `wallet.adjusted` (a staff
    adjustment), `wallet.frozen` (a hold by staff or a top-up dispute) and `wallet.order_refunded` (a balance-paid order refunded to the balance, instead of
    `order.failed`) are written with `NotificationService.enqueue` in the transaction of the change (dedupe keys `wallet.topup_credited:<payment>`,
    `wallet.topup_rejected:<payment>`, `wallet.adjusted:<ledger tx>`, `wallet.frozen:<customer>:<frozen at ms>`, `wallet.order_refunded:order:<order>` or
    `…:refund:<refund>`) and go out through `notification.send`. Feature 21 adds no queue, job or outbox type.
  - `support.ticket_mail` (support, `src/modules/support/jobs/ticket-mail.processor.ts`, feature 17): sends a support ticket's receipt, a staff reply (email, or Telegram to a merchant's
    linked chat) or the satisfaction survey. It re-reads the ticket, the requester and the message, builds the ticket link from the ticket token and sends it through
    `NotificationService.sendNow` with the link as a secret that is never stored or logged (the `notifications` row has the other variables).
  - `checkout.recovery` (customers, `src/modules/customers/jobs/checkout-recovery.processors.ts`, feature 19): the one recovery email of an abandoned checkout. It re-reads the session,
    its customer and the marketing consent (consent is checked again at send time), builds the one-click link from the session token and sends the mail with the link as a secret that is never
    stored (the token is a bearer credential: it is not in the event, the job data or the `notifications` row).
  - `notification.campaign_fanout` (platform, `CampaignFanOutProcessor`, `src/modules/platform/notifications/campaigns/campaign-fan-out.ts`, feature 23): turns a
    queued notification campaign into in-app items (`notification_inbox`) and queued email and Telegram rows (`notifications.campaign_id`), chunk by chunk (500 people
    per chunk transaction, keyset by id over staff, then merchants, then customers, through the audience providers identity and customers register). Each chunk locks
    the campaign row `FOR UPDATE`, stops unless the campaign is `queued` or `sending` (a cancelled one stops at the next chunk), inserts its rows with
    `ON CONFLICT DO NOTHING` and moves the cursor (`fanout_cursor`, `chunks_done`, counters) in the same transaction; after the commit it hands the new rows to
    `notification-broadcasts` with `addBulk`. After 20 s it adds a continuation and ends; while the bulk queue holds more than 20 000 waiting jobs it adds a
    continuation delayed 15 s (backpressure, so the noeviction Redis stays bounded). Added by the relay for the outbox event `notification.campaign_fanout`
    (written by `POST /admin/notification-campaigns/:id/send` and by the `notification_campaign_sweep` job), by itself (continuations) and by the sweep (re-kick).
- **Payload:** `OutboxJobData` of the event (ids only). `notification.send` carries the row (`aggregateId` = the `notifications.id`; a digest job carries `{ notificationId }`). The
  merchant mail jobs carry `aggregateId` = the merchant and `payload.tokenId`; the customer mail jobs carry `aggregateId` = the customer and `payload.tokenId`; a ticket mail job carries `aggregateId` = the ticket and `payload.kind` (`received`, `reply` or `survey`), with `messageId` and `channel` for a reply; `checkout.recovery` carries `aggregateId` = the checkout session and no payload. `notification.campaign_fanout` carries `aggregateId` = the campaign (from the relay) or `{ campaignId, round }` (a continuation or a re-kick). Never a token, a link, an address or a message text: the job re-reads the row, the recipient and the
  active template.
- **Idempotency:** the outbox job id is `outbox-<event id>` (per queue). A `notifications` row has a `dedupe_key` (`outbox-<event id>:<channel>` for the planning job,
  `telegram-update-<update id>` for the bot's answer, `digest:<event>:<channel>:<merchant>:<day>` for a digest, unique where not null): a job that runs twice makes no second row.
  A send is guarded (`status = 'queued'` on the update): a row already `sent` or `failed` is skipped, so a job that runs twice records one send; the row's id is the
  `Message-ID` of the mail (`<notification-<id>@<domain of MAIL_FROM>>`), so a provider that dedupes drops the rare repeat after a crash between the provider's answer and the update.
  A digest job has the id `notification-<id>` and a delay up to the end of its period (06:00 UTC), at least 10 seconds (`MIN_DIGEST_DELAY_MS`: a job added before its transaction commits must not run before the row is visible); the send job closes the digest first (`payload.closed`), so a change that arrives
  later joins the next period's row. A merchant or customer mail job asks the row's status before it rotates the token, so a repeat after a delivered mail never spoils the link that arrived. A `checkout.recovery` job is guarded twice: `POST /admin/checkouts/recover` and the automatic reminder claim the checkout with `UPDATE checkout_sessions SET recovery_emailed_at ... WHERE recovery_emailed_at IS NULL` in the same transaction that writes the event (so one checkout has at most one event), and the mail's row has the dedupe key `outbox-<event id>:email`, so a job that runs twice sends once; a job that ends skipped without sending (consent withdrawn, template off, customer no longer active, checkout paid) marks the row of an earlier attempt `failed` with the reason and, in one transaction and only if no row of the event was `sent`, sets `recovery_emailed_at` back to null, so the checkout is recoverable again and a later send can try again.
- **Idempotency of the fan-out:** a chunk that runs twice makes nothing twice (the partial unique keys `notification_inbox (campaign_id, recipient_type,
  recipient_id)` and `notifications.dedupe_key` = `campaign-<campaign>:<channel>:<type>-<recipient>`), and two fan-out jobs of one campaign are serialized by the row
  lock, each taking the next chunk. Job ids: `outbox-<event id>`, `campaign-fanout-<campaign>-<chunks done>` (a continuation),
  `campaign-fanout-<campaign>-<chunks done>-w<round>` (a backpressure pause), `campaign-fanout-<campaign>-r<epoch minute>` (a re-kick). A stored audience that
  no longer parses, or a recipient type without a provider, marks the campaign `failed` and ends the job (`UnrecoverableError`).
- **Retry policy:** 5 attempts, exponential backoff from 30 s (jitter 50 %). A transient failure (an SMTP 4xx or a dropped connection, a Telegram 429 or 5xx, a timeout) records the
  attempt on the row and throws, so the queue retries; the last attempt marks the row `failed` with the reason and throws. A refusal that cannot change (an SMTP 5xx, a Telegram
  400, 403 or 404, a missing template, no address, a recipient that is gone) marks the row `failed` at once and ends the job. The queue's own backoff applies as it is: a provider's
  `retry_after` (Telegram's is a few seconds) is shorter than the first wait, so the processors do not read it.
- **Schedule:** none (event-driven).

## notification-broadcasts

Sends the emails and Telegram messages of notification campaigns (feature 23), apart from the transactional `notifications` queue: BullMQ's
limiter is per queue, so a broadcast of 50 000 messages never slows a password reset or an order mail.

- **Concurrency:** 10 per worker process.
- **Limiter:** at most 30 jobs start per second across every worker of the queue (`QUEUES['notification-broadcasts'].limiter`, BullMQ's worker
  `limiter`). The per-channel budget is lower: each job takes one point of the system-wide limiter `broadcast-email` (5 a second) or
  `broadcast-telegram` (20 a second), whose size comes from the settings `notifications.broadcast_email_per_second` and
  `notifications.broadcast_telegram_per_second` (1-30). A refused take waits `retryAfter` with the injected timers and tries again, at most 30
  times, then throws a transient error (the queue retries); a message is never dropped for want of budget.
- **Jobs:** `notification.send` (`BroadcastSendProcessor`, `src/modules/platform/notifications/campaigns/broadcast-send.processor.ts`): sends one campaign
  row of `notifications` through `NotificationDelivery.deliver`, whose campaign branch re-reads the campaign (cancelled: the row fails with
  `The campaign was cancelled.`), the recipient and its eligibility now (suspended, consent withdrawn for marketing, the merchant's announcement switch
  turned off: the row fails with the reason), renders the campaign (one title and one body, English) and sends it. Added by the
  campaign fan-out with `QueuesService.addBulk`, after each chunk's commit.
- **Payload:** `{ notificationId, channel }` (the row and `email` or `telegram`; never an address or a text).
- **Idempotency:** the job id is `notification-<row id>`, so the fan-out, a repeated chunk or a later re-add makes one job per row. The send is guarded
  (`status = 'queued'` on the update) and the mail's `Message-ID` is the row's, as on `notifications`.
- **Retry policy:** 6 attempts, exponential backoff from 1 min (jitter 50 %). A provider's short `retry after` (30 s or less, a Telegram 429) is waited
  for once inside the same attempt; any other transient failure goes to the queue's backoff; the last attempt marks the row `failed`. A permanent
  refusal marks the row `failed` at once.
- **Schedule:** none (event-driven, from the fan-out).
- **Not recorded in `job_runs`:** event-driven; the `notifications` rows and the campaign's `delivery` counters are the record.

## search-index

Applies catalog, listing and search settings changes to the storefront search engine (feature 29, decision 038: Typesense holds derived,
public, price-free documents; Postgres is the truth).

- **Concurrency:** 1 per worker process. `search_sync` is the only writer of documents through the services alias
  (`<prefix>services_v<N>`), so two writes never race on one document; the reconcile only compares and enqueues `search_sync`, and the
  rebuild writes only its own new collection (both on `maintenance`, below).
- **Jobs:** two named processors (`src/modules/storefront/search/jobs/search-index.processor.ts`):
  - `search_sync` (`SearchSyncProcessor`, logic `SearchSync.run`): the job of the outbox events `catalog.services_changed`, `catalog.category_changed` and
    `storefront.listing_changed` (the relay names the job `search_sync`), and of the reconcile's `{ serviceIds }` jobs. A category event is resolved to
    the category's service ids (`StorefrontServices.serviceIdsOfCategory`, keyset pages of 500). Each batch of ids is built from Postgres
    (`SearchDocuments.build`: the searchable rule, the English listing, the option labels, the stock flag); the ids that fail the rule are **deleted
    first** (`filter_by=id:[...]`, 250 per request), then the documents are imported with `action=upsert` in batches of 500.
  - `search_settings` (`SearchSettingsProcessor`, logic `SearchSettingsPush`): the job of `search.settings_changed { kind }`. `synonyms` and `pins` put
    the whole set of enabled rows (`PUT /synonym_sets/<prefix>synonyms`, `PUT /curation_sets/<prefix>curations`; every pin rule carries
    `filter_curated_hits: true` and `remove_matched_tokens: false`) and then move the cache version `search`; `hidden_terms` deletes the popular-searches
    cache key and enqueues `search_terms_build` on `maintenance` (job id `terms-hidden-<event id>`).
- **Payload:** the `OutboxJobData` of the event (`payload: { serviceIds, reason }` with 1-50 ids and `reason` one of `service`, `price`, `options`,
  `stock`; `{ categoryId }`; `{ serviceIds }`; `{ kind }`), or `{ serviceIds }` (at most 500 ids) from the reconcile. Ids only.
- **Idempotency:** the job id is `outbox-<event id>` (relay) or `reconcile-<run id>-<n>` (reconcile). The job re-reads every fact from Postgres and writes
  whole documents (upsert) and deletes by id (an absent id deletes nothing), so a repeat or a late run writes what Postgres says now; a set push replaces
  the whole set.
- **Retry policy:** 8 attempts, exponential backoff from 30 s (jitter 50 %), about an hour in all; then the job sits in the failed list (the console's
  queues page) and the next reconcile repairs the index anyway. `SearchUnavailable` (connection, timeout, 5xx, a refused key, a node out of disk)
  throws and is retried; a 401/403 also sets `search_index_state.last_error = 'search keys missing'` and counts `search_auth_failures_total`. A
  missing alias (`SearchNotReady`) completes without writes (result `not_ready`): the rebuild and its reconcile cover the change. A refused document line
  never stops the others: its id and error go to `search_index_state.last_error` and `search_sync_rejected_total`, and the job completes. A refusal of
  the whole request (another 4xx) is an `UnrecoverableError` with `last_error`. With `SEARCH_ENABLED=false` every job completes at once without a call.
- **Schedule:** none (event-driven).
- **Not recorded in `job_runs`:** event-driven, like the supplier dispatch; `search_index_state.last_sync_at`, `last_error` and the metrics
  `search_sync_documents_total{op}`, `search_sync_failures_total`, `search_sync_rejected_total` and `search_sync_lag_seconds` (BullMQ's enqueue time of
  the job to written) are the record. A `job_runs` guard would also skip a sync while a stale run stays `running`, which would lose a change.

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
  moves the catalog price version after the commit; nothing is written unless both supplier calls worked. In the same transaction it adopts the
  supplier's main box on the IMEI services made before decision 042 (feature 33: type `server`, the box first, one `catalog.services_changed`
  event and one audit row each); an adopted service no longer matches, so a repeat adopts none. It is safe to repeat. A staff request
  has the job id `manual-sync-<supplier id>-<ms>` and `attempts: 1` (a click is its own retry); `supplier_sync` returns its outcome (a supplier
  failure is a value, so the API answers `409 SUPPLIER_UNAVAILABLE`), and the API answers `504 SUPPLIER_TIMEOUT` when the job is still
  running after `timeout_ms + 5 s` (the job goes on).
- **Retry policy:** 3 attempts, exponential backoff from 1 min (jitter 50 %).
- **Schedule:** `supplier-price-sync` (`*/15 * * * *`) and `supplier-balance-check` (`*/30 * * * *`) (`src/modules/suppliers/jobs/supplier-jobs.module.ts`).

## imports

Runs bulk imports (service lists, inventory codes) started by staff.

- **Concurrency:** 2 per worker process.
- **Jobs:** `supplier_quick_add` (suppliers module, feature 26, B214): adds a supplier's services to the catalog by group, or all of
  them, in chunks of 100. Event-driven: the outbox event `supplier.quick_add`, written by `POST /admin/suppliers/:id/quick-add` in the
  same transaction that inserts the run (job id `outbox-<event id>`). The processor is `QuickAddProcessor` (`src/modules/suppliers/jobs/`),
  which calls `QuickAddRunner.run(runId)`. Other bulk imports (service lists from files, inventory codes) are built by their features.
  `publish_prepare`, `publish_apply` and `publish_set_listed` (storefront module, feature 31, decision 040): the bulk publish.
  `publish_prepare` prepares the draft of a new run: it takes the services of the run's scope, names and evaluates every one and closes
  the run as a `draft` (or, for an automatic run with a row ticked, as `queued`, with the apply event); it writes only the run and its
  rows, so a preview changes nothing a visitor or a merchant can see. `publish_apply` publishes the
  rows of a queued run, one service per transaction, in chunks of 50; `publish_set_listed` takes everything a run published off the shop,
  or puts it back. Event-driven: the outbox events `storefront.publish_prepare`, `storefront.publish_apply` and `storefront.publish_set_listed`,
  written in the transaction that creates or moves the run (job id `outbox-<event id>`). The processors are `PublishPrepareProcessor`,
  `PublishApplyProcessor` and `PublishSetListedProcessor` (`src/modules/storefront/publish/jobs/`), which call
  `PublishPreparer.run(runId)`, `PublishRunner.run(runId)` and `PublishSwitch.run(runId, listed, requestedBy)`.
  `publish_from_quick_add` (storefront module, feature 31, plan 31 section 6.3): the Quick add hand-over. A Quick add run that asked to
  publish and created at least one service writes the outbox event `supplier.quick_add_done` in the transaction that closes it (succeeded or
  failed, and the start that closes a stalled run); the job inserts the one automatic publish run of it (`source = quick_add`, scope
  `quickAddRun`, `auto`) and calls `PublishPreparer.run`, whose close queues `storefront.publish_apply` when a row is ticked. The processor
  is `PublishFromQuickAddProcessor`, which calls `PublishFromQuickAdd.run`.
- **Payload:** ids only: `runId` (the `supplier_import_runs` row, also the outbox aggregate id) and `supplierId`. The scope, the groups
  and the state the services start in are read from the run row. `publish_prepare`: `runId` (the `listing_publish_runs` row, also the
  outbox aggregate id). `publish_apply`: `runId` (the `listing_publish_runs` row, also the
  outbox aggregate id). `publish_set_listed`: `runId`, `listed` (the target) and `requestedBy` (the staff member who pressed the button,
  or null). `publish_from_quick_add`: `runId` (the `supplier_import_runs` row, also the outbox aggregate id), `supplierId`, `requestedBy`
  (the staff member who started the Quick add, or null) and `listed` (whether the publish switches the listings on). Everything else is read
  from the run and its rows.
- **Idempotency:** the run claims itself with `UPDATE ... SET status = 'running' WHERE id = $1 AND status = 'queued'`; no row, no work
  (a second delivery, two runners, or a run closed by a newer start). Every chunk is one transaction: it locks the supplier row first
  (as the picker's import and the sync), re-reads the supplier services and their links, creates only what is still not imported,
  available and of an importable type, and advances the run with a guarded `UPDATE ... WHERE status = 'running'` (the counts and the
  heartbeat). When that update matches no row the run was closed by a newer start: the chunk rolls back and the runner stops. A chunk
  that throws is retried item by item; an item that throws again is counted `failed` (at most 20 are listed, and 20 failed items end the
  run `failed`). A rerun after a failure takes what is left, because the candidates are the services that are not imported yet.
  The draft is claimed the same way before it is prepared: `UPDATE ... SET prepare_claimed_at = <now>, heartbeat_at = <now> WHERE id = $1 AND
  status = 'preparing' AND prepare_claimed_at IS NULL`; no row, no work (a second delivery, or a run that was cancelled). Its rows are
  inserted `ON CONFLICT DO NOTHING` in batches of 500 and written by one `UPDATE ... FROM (VALUES ...)` per 200 rows; every batch and page
  moves the heartbeat with a guard on `preparing` (no row: the run was cancelled, the worker stops), and the close is guarded on
  `preparing` too. A worker that dies leaves the claim set, so a repeat does nothing and the run reads `failed`: staff start a new
  preview. An unexpected error closes the run `failed` with the error and rethrows. When that run was a "Check again", staff send the
  same scope again ("Prepare again"): the route copies the old draft once more and, if the dead run is still stored `preparing`, closes
  it `failed` in the same transaction, so a worker that wakes up stops at its next guarded statement.
  A publish run keeps its id across a resume, so its claim counts: `UPDATE ... SET status = 'running', attempt = attempt + 1 WHERE id = $1
  AND status = 'queued' RETURNING attempt`, and every later write of that worker requires `status = 'running' AND attempt = <its number>`.
  A worker that was only slow, and wakes up after staff pressed Continue, finds another number and stops without writing. Each row is one
  transaction in the lock order of the feature: the `services` row `FOR UPDATE`, the run row `FOR SHARE` (with the check above), the item
  row `FOR UPDATE` with `result IS NULL`, the listing; its result is written there, `WHERE result IS NULL`. A cancel or a resume takes the
  run row `FOR UPDATE`, so it waits for the row in flight. A row that throws is tried once more after a deadlock or a serialization failure
  (`40P01`, `40001`), else it ends `refused: failed` with the constraint's name; 20 of them in one attempt close the run `failed`. The
  close takes the run row and writes the counters from the rows. The run switch claims with `switch_status = 'queued' AND switch_listed =
  <its target>`, raises the same `attempt`, and re-reads each listing under the service lock: a listing already at the target is left
  alone, so a repeat changes nothing. The hand-over inserts `ON CONFLICT (source_run_id) WHERE source_run_id IS NOT NULL DO NOTHING` (the
  partial unique index `listing_publish_runs_source_run_uq`; the conflict target repeats its predicate), so a second delivery finds the run
  and does nothing, and the preparer's own claim lets one worker prepare it. A run and its switch share one heartbeat, so the resume of a run closes a switch that stalled
  (`failed`): its late job then finds nothing to claim and cannot stop the resumed apply.
- **Recorded in:** `supplier_import_runs`, not in `job_runs`: the run has a supplier, a scope and a progress that `job_runs` has no
  column for, its overlap guard is per job name, and it is closed only at the end. One live run (`queued` or `running`) per supplier
  is a partial unique index. Every chunk moves `heartbeat_at`; a live run without a heartbeat for 5 minutes reads as `failed`
  (`GET /admin/suppliers/:id/quick-add/:runId` and `service-groups` show it so, without writing), and the next start closes it. A
  publish run is recorded the same way, in `listing_publish_runs` and `listing_publish_items` (each row's result); `heartbeat_at` moves
  after every batch and page of the prepare, every chunk of the apply and of the switch, and five minutes without one read as `failed` too
  (a run that stalled while `preparing` says to start a new preview).
- **Retry policy:** 1 attempt, no retry. Stalled jobs are not re-run (`maxStalledCount` 0). Staff start it again: it continues with what
  is left (an import records its progress and is started again by staff, so it is never retried automatically). A publish run goes on
  from the rows that have no result, and a run switch is pressed again.
- **Schedule:** none (started by staff).

## files

Processes uploaded and generated files (exports, result files).

- **Concurrency:** 4 per worker process.
- **Jobs:** `receipt.render` (money module, below). Built by the orders and platform features: `export` for CSV exports and result-file handling.
- **Payload:** `{ invoiceId }` for `receipt.render` (aggregate: `invoices`); the others none yet (file id).
- **Idempotency:** `receipt.render`: the job id is `outbox-<event id>`, the invoice row is locked and `pdf_file_id` re-read under the lock, so a repeat (or a download that made the copy first) stores nothing twice. Rule for the others: job id `file-<file id>`; the output is written under a key derived from the file id.
- **Retry policy:** 3 attempts, exponential backoff from 10 s (jitter 50 %).
- **Schedule:** none (event-driven).

### `receipt.render` (money module)

Draws the PDF tax receipt of a paid storefront order and stores it (`GET /store/v1/orders/:token/receipt`, RESOLUTIONS money-7, decision 030).

- **Trigger:** the outbox event `receipt.render`, written in the capture's transaction together with the receipt invoice (`StorefrontPayments.recordCapture`), so the gateway's webhook is answered as soon as the capture commits and never waits for the render or the upload. A duplicate payment for an already paid checkout issues no receipt and writes no event: an order has one paid receipt. The processor is `ReceiptRenderProcessor` (`src/modules/money/jobs/`), loaded by the worker through `ReceiptRenderModule`.
- **Payload:** `{ invoiceId }` (aggregate: `invoices`). The job re-reads the invoice, the order, the customer and the payment.
- **What it does:** under the invoice's row lock, draws the PDF from the invoice's own numbers and stores it in `files` (owned by the customer), then sets `invoices.pdf_file_id`. An invoice that is gone or has no customer is skipped.
- **Idempotency:** see the `files` queue above. The download route keeps its fallback: if the job has not stored the copy yet (or failed every attempt), the first download makes it, under the same lock, once; `503 UNAVAILABLE` when the storage is down.
- **Retry policy:** the `files` queue's (3 attempts, backoff from 10 s). A storage failure is thrown so the queue retries; a payload without an invoice id is an `UnrecoverableError`.
- **Not recorded in `job_runs`:** event-driven; the invoice's `pdf_file_id` is the record.

## maintenance

Scheduled housekeeping: group promotion, data retention, integrity checks, FX refresh.

- **Concurrency:** 2 per worker process.
- **Jobs:** `ip_rule_hits_flush`, every minute, `session_purge`, daily at 03:15 UTC, `client_group_promotion`, nightly at 03:30 UTC (identity module, below), `payment_auto_credit`, every minute, and `fx_refresh`, hourly, and `refund.process`, event-driven (money module, below), `checkout_recovery_sweep`, every 5 minutes (customers module, below), `notification_campaign_sweep`, every minute, `notification_reconcile`, every 5 minutes, and `notification_retention`, daily at 04:20 UTC (platform module, feature 23, below), `service_price_scan`, event-driven (catalog module, below), `retail_price_follow`, after a price change and every hour, and `category_names_clean`, once, asked for by a migration (catalog module, feature 31, below), `field_patterns_review`, once, asked for by a migration (catalog module, feature 41, below), `checkout_tokens_seal`, `tracking_tokens_seal` and `ticket_tokens_seal`, once, asked for by a migration (customers, orders and support modules, feature 44, below), and the four health jobs `service_checks` (every minute), `service_checks_purge` (03:30 UTC), `job_runs_reaper` (every 5 minutes) and `db_size_sample` (03:45 UTC) (health module, below), `support_reply_mail_sweep`, every minute, and `ticket_attachment_retention`, nightly at 03:30 UTC (support module, feature 28, below), `dispatch_sweep`, every minute (suppliers module, decision 044, below), and the storefront search jobs `search_reconcile` (every `SEARCH_RECONCILE_MINUTES`, default 15, and once at worker boot), `search_rebuild` (nightly at 03:40 UTC, and on demand), `search_terms_build` (hourly at :20), `search_terms_flush` (every 15 minutes) and `search_terms_purge` (daily 04:10 UTC) (storefront module, feature 29, below). The others are built by their features, each
  registered with `@QueueProcessor('maintenance', '<job name>')` and wrapped with `JobRunsService.run`:
  `ledger_integrity` (12b, nightly 02:30 UTC, below), `accruals` (daily 01:00 UTC), `reminders` (every 10 minutes). `idempotency_purge` (daily 04:10 UTC,
orders module, below) is built. `storefront_popularity` (every 30 minutes, storefront module, below) is built. `data_retention`
  (nightly 03:00 UTC, risk module, below) is built. The names are the
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
- **Schedule:** `idempotency-purge` at 04:10 UTC (`src/modules/orders/jobs/idempotency-purge.module.ts`);
  `ip-rule-hits-flush` every minute (`src/modules/identity/security/ip-rules/ip-rule-hits-flush.module.ts`);
  `session-purge` at 03:15 UTC (`src/modules/identity/jobs/session-purge.module.ts`);
  `client-group-promotion` at 03:30 UTC (`src/modules/identity/jobs/group-promotion.module.ts`);
  `payment-auto-credit` every minute (`src/modules/money/jobs/payment-auto-credit.module.ts`); `supplier-dispatch-sweep` every minute
  (`src/modules/suppliers/jobs/supplier-jobs.module.ts`); `fx-refresh` every hour at minute 0
  (`src/modules/money/jobs/fx-refresh.module.ts`); `checkout-recovery-sweep` every 5 minutes
  (`src/modules/customers/checkout-recovery.module.ts`); `notification-campaign-sweep` every minute
  (`src/modules/platform/notifications/campaigns/campaign-engine.module.ts`); the health jobs in
  `src/modules/health/jobs/health-jobs.module.ts`; `support-reply-mail-sweep` every minute and `ticket-attachment-retention` at 03:30 UTC
  (`src/modules/support/support-jobs.module.ts`); the others are registered with `JobSchedulerRegistry` by the owning
  features.

### Storefront popularity (storefront module, `src/modules/storefront/jobs/`)

- **`storefront_popularity`** (every 30 minutes, scheduler `storefront-popularity`, `PopularityRefresh`; feature 22): the best-seller sort of the
  public catalog (`GET /store/v1/services?_sort=popular`). The job counts the non-rejected orders (every channel, merchants included) created in the
  last 30 days per service (`salesCountsByService`, the storefront's documented foreign read of `orders`; cutoff = clock now - 30 days) and stores the count in
  `service_listings.sales_30d` of every listing row of the service. One statement writes only the rows whose value differs (`is distinct from`)
  and takes their row locks in id order (`order by id for update`, the order listing writers use), never touches `updated_at`, and never takes the
  service row lock. A repeat or a parallel run changes nothing more. The run is recorded in `job_runs` (`processed` = rows changed, `result` =
  `{ services, changed }`); a manual run carries `{ runId }`. Retry policy: the `maintenance` queue's. The shop shows the order only, never the number.

### Storefront search (storefront module, `src/modules/storefront/search/jobs/search-maintenance.processors.ts`; feature 29)

None of these writes documents through the services alias (the `search-index` queue's `search_sync` does). Each run is wrapped with
`JobRunsService.run` (a manual run carries `{ runId }`; a run that finds its lock held, or `SEARCH_ENABLED=false`, records `skipped`).

- **`search_reconcile`** (scheduler `search-reconcile`, every `SEARCH_RECONCILE_MINUTES` minutes, default 15; also once at worker boot with the job id
  `boot-<boot id>`; after a rebuild `after-rebuild-<run id>-reconcile`): holds the cache-Redis lock `gsm:{env}:storefront:search-index:lock`. When the alias
  of the running schema version is missing it enqueues `search_rebuild` (job id `rebuild-auto-v<N>-<yyyymmddhh>`, one per hour at most) and stops.
  Otherwise it exports `id,hash` through the alias, builds the hash of every expected document from Postgres (`StorefrontServices.pricedPage`, keyset
  pages of 1000 with no ceiling, and `SearchDocuments.build`), and enqueues `search_sync` jobs of at most 500 ids for the changed, missing and extra ids
  (job ids `reconcile-<run id>-<n>`). Then it reads `/metrics.json` and `/debug` and writes `documents`, `memory_bytes`, `engine_version` and
  `last_reconcile_at` into `search_index_state`. Payload: none, or `{ runId }`.
- **`search_rebuild`** (scheduler `search-rebuild-nightly`, daily 03:40 UTC; the console's "Rebuild index" through the outbox event
  `search.rebuild_requested { staffId, runId? }`; the reconcile above): holds the same lock. It pushes the synonym and curation sets, drops every collection
  of the prefix that is not an alias target (orphans of a stalled run, so never three collections), creates a services collection of the running version
  (`SearchCollections.create`, the only creator, which links both sets), imports every document built from `pricedPage` into **that collection only**,
  checks that the collection holds exactly the built count with no refused line (else it drops it, keeps the old alias and records `last_error`: an
  `UnrecoverableError`), swaps the alias (`PUT /aliases`, no failed search during it), drops the older collections of this version and every collection
  and alias of older versions, releases the lock and enqueues `search_terms_build` and `search_reconcile` (job ids `after-rebuild-<run id>-terms` and
  `-reconcile`): the reconcile turns the changes made during the build into `search_sync` jobs.
- **`search_terms_build`** (scheduler `search-terms-build`, hourly at :20; after a rebuild; after a hidden-term change, job id `terms-hidden-<event id>`):
  holds `gsm:{env}:storefront:search-terms:lock`, builds the terms (title phrases, facet values, synonym phrases, popular queries of
  `search_terms_daily`) into a new terms collection and swaps `<prefix>terms_v<N>` the same way; it is the only writer of terms collections.
- **`search_terms_flush`** (scheduler `search-terms-flush`, every 15 minutes): for today and yesterday (UTC) reads the day's counter hash
  `gsm:{env}:storefront:search-terms:{yyyymmdd}` and the `PFCOUNT` of each term's visitors, and upserts **absolute** values into `search_terms_daily`
  (`searches`, `zero_results`, `visitors` set, never added): a retry or a second run writes the same rows. No `RENAME`; the Redis keys expire by TTL.
- **`search_terms_purge`** (scheduler `search-terms-purge`, daily 04:10 UTC): deletes the `search_terms_daily` rows older than 180 days.

### Idempotency purge (orders module, `src/modules/orders/jobs/`)

- **`idempotency_purge`** (daily 04:10 UTC, scheduler `idempotency-purge`, `IdempotencyPurge`; P4a, MISMATCHES B166): a REST v1 `Idempotency-Key` is remembered
  for 7 days (`IDEMPOTENCY_WINDOW_DAYS`). The job takes the cutoff `clock now - 7 days` and (1) sets `orders.idempotency_key` to NULL on the orders
  placed before it (`placed_at`), then (2) deletes the `idempotency_keys` rows created before it (`created_at`, written from the clock by the
  placement), each in batches of 1000 rows per statement until a batch comes back short. The orders are cleared first so a request that arrives
  between the steps still finds its stored answer (a replay) instead of meeting the old order's unique index; afterwards the key is free again for that
  merchant (a new order, not a replay). The window does not wait for this job: `IdempotencyStore.run` forgets an expired key itself when a
  request meets it (same cutoff, same strict `<`), so the job only cleans the keys nobody sends again. `updated_at` of the orders is left alone. Payload: none (a manual run carries `{ runId }`).
  Idempotent: a cleared or deleted row is not matched again, a parallel run finds fewer rows. Recorded in `job_runs` (`processed` = answers deleted plus
  order keys cleared, `result` = `{ answers, orderKeys }`). Indexes: `idempotency_keys_created_idx`, `orders_idempotency_placed_idx` (partial, keyed orders only).

### Data retention (risk module, `src/modules/risk/jobs/`)

- **`data_retention`** (daily 03:00 UTC, `ImeiRetention`): reads the setting `imeiRetentionDays` (a whole number from 0 to 3650, default 180,
  `0` means do not keep) and sets `imei_enc`, `imei_hash` and `cached_until` of every `imei_checks` row created before the cutoff (the
  clock's time minus the days) to NULL together, in batches of 1000 by id, at most 50 batches a run (a larger backlog continues the next
  night). Payload: none (a manual run carries `{ runId }`). Idempotent: an erased row is not matched again, a parallel run finds fewer rows.
  Recorded in `job_runs` (`processed` is the number of checks erased). The staff log then shows the TAC and bullets.

### Support chat (support module, `src/modules/support/jobs/`, feature 28)

- **`support_reply_mail_sweep`** (every minute, scheduler `support-reply-mail-sweep`, `ReplyMailSweep`): the email fallback of staff replies
  (rule 9 of plan 28). A staff reply on channel `email` writes no outbox event; it sets `support_tickets.reply_mail_due_at` to
  `coalesce(reply_mail_due_at, now + support.replyEmailDelayMinutes)` (default 5, 0 to 1440; `0` writes today's event at once). The sweep
  takes the tickets with `reply_mail_due_at <= now` in id order, `FOR UPDATE SKIP LOCKED`, 100 a pass (index
  `support_tickets_reply_mail_due_idx`), and per ticket, in the pass's transaction: the public staff messages with `notify_channel = 'email'`
  and an id above `greatest(requester_seen_message_id, reply_mailed_message_id)`; none clears `reply_mail_due_at`, else it writes one
  `support.ticket_mail` event (`kind: 'reply'`, `channel: 'email'`, `messageId` the last, `fromMessageId` the first), sets
  `reply_mailed_message_id` to the last and clears the due time (`updated_at` stays). Payload: none (a manual run carries `{ runId }`).
  Idempotent: a handled ticket is no longer due, its mailed replies are below `reply_mailed_message_id`, and a parallel sweep skips the locked
  rows, so one reply is mailed once. Recorded like `checkout_recovery_sweep`: only a tick that found a due ticket, and every manual run, writes
  `job_runs` (`processed` = mails queued, `result` = `{ tickets, mailed, seen }`). A Telegram reply is sent at once as before and never mailed.
- **`ticket_attachment_retention`** (daily 03:30 UTC, scheduler `ticket-attachment-retention`, `TicketAttachmentService.applyRetention`): rule
  10. Reads `support.attachmentRetentionDays` (0 to 3650, default 180; `0` keeps every attachment) and, for the tickets resolved before the
  cutoff (clock now minus the days) that still have files, empties `ticket_messages.file_ids` and deletes the `files` rows nothing else uses
  (the objects after the commit, best effort), in batches of 200 tickets (`FOR UPDATE SKIP LOCKED`), at most 25 batches a run. Payload: none
  (a manual run carries `{ runId }`). Idempotent: an emptied message is not matched again, a parallel run skips the locked tickets. Recorded in
  `job_runs` like `data_retention` (`processed` = files deleted, `result` = `{ days, tickets, files }`).

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

### Alerts and integrity jobs (health module, feature 12b)

- **`alert_evaluation`** (queue `alerts`, every minute, `AlertEvaluator.evaluateAll`): judges every active alert rule over its window and opens or closes
  `alert_events` (see the module README, "Alerts and integrity"). Wrapped with `JobRunsService.run` (one `job_runs` row per run, `skip` while another is
  going): `processed` = rules judged, `result` = `{ rules, evaluated, unevaluated, unevaluatedRules, fired, resolved }`. `unevaluated` counts the active rules
  whose metric could not be read (Prometheus down, a store not answering); the System health page does not read "no open alerts" as healthy while a run
  has unevaluated rules (M213). A source that fails skips only its rules; Postgres being down fails the run. A reading of the moment (`supplier.balance`,
  `queue.oldest_age`, `orders.past_sla`, `db.connection_usage`, `redis.memory_usage`) fires and resolves only after it held for the rule's whole window:
  the start of the stretch is a row of `alert_streaks`. The scheduler sets `removeOnComplete` to one hour.
- **`ledger_integrity`** (queue `maintenance`, nightly at 02:30 UTC and on demand, `LedgerIntegrityCheck`): the four money checks (entries sum to zero,
  accounts match their lines, no hold stuck over 24 hours, every confirmed payment has an entry). A manual run is inserted by `POST /admin/system/integrity/run`
  (`job_runs` `manual`, `running`, the staff member) and enqueued with the job id `manual-<run id>` and `{ runId }`. `processed` = accounts checked,
  `result` = counters at the top level (`failedChecks`, `mismatchCount`, `accountsChecked`, `entriesChecked`, `transactionsChecked`, one count per check) and the
  four checks with their first 20 findings under `checks` (B99). Read-only: it never corrects anything. After a succeeded run the processor judges the
  `ledger.mismatch_count` rule at once. Idempotent: a repeat only records another run; a retry of a finished manual run changes nothing.

### `payment_auto_credit` (money module)

Credits the wallet of confirmed top-ups of automatic gateways by themselves (user rule 6, RESOLUTIONS money-3).

- **Trigger:** the scheduler `payment-auto-credit` every minute. A tick lists the pending top-ups whose `auto_credit_at` has come and that are not `review_required` (at most 50, oldest due first; the partial index `payments_auto_credit_idx` covers it). `auto_credit_at` is the confirmation time plus the larger of the setting `payments.auto_credit_delay_minutes` (default 10) and the gateway's `hold_hours`.
- **Payload:** none (a manual run carries `{ runId }`). The job reads everything it needs from Postgres.
- **What it does, per payment:** asks the gateway's API again through the driver (no row lock is held across the call); then, under `SELECT ... FOR UPDATE` on the payment, re-checks that it is still pending and not flagged and (a) credits it (`deposit` from `gateway_clearing`, key `deposit:payment:<id>`, invoice paid, `invoice.paid` outbox row, audit `credited deposit of` by the system) when the gateway still says confirmed (a crypto gateway only after its required confirmations), (b) sets `review_required` with the reason (audit `sent deposit to review`) when the gateway no longer confirms, the invoice is no longer payable, the payment stayed unconfirmed for 24 hours, or risk flags it (just before the credit, still under the lock, the job asks money's `TopUpScreeningHooks`, which the risk services module fills with `RiskScreening.reviewTopUp`: the payment's card fingerprint and the merchant's email against the blocklist; nothing is posted), or (c) moves `auto_credit_at` 5 minutes ahead while the gateway has not confirmed yet or cannot be reached.
- **Idempotency:** the payment row lock plus the unique ledger key make a double credit impossible, whether two ticks overlap or a staff decision races the job (the loser changes nothing; staff get `PAYMENT_ALREADY_REVIEWED`). A failure of one payment never stops the others; it stays due for the next tick.
- **Recorded in `job_runs`** (job `payment_auto_credit`, `processed` = payments credited, `result` = the counts) only for a tick that had payments due and for every manual run: a run every minute with nothing due would bury the jobs list (like the outbox tick, decision 020). Retry policy: the queue's (3 attempts, backoff from 1 min); the next minute's tick is the real retry.

### `dispatch_sweep` (suppliers module, decision 044)

Moves the supplier sends that lost their answer or their request (`DispatchSweep`, `src/modules/suppliers/application/dispatch-sweep.ts`; processor `DispatchSweepProcessor`, `src/modules/suppliers/jobs/`).

- **Trigger:** the scheduler `supplier-dispatch-sweep` every minute, or a manual run (`POST /admin/system/jobs/dispatch_sweep/run`).
- **Payload:** none (a manual run carries `{ runId }`).
- **What it does** (at most 100 orders per rule per run, oldest first; it plans without writing, then moves each order in its own transaction through the state machine):
  (a) an open order `dispatching`, or `pending` with `sent_at` set by an earlier release, whose `sent_at` is older than its supplier's `timeout_ms` plus 2 minutes goes to
  `needs_attention` with "A send was started but its answer was not recorded. Check the supplier, then fetch or send the order again."; it is never sent again automatically and the hold stays;
  (b) an open order `pending` with `sent_at` empty, placed more than 5 minutes ago, that has at least one dispatch request, whose newest dispatch request is older than 5 minutes and none of whose newest ten requests is live, gets a
  new `order.dispatch_requested` row (a `retry` line by the system) through the outbox; at most 3 such requests in an order's life, and none once the newest request is older than 24 hours:
  those orders go to `needs_attention` with the reason. A request is live when the relay has not handed it over, or its job `outbox-<event id>` on `supplier-dispatch` is waiting, active,
  delayed, prioritized or waiting for children (the rule of `notification_reconcile`); an order whose jobs cannot be read (the queue Redis does not answer) waits for the next run.
  An order that never had a dispatch request is left alone however old it is: every placement, release and staff send writes its request in the same transaction as the change, so an
  order without any request row was not placed through the order engine (seeded demo orders, rows written by hand) and nothing was lost.
- **Idempotency:** every move is a guarded update (`status`, `dispatch_state` and `sent_at` unchanged), so a repeat or a parallel run finds the order moved already; `JobRunsService.run`
  skips a run while another one is going on; a doubled request only adds a job that the dispatch claim makes harmless.
- **Recorded in `job_runs`** (job `dispatch_sweep`, `processed` = orders moved, `result` = `{ unanswered, requeued, stopped, movedOn, unknown }`) only for a run that moved an order and for every manual run.
  A move that fails for any reason other than "the order changed first" does not stop the others: the run counts it, keeps the first failure, moves the rest and then throws one error
  (`Dispatch sweep: moved <n>, failed <n>; first failure: <first line of its message>`; no payloads), so the row is `failed` with that text and the next minute plans again.
- **Retry policy:** the queue's (3 attempts, backoff from 1 min); the next minute is the real retry.

### `refund.process` (money module)

Sends an approved storefront refund to its payment gateway (scenario b2c-refund step 6, RESOLUTIONS money-11, user rule 7).

- **Trigger:** the outbox event `refund.process`, written by `POST /admin/refunds/:id/approve` (when the money goes back through the gateway), by `POST /admin/refunds/:id/retry`, and by the system when it refunds a paid order it rejected or a payment that arrived twice for one checkout. The job id is `outbox-<event id>`. A refund paid out by hand (crypto, a gateway that cannot refund) writes no event: it completes at once.
- **Payload:** `{ refundId }` (aggregate: `refunds`). The job re-reads the refund, its payment and its gateway.
- **What it does:** skips a refund that is no longer `processing` or is paid by hand; otherwise calls the gateway's refund API through the driver (outside any database transaction) with the idempotency key `refund-<id>` (`refund-<id>-<n>` once the gateway has refused the refund for good, `n` = `refunds.send_attempt`) and the refund id and the send attempt as metadata (a late `refund.failed` of an earlier attempt is ignored, so it cannot fail the retry that replaced it). `succeeded` completes the refund (the payment becomes `partial_refund` or `refunded`, the order timeline says so); `failed` fails it with the gateway's text; `pending` stores the gateway's refund id and waits for the signed `refund.updated` (status `succeeded`, `failed` or `canceled`) or `refund.failed` event (`POST /webhooks/payments/:gateway`, which settles it by the same guarded step). The ledger journal is not posted here: it was posted at approval (once, key `refund:<id>`, or `order:<id>:refund`), so no run and no retry moves money.
- **Idempotency:** only a `processing` refund moves (guarded `UPDATE ... WHERE status = 'processing'` under the refund's row lock), the gateway call carries a stable key, and the ledger is untouched, so a stalled job, a retry and a staff retry cannot refund twice. The key moves on only when the gateway refused the refund for good (a 4xx answer other than 408, 409, 425 and 429; a refund object that comes back `failed`; the signed `refund.failed` event): the same key would only replay the refusal. After an answer that is not known (a timeout, a network error, a 5xx) the key stays, so a refund the gateway may already have made is never made twice.
- **Retry policy:** the `maintenance` queue's (3 attempts, exponential backoff from 1 min, jitter 50 %). An error of the call whose outcome is not known (a timeout, a 5xx) is rethrown so the queue retries it with the same key; on the last attempt the refund is set to `failed` with that error and staff retry it from the console (`POST /admin/refunds/:id/retry`, which queues a new event, same key). A permanent refusal (4xx) fails the refund at once and ends the job with an `UnrecoverableError` (no queue retries); the staff retry then sends under the new key.
- **Not recorded in `job_runs`:** event-driven, like the supplier dispatch; the refund row is the record.

### `checkout_recovery_sweep` (customers module)

The automatic reminder of abandoned checkouts (feature 19, RULES checkouts 3): emails, once, the checkouts that waited `abandonedMinutes` and whose customer agreed to marketing email.

- **Trigger:** the scheduler `checkout-recovery-sweep` every 5 minutes (`*/5 * * * *`). A tick selects the due checkouts (`canRecoverSql`: consent and an active customer, no recovery email yet, not paid, created at least `abandonedMinutes` ago (the storefront policy, 5 to 1440, default 60) and at most 30 days ago), at most 200, oldest first (`checkout_sessions_created_idx`), and only while the `checkout.abandoned` email template is switched on (nothing is selected while it is missing or off), so checkouts that cannot be mailed never fill the batch and block the others.
- **Payload:** none (a manual run carries `{ runId }`). The tick reads everything from Postgres.
- **What it does:** in one transaction it runs the manual send's own `RecoveryQueue`: reads the selected sessions `FOR UPDATE` in id order, decides each again (the rule can have changed since the selection), probes the `checkout.abandoned` template, claims the checkout (`recovery_emailed_at`, guarded by `IS NULL`) and writes one `checkout.recovery` outbox event for it (queue `notifications`, above). It sends no mail itself.
- **Idempotency:** the claim. A checkout is mailed at most once whether the reminder, a staff send or two ticks reach it first; the loser of a race finds `recovery_emailed_at` set and skips it. A staff send after the reminder answers `already_emailed`.
- **Recorded in `job_runs`** (job `checkout_recovery_sweep`, `processed` = emails queued, `result` = `{ due, queued, skipped }`) only for a tick that found checkouts due and for every manual run; one `audit_logs` row (`sent automatic recovery emails`, actor system) per tick that queued something. A tick with nothing due writes neither.
- **Retry policy:** the queue's (3 attempts, backoff from 1 min); the next tick is the real retry. While the `checkout.abandoned` email has no usable template the tick selects and claims nothing.

### `notification_campaign_sweep` (platform module)

The minute tick of the notification center (feature 23, `CampaignSweep`, `src/modules/platform/notifications/campaigns/campaign-sweep.ts`).

- **Trigger:** the scheduler `notification-campaign-sweep` every minute (`* * * * *`), or a manual run.
- **Payload:** none (a manual run carries `{ runId }`).
- **What it does:** (1) in one transaction, claims the scheduled campaigns that are due (`UPDATE ... SET status = 'queued' WHERE status = 'scheduled' AND
  scheduled_at <= now RETURNING`) and writes, per campaign, one `notification.campaign_fanout` outbox event and one `audit_logs` row
  (`sent scheduled notification campaign`, actor system); (2) marks `failed` a campaign still `queued` or `sending` 24 hours after it was queued
  (`The fan-out did not finish within 24 hours.`); (3) re-kicks a running campaign whose row (the heartbeat, `updated_at`) has not moved for 5 minutes with a
  fan-out job `campaign-fanout-<id>-r<epoch minute>`. Postgres is the truth: a lost queue Redis loses no scheduled campaign.
- **Idempotency:** the claim is a guarded update, so two overlapping ticks queue a campaign once; the re-kick id allows one job per campaign per minute and
  the fan-out itself is idempotent.
- **Recorded in `job_runs`** (through the `JOB_RUN_RECORDER` port that health provides, since platform cannot import health; job
  `notification_campaign_sweep`, `processed` = campaigns queued, `result` = `{ queued, rekicked, failed }`) only for a tick that had something to do and for
  every manual run.
- **Retry policy:** the queue's (3 attempts, backoff from 1 min); the next tick is the real retry. A scheduled campaign is sent at most about 60 s late.

### `notification_reconcile` (platform module)

Adds the send job again for queued notifications whose job was lost (feature 23, `NotificationReconcile`, `src/modules/platform/notifications/notification-reconcile.ts`).

- **Trigger:** the scheduler `notification-reconcile` every 5 minutes (`*/5 * * * *`), or a manual run.
- **Payload:** none (a manual run carries `{ runId }`).
- **What it does** (at most 1 000 rows per rule per run, lowest id first): (0) fails a `queued` row created more than 48 hours ago (`The message was not sent in time.`);
  (1) a campaign row (`campaign_id` set) not updated for 15 minutes gets `notification.send` `{ notificationId, channel }` on `notification-broadcasts` (`QueuesService.addBulk`, id
  `notification-<row id>`); (2) an event row not updated for 30 minutes whose own `notification.send` outbox event was relayed (`processed_at` set) gets
  `notification.send` `{ notificationId }` on `notifications` (id `notification-<row id>`) when the relay's job `outbox-<event id>` is missing or `failed`/`completed`
  (a waiting, active or delayed job is left alone); (3) a digest row (`payload ? 'items'`) whose period (06:00 UTC to 06:00 UTC, `payload.cycle`) ended more than
  30 minutes ago gets the same job. Rows made by `sendNow` hold a secret link and have no outbox event, so they are **never** re-sent.
- **Idempotency:** every job id is deterministic and `QueuesService` ignores an existing id; the delivery guards the row (`markSent` only from `queued`), so a repeat or a
  parallel run cannot send twice.
- **Recorded in `job_runs`** (through the `JOB_RUN_RECORDER` port; job `notification_reconcile`, `processed` = rows touched, `result` = `{ campaignRows, eventRows, digests, expired }`) only
  for a run that found a stale row and for every manual run.
- **Retry policy:** the queue's (3 attempts, backoff from 1 min); the next run is the real retry. `UNAVAILABLE` (the queue Redis is down) fails the run.

### `notification_retention` (platform module)

The daily clean-up of the notification center (feature 23, `NotificationRetention`, `src/modules/platform/notifications/notification-retention.ts`).

- **Trigger:** the scheduler `notification-retention` daily at 04:20 UTC (`20 4 * * *`), or a manual run.
- **Payload:** none (a manual run carries `{ runId }`).
- **What it does:** with the settings `notifications.inbox_read_retention_days` (7-3650, default 90), `notifications.inbox_retention_days` (30-3650, default 365) and
  `notifications.log_retention_days` (30-3650, default 180) and the injected clock, deletes in batches of 1 000 by id (at most 50 batches per table per run) the
  `notification_inbox` rows read longer ago than the first, then those created longer ago than the second, and the `notifications` rows with status `sent` or `failed` older
  than the third. Campaigns are kept (history and audit): after the log retention a campaign's `delivery` counters shrink while its stored `planned` counters stay. A `queued` row is never deleted.
- **Idempotency:** a deleted row cannot be deleted twice; a repeat or a parallel run only finds fewer rows.
- **Recorded in `job_runs`** (job `notification_retention`, `processed` = rows deleted, `result` = `{ inboxRead, inboxOld, log }`) on every run.
- **Retry policy:** the queue's (3 attempts, backoff from 1 min); a backlog beyond 50 000 rows a table is finished by the next nights.

### `fx_refresh` (money module)

Refreshes the exchange rates every hour, with the same code as `POST /admin/currencies/refresh-fx` (`FxRefreshService`, decision 029).

- **Trigger:** the scheduler `fx-refresh` every hour at minute 0 (`0 * * * *`); a manual run from the Jobs tab carries `{ runId }`. The processor is `FxRefreshProcessor` (`src/modules/money/jobs/`).
- **Payload:** none (a manual run carries `{ runId }`).
- **What it does:** asks the configured provider (`FX_PROVIDER`, `FX_API_KEY`) for the latest rate of every active non-base currency, in one call outside any transaction, then writes the rates in one transaction (rows locked in code order, `rate_updated_at` from the clock) with one `audit_logs` row, `refreshed exchange rate`, written by the system actor (no request is behind the job). A currency the provider does not offer, or sends an unusable rate for, is counted as failed and keeps its old rate. A rate that moved more than `fx.max_refresh_move_percent` (default 20) from the stored one is held, not stored: the currency is marked (`rate_held_at`, first time only), listed in `failed`, and logged and reported once, after the commit, when it is first held (decision 049).
- **No provider configured** (`manual`, or `openexchangerates` without a key, outside production; production refuses `openexchangerates` without a key at start): it asks nothing and changes nothing, writes no audit row, and the run is recorded as `succeeded` with `processed` 0 and `result.reason` (`no provider configured`); a `skipped` run would show a warning in the console every hour. This is not an error and is not retried.
- **No active non-base currency** (a configured provider): it ends without a call, a transaction or an audit row (`processed` 0, `result` `{ source, refreshed: 0, failed: 0, held: 0 }`). The admin route still audits its empty refresh, because every staff write is audited.
- **Idempotency:** a repeat only writes the newer rates again; two runs at once are serialised by the row locks and `JobRunsService.run`, which skips a run while another run of `fx_refresh` is going on.
- **Recorded in `job_runs`** (job `fx_refresh`): `processed` = the rates refreshed, `result` = `{ source, refreshed, failed, held }` (`failed` counts the held ones too). A provider that is configured but cannot answer (timeout, refusal, unreadable answer, none of our currencies offered) fails the run (`FX_PROVIDER_DOWN`, the old rates stay): the queue's retry policy applies (3 attempts, backoff from 1 min, each attempt its own run) and the next hour's tick is the real retry. The dashboard's `fx_stale` item and the currencies panel show rates older than 24 hours, and held ones, as stale; a held rate, or one older than `fx.max_rate_age_hours`, is not offered by the shop.

### `service_price_scan` (catalog module)

Finds the merchants who would now pay another price than their last order's for a service they ordered in the last 30 days, and writes one `service.price_changed` outbox event (queue `merchant-webhooks`) for each.

- **Trigger:** event-driven, not scheduled. Every move of the catalog price version (`CatalogPriceVersion.bump`, called after the commit of every write that can change a resolved price) asks for a scan: a delayed job (60 s) with the
  id `price-scan-<minute>`, so a burst of price edits is one scan and there is at most one a minute. A failed request is only logged: the next price change asks again.
- **Payload:** none. The scan reads `orders`, `clients` and the pricing tables (page by page, 500 merchant and service pairs a step) and compares the resolver's price (floor included) with the unit price of the merchant's latest order.
- **Idempotency:** a difference is written only when no outbox row of the same service holds the same `clientId`, `previousPrice` and `price` (`OutboxService.hasEvent`); the webhook fan-out is idempotent on the same change too. A repeat or
  a parallel run writes nothing new.
- **Not recorded in `job_runs`** (event-driven, like the merchant mail jobs). 3 attempts with the queue's backoff.

### `category_names_clean` (catalog module, feature 31)

Gives the categories that exist the clean names new ones get: the public menu shows them, and an import used to name a category after the supplier's group text as it came (`AT&amp;T`, emoji, direction marks).

- **Trigger:** once. Migration `0046_clean_category_names` writes the outbox event `catalog.category_names_clean`, and the relay turns it into this job (id `outbox-<event id>`). The route is registered by `CategoryNameCleanupModule`, in the worker only.
- **Payload:** none. The processor is `CategoryNameCleanupProcessor` (`src/modules/catalog/jobs/`, worker only).
- **What it does:** walks every category by id, 200 a page, and gives each name that `cleanGroupName` would change its clean form: one transaction per category, under the category row lock (`FOR UPDATE`, as a staff edit), with the `catalog.category_changed` event, a move of the catalog price version after the commit and an `edited category` audit row by `system` with both names. A name another category of the same type already has (ignoring case) is left as it is and logged: merging the two is a decision for staff, and the importer keeps sending the raw group to the raw category.
- **Idempotency:** a clean name is skipped, so a retry or a second delivery changes nothing.
- **Not recorded in `job_runs`:** it is not a schedule. 3 attempts with the queue's backoff.

### `field_patterns_review` (catalog module, feature 41)

Clears the stored field patterns that are outside the supported form of decision 051, so a field never keeps a pattern the order check
does not run.

- **Trigger:** once. Migration `0048_supplier_safety` writes the outbox event `catalog.field_patterns_review`, and the relay turns it into this
  job (id `outbox-<event id>`). The route is registered by `FieldPatternReviewModule`, in the worker only.
- **Payload:** none. The processor is `FieldPatternReviewProcessor` (`src/modules/catalog/jobs/`, worker only).
- **What it does:** walks the fields with a pattern by id, 500 a page; a pattern outside the form is set to `''` by a guarded update
  (`where id = $1 and regex = $2`), with an audit row by `system` (`cleared an unsupported field pattern of`, the old pattern in `before`) and a
  warning line, in one transaction per field. A field a staff save changed meanwhile is left as staff saved it.
- **Idempotency:** a cleared pattern is not matched again, so a retry or a second delivery changes nothing.
- **Not recorded in `job_runs`:** it is not a schedule. 3 attempts with the queue's backoff.

### `checkout_tokens_seal`, `tracking_tokens_seal`, `ticket_tokens_seal` (customers, orders and support modules, feature 44)

Convert the link tokens stored as issued before decision 054 to their keyed hash and encrypted copy, and empty the plain column.

- **Trigger:** once. Migration `capability_tokens_seal` writes the outbox events `customers.checkout_tokens_seal`,
  `orders.tracking_tokens_seal` and `support.ticket_tokens_seal`; the relay turns each into its job (id `outbox-<event id>`). The routes
  are registered by `CheckoutTokenSealModule`, `TrackingTokenSealModule` and `TicketTokenSealModule`, in the worker only.
- **Payload:** none. Processors in each module's `jobs/` folder.
- **What it does:** walks the rows that still hold a plain token by id, 500 a page; each row gets its hash and copy and loses the plain
  token in one guarded `UPDATE … WHERE id = $1 AND <token> = $2 AND <hash> IS NULL` (`updated_at` unchanged).
- **Idempotency:** a sealed row is skipped; a repeat seals nothing.
- **Recorded in `job_runs`** (trigger `event`): `processed` = rows sealed, `result` = `{ sealed, unchanged }`. 3 attempts with the
  queue's backoff.

### `retail_price_follow` (catalog module, feature 31)

Moves the retail prices that follow a pricing rule to what the rule gives now (decision 040, `docs/briefs/31-bulk-publish.md` sections 3.4 and 6.4).

- **Triggers:** (1) every move of the catalog price version, in the API or the worker: `RetailFollowScheduler` (provided by the global `CatalogPricesModule`) adds a delayed job (60 s) with
  the id `retail-follow-<minute>`, so a burst of changes is one pass and there is at most one a minute; a failed request is only logged. (2) The scheduler `retail_price_follow_hourly`, every hour at
  minute 10: it catches what no bump announces (a B2B rule window that opens or closes moves a floor with no write). (3) A manual run from the Jobs tab, which carries `{ runId }`. The processor is
  `RetailPriceFollowProcessor` (`src/modules/catalog/jobs/`, worker only).
- **Payload:** none (a manual run carries `{ runId }`).
- **What it does:** a keyset walk over `retail_price_follows` by service id, 200 a page. One unlocked read per page finds the services whose follow row, price or proposal would change; each of those is
  its own transaction (the service row `FOR UPDATE`, then the follow row and the waiting proposal, with the quote and the rules read again under them): it moves the price through `RetailPrices.set`
  (`followed`), opens or rewrites a proposal (`proposed`: a cost move over the rule's limit, a cost of 0, a service that came under another rule by itself), or stops following a price changed another way
  (`detached`). A service that loses to another transaction (`40P01`, `40001`) or fails is counted and left to the next pass; the pass goes on.
- **It ends by itself:** one `CatalogPriceVersion.bump()` at the end when a price was written. That asks for one more pass, which finds nothing, writes nothing and does not bump.
- **The message:** at the end of a pass, when rows have no `notified_at` and none was reported in the last 60 minutes, one transaction marks them and writes `retail.prices_followed` (the counts `changed`,
  `waiting`, `detached` and the link to the Retail pricing tab) to the ops recipients of `ALERTS_EMAIL_TO` and `ALERTS_TELEGRAM_CHAT_ID`, one notification per channel, dedupe key
  `retail-follow:<first id>:<channel>`. A channel with no recipient is a failed notification with the reason; the console's Price changes list is the notice either way.
- **Idempotency:** it compares stored state with computed state and writes differences, so a repeat finds nothing; two passes side by side serialize on each service row (one change row per service) and on
  an advisory lock for the message (one message). An unchanged waiting proposal is not rewritten and keeps its `notified_at`.
- **Recorded in `job_runs`** (job `retail_price_follow`) for the scheduled and the manual run: `processed` = the following services walked, `result` = what it did. The delayed job is event-driven and is
  not recorded. 3 attempts with the queue's backoff.

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
- **Jobs:** `alert_evaluation` every minute (health module, feature 12b: `AlertEvaluationProcessor`, below). The evaluation also repeats the message of every
  firing, unacknowledged alert every 30 minutes (`REMINDER_INTERVAL_MS`). The messages themselves are platform notifications (12a): the `AlertNotifier`
  writes the `notifications` rows (`alert.fired`, `alert.resolved`, recipient (`staff`, 0), `dedupe_key` `alert-<id>:fired|resolved|reminder-<n>:<channel>`) and their
  `notification.send` outbox events in the transaction of the change; the `notifications` queue sends them.
- **Payload:** none (a manual run, `POST /admin/system/jobs/alert_evaluation/run`, carries `{ runId }`).
- **Idempotency:** an alert is opened once per rule and subject while it is open: `INSERT ... ON CONFLICT DO NOTHING` on the partial unique index
  `alert_events_open_uq (rule_id, subject_key) WHERE status <> 'resolved'`, so two overlapping runs open it once and only the run that opened it notifies;
  closing is a guarded `UPDATE ... WHERE status <> 'resolved'`. The insert runs in a transaction that locks the rule `FOR SHARE` and re-checks it (still
  on, not deleted, not muted, same condition), so a rule changed during a run gets no alert from the run's stale copy.
- **Retry policy:** 3 attempts, exponential backoff from 10 s (jitter 50 %); the next minute's tick is the real retry.
- **Schedule:** `alert-evaluation` every minute (`src/modules/health/jobs/health-jobs.module.ts`).

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
| `staff.invited` | `notifications` | `staff.invited` | `tokenId` (aggregate: `staff_users`, the member) | identity (`StaffMailOutbox`, loaded by the API and the worker), written by `POST /admin/staff` (onboarding `invite`) and `POST /admin/staff/:id/password` while the member is `invited` (feature 20) |
| `staff.password_reset` | `notifications` | `staff.password_reset` | `tokenId` (aggregate: `staff_users`) | identity (`StaffMailOutbox`), written by `POST /admin/staff/:id/password` (`reset_link`, member already active) (feature 20) |
| `support.ticket_mail` | `notifications` | `support.ticket_mail` | `kind` (`received`, `reply`, `survey`), `messageId` and `channel` for a reply, and `fromMessageId` for one email that carries every unseen reply from that message to `messageId` (feature 28) (aggregate: `support_tickets`) | support (`TicketMailRoutes`, loaded by the API and the worker), written by `POST /store/v1/tickets` (the receipt), `POST /admin/support-tickets/:id/reply` (a Telegram reply, or an email reply when `support.replyEmailDelayMinutes` is 0), the `support_reply_mail_sweep` job (the batched email of the unseen replies) and `PATCH /admin/support-tickets/:id` with `status: resolved` (the survey) (features 17 and 28) |
| `notification.send` | `notifications` | `notification.send` | none (aggregate: `notifications`, the row) | platform (`NotificationRoutes`), written by `NotificationService.enqueue` together with the row |
| `checkout.recovery` | `notifications` | `checkout.recovery` | none (aggregate: `checkout_sessions`, the abandoned checkout) | customers (`RecoveryOutbox`, loaded by the API and the worker), written by `POST /admin/checkouts/recover` and the `checkout_recovery_sweep` job, in the transaction that claims the checkout (`recovery_emailed_at`) |
| `order.status_changed` | `merchant-webhooks`, `notifications` | `order.status_changed` on the webhooks, `notification.plan` on `notifications` | `orderId`, `clientId` (null for a storefront order), `fromStatus`, `toStatus` (aggregate: `orders`) | orders (`OrderOutbox`: the webhooks route, loaded by the API and the worker) and platform (`NotificationRoutes`: the notifications route); written by every transition that changes the status: accept, reply, reject, cancel, reopen, refund, verification refund. Consumers: the webhook fan-out (7b) and the order result notifications (12a) |
| `wallet.low_balance` | `merchant-webhooks`, `notifications` | `wallet.low_balance` / `notification.plan` | `clientId`, `currency`, `available`, `threshold` (aggregate: `ledger_accounts`) | platform (`MerchantEventRoutes` webhooks route, `NotificationRoutes` notifications route), written by the money module's `WalletLowBalanceWatch` |
| `service.price_changed` | `merchant-webhooks`, `notifications` | `service.price_changed` / `notification.plan` | `clientId`, `serviceId`, `previousPrice`, `price`, `currency` (aggregate: `services`) | platform (both routes), written by the catalog's price change scan |
| `order.dispatch_requested` | `supplier-dispatch` | `order.dispatch_requested` | `orderId` (aggregate: `orders`) | orders (`OrderOutbox`), written by placement of an automatic order with an active supplier link, by a staff dispatch, by `change-supplier` with `dispatch: true`, by a risk release and by the `dispatch_sweep` (decision 044). The processor is `SupplierDispatchProcessor` (`src/modules/suppliers/jobs/`) |
| `invoice.paid` | `merchant-webhooks` | `invoice.paid` | `invoiceId`, `clientId` (aggregate: `invoices`) | money (`InvoiceOutbox`, loaded by the API and the worker), written by every credit of a top-up: a staff approval (`POST /admin/payments/:id/approve`) and the automatic credit job. The fan-out re-reads the invoice (7b) |
| `receipt.render` | `files` | `receipt.render` | `invoiceId` (aggregate: `invoices`) | money (`ReceiptOutbox`, loaded by the API and the worker), written by the capture of a storefront payment together with the receipt invoice. The processor is `ReceiptRenderProcessor` (`src/modules/money/jobs/`) |
| `refund.process` | `maintenance` | `refund.process` | `refundId` (aggregate: `refunds`) | money (`RefundOutbox`, loaded by the API and the worker), written by the approval and the retry of a storefront refund and by the system's automatic refunds. The processor is `RefundProcessProcessor` (`src/modules/money/jobs/`) |
| `notification.campaign_fanout` | `notifications` | `notification.campaign_fanout` | none (aggregate: `notification_campaigns`, the campaign) | platform (`NotificationRoutes`), written by `POST /admin/notification-campaigns/:id/send` and the `notification_campaign_sweep` job, in the transaction that moves the campaign to `queued` (feature 23) |
| `catalog.services_changed` | `search-index` | `search_sync` | `serviceIds` (1-50), `reason` (`service`, `price`, `options`, `stock`) (aggregate: `services`, the first id) | storefront (`SearchOutboxRoutes`, loaded by the API and the worker), written by the catalog's `CatalogSignals` in the writer's transaction: service create, edit, archive and delete, every `PUT /admin/services/:id/group-prices`, `PUT /admin/services/:id/options`, an inventory import and void, and the stock claim of an order placement (feature 29) |
| `catalog.category_changed` | `search-index` | `search_sync` | `categoryId` (aggregate: `service_categories`) | storefront (`SearchOutboxRoutes`), written by `CatalogSignals` on a category edit or delete and, once per category, by a merchant group delete that removed the group from categories (feature 29) |
| `storefront.listing_changed` | `search-index` | `search_sync` | `serviceIds` (1-50) (aggregate: `services`, the first id) | storefront (`SearchOutboxRoutes`), written by `SearchSignals` on `POST /admin/service-listings` and every `PATCH /admin/service-listings/:id` (feature 29) |
| `search.settings_changed` | `search-index` | `search_settings` | `kind` (`synonyms`, `pins`, `hidden_terms`) (aggregate: the row's table) | storefront (`SearchOutboxRoutes`), written by the console's search routes (feature 29, slice B2) |
| `search.rebuild_requested` | `maintenance` | `search_rebuild` | `staffId`, optional `runId` (aggregate: `search_index`, 1) | storefront (`SearchOutboxRoutes`), written by `POST /admin/search/index/rebuild` (feature 29, slice B2) |
| `catalog.category_names_clean` | `maintenance` | `category_names_clean` | none (aggregate: `service_categories`, 1) | catalog (`CategoryNameCleanupModule`, worker only), written once by migration `0046_clean_category_names` |
| `catalog.field_patterns_review` | `maintenance` | `field_patterns_review` | none (aggregate: `service_fields`, 1) | catalog (`FieldPatternReviewModule`, worker only), written once by migration `0048_supplier_safety` |
| `customers.checkout_tokens_seal` | `maintenance` | `checkout_tokens_seal` | none (aggregate: `checkout_sessions`, 1) | customers (`CheckoutTokenSealModule`, worker only), written once by migration `capability_tokens_seal` |
| `orders.tracking_tokens_seal` | `maintenance` | `tracking_tokens_seal` | none (aggregate: `orders`, 1) | orders (`TrackingTokenSealModule`, worker only), written once by migration `capability_tokens_seal` |
| `support.ticket_tokens_seal` | `maintenance` | `ticket_tokens_seal` | none (aggregate: `support_tickets`, 1) | support (`TicketTokenSealModule`, worker only), written once by migration `capability_tokens_seal` |
| `supplier.quick_add` | `imports` | `supplier_quick_add` | `runId`, `supplierId` (aggregate: `supplier_import_runs`) | suppliers (`QuickAddOutbox`, loaded by the API and the worker), written by `POST /admin/suppliers/:id/quick-add` in the transaction that inserts the run (feature 26). The processor is `QuickAddProcessor` (`src/modules/suppliers/jobs/`) |
| `storefront.publish_prepare` | `imports` | `publish_prepare` | `runId` (aggregate: `listing_publish_runs`) | storefront (`PublishOutboxRoutes`, loaded by the API and the worker through `PublishEngineModule`), written by `PublishOutbox` in the transaction that inserts a run in `preparing` (`POST /admin/publish-runs`, feature 31). The processor is `PublishPrepareProcessor` (`src/modules/storefront/publish/jobs/`) |
| `storefront.publish_apply` | `imports` | `publish_apply` | `runId` (aggregate: `listing_publish_runs`) | storefront (`PublishOutboxRoutes`, loaded by the API and the worker through `PublishEngineModule`), written by `PublishOutbox` in the transaction that moves a run to `queued` (feature 31). The processor is `PublishApplyProcessor` (`src/modules/storefront/publish/jobs/`) |
| `storefront.publish_set_listed` | `imports` | `publish_set_listed` | `runId`, `listed`, `requestedBy` (aggregate: `listing_publish_runs`) | storefront (`PublishOutboxRoutes`), written by `PublishOutbox` in the transaction that queues a run switch (feature 31). The processor is `PublishSetListedProcessor` (`src/modules/storefront/publish/jobs/`) |
| `supplier.quick_add_done` | `imports` | `publish_from_quick_add` | `runId`, `supplierId`, `requestedBy`, `listed` (aggregate: `supplier_import_runs`) | suppliers (`QuickAddOutbox.done`, written in the transaction that closes a Quick add run that asked to publish and created services; feature 31); the route is registered by the storefront's `PublishOutboxRoutes` (the suppliers module never imports the storefront). The processor is `PublishFromQuickAddProcessor` (`src/modules/storefront/publish/jobs/`) |

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
| `supplier-dispatch-sweep` | `maintenance` | `dispatch_sweep` | every minute | suppliers (`src/modules/suppliers/jobs/`) |
| `checkout-recovery-sweep` | `maintenance` | `checkout_recovery_sweep` | every 5 minutes | customers (`src/modules/customers/checkout-recovery.module.ts`) |
| `notification-campaign-sweep` | `maintenance` | `notification_campaign_sweep` | every minute | platform (`src/modules/platform/notifications/campaigns/campaign-engine.module.ts`) |
| `notification-reconcile` | `maintenance` | `notification_reconcile` | every 5 minutes | platform (`src/modules/platform/notifications/campaigns/campaign-engine.module.ts`) |
| `notification-retention` | `maintenance` | `notification_retention` | daily 04:20 UTC | platform (`src/modules/platform/notifications/campaigns/campaign-engine.module.ts`) |
| `service-checks` | `maintenance` | `service_checks` | every minute | health (`src/modules/health/jobs/`) |
| `service-checks-purge` | `maintenance` | `service_checks_purge` | daily 03:30 UTC | health (`src/modules/health/jobs/`) |
| `job-runs-reaper` | `maintenance` | `job_runs_reaper` | every 5 minutes | health (`src/modules/health/jobs/`) |
| `db-size-sample` | `maintenance` | `db_size_sample` | daily 03:45 UTC | health (`src/modules/health/jobs/`) |
| `alert-evaluation` | `alerts` | `alert_evaluation` | every minute | health (`src/modules/health/jobs/`) |
| `ledger-integrity` | `maintenance` | `ledger_integrity` | daily 02:30 UTC | health (`src/modules/health/jobs/`) |
| `data-retention` | `maintenance` | `data_retention` | daily 03:00 UTC | risk (`src/modules/risk/jobs/`) |
| `fx-refresh` | `maintenance` | `fx_refresh` | every hour at minute 0 | money (`src/modules/money/jobs/`) |
| `retail_price_follow_hourly` | `maintenance` | `retail_price_follow` | every hour at minute 10 | catalog (`src/modules/catalog/jobs/`) |
| `idempotency-purge` | `maintenance` | `idempotency_purge` | daily 04:10 UTC | orders (`src/modules/orders/jobs/`) |
| `storefront-popularity` | `maintenance` | `storefront_popularity` | every 30 minutes | storefront (`src/modules/storefront/jobs/`) |
| `support-reply-mail-sweep` | `maintenance` | `support_reply_mail_sweep` | every minute | support (`src/modules/support/support-jobs.module.ts`) |
| `ticket-attachment-retention` | `maintenance` | `ticket_attachment_retention` | daily 03:30 UTC | support (`src/modules/support/support-jobs.module.ts`) |
| `search-reconcile` | `maintenance` | `search_reconcile` | every `SEARCH_RECONCILE_MINUTES` (default 15) minutes | storefront (`src/modules/storefront/search/search-worker.module.ts`) |
| `search-rebuild-nightly` | `maintenance` | `search_rebuild` | daily 03:40 UTC | storefront (`src/modules/storefront/search/search-worker.module.ts`) |
| `search-terms-build` | `maintenance` | `search_terms_build` | every hour at minute 20 | storefront (`src/modules/storefront/search/search-worker.module.ts`) |
| `search-terms-flush` | `maintenance` | `search_terms_flush` | every 15 minutes | storefront (`src/modules/storefront/search/search-worker.module.ts`) |
| `search-terms-purge` | `maintenance` | `search_terms_purge` | daily 04:10 UTC | storefront (`src/modules/storefront/search/search-worker.module.ts`) |
| `supplier-poll-tick` | `supplier-poll` | `supplier_poll_tick` | every minute | suppliers (`src/modules/suppliers/jobs/`) |
| `supplier-price-sync` | `supplier-sync` | `price_sync` | every 15 minutes | suppliers (`src/modules/suppliers/jobs/`) |
| `supplier-balance-check` | `supplier-sync` | `balance_check` | every 30 minutes | suppliers (`src/modules/suppliers/jobs/`) |

## Adding a queue or a job

1. A new queue: add it to `QUEUES` in `src/infra/queues/queue-definitions.ts` and give it a section above (the test fails
   until the section exists and its numbers match).
2. A new job: write the processor in `src/modules/<id>/jobs/`, mark it `@QueueProcessor('<queue>', '<job name>')`, provide
   it in the module, and import that module in `src/worker.module.ts`. Replace the "none yet" lines of the queue section.
3. An event from a use case: `OutboxService.add(tx, { type, aggregateType, aggregateId, payload })`, and register the type
   (table above).
4. A schedule: `JobSchedulerRegistry.register({ id, queue, jobName, every | pattern })`; add a row to the table above.
5. Test it: an integration test that runs the processor twice (idempotency), and one that fails it once (retry).
