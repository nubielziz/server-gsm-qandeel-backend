# 075: A two-minute cancel window for website orders, and the facts behind the Cancel and Verify buttons

Status: accepted, 2026-11-27 (the owner's order of that day, on the lead's proposal). Builds on decisions 020 (outbox and queues), 025 (the
order state machine: a merchant cancels only an order that was never sent) and 044 (the dispatch state `dispatching`, `everDispatched` and
the dispatch sweep). Nothing of them is replaced. The shop records its own side.

**Context.** The owner switched "User Can Cancel Order" (`services.allow_cancel`) on for an automatic service and placed orders on the
website: the Cancel button never appeared. An automatic order is sent to its supplier in the same second it is placed (placement writes
`order.dispatch_requested`, the relay hands it to `supplier-dispatch` at once), and a merchant may cancel only an order that was never
claimed for a supplier call (decisions 025 and 044: `canCancel` is false once the order is `dispatching` or has a `dispatch` event). The
switch could only ever work for manual orders. The owner also wants the website to say why an action is not available, and until when it is.

**Decision: the cancel window.** `CANCEL_WINDOW_MS = 120_000` (`src/modules/orders/domain/merchant-actions.ts`). An order is inside its
cancel window at time `now` when all of these hold, and `cancelWindowEnd(facts, now)` (the one pure rule, exported by the orders module)
then answers `placed_at + CANCEL_WINDOW_MS`, else `null`:
- `source = 'portal'` (placed on the website);
- its service has `allow_cancel = true` **now**: read when the decision is made, never the value it had at placement (a switch turned off
  during the window sends the order at the next run; one turned on makes an order that was not sent yet wait);
- it is open with `dispatch_state = 'pending'`, `sent_at` empty and no `dispatch` event (never claimed);
- `now < placed_at + CANCEL_WINDOW_MS` (the end itself is outside).

Both the dispatch job and the merchant view use this function, with the injected clock (no `Date.now()` in the rule), so the deadline the
portal shows is the moment the job sends.

**Decision: the dispatch job waits.** `SupplierDispatch.run` asks `OrderSupplierMoves.cancelWindowEnd(db, order)` after its existing "not
pending" and "claim of an earlier release" checks and before anything else (payment stop, link choice, call limits, the claim). The orders
module reads the service's switch and the `dispatch` events with its own query (`cancelWindowReads`, through its foreign reads of
`services`, the same ones the order read model uses), so the suppliers module reads no table it does not own. Inside the window the run
writes nothing (no claim, no event, no audit, no call log, no lease) and answers `{ status: 'deferred', until }`. The processor
(`SupplierDispatchProcessor`) then moves its own job to `delayed` until `until` and ends the run with BullMQ's `DelayedError`; the same
job (`outbox-<event id>`) runs again then and re-reads everything. Checked against the installed BullMQ 6.5.3:
- **The token.** This code base has no Nest `WorkerHost`: `QueueWorkers` builds each BullMQ `Worker` with its own processor function,
  which BullMQ calls as `(job, token, signal)` with the lock token of the run (it also sets `job.token`). The worker now passes that token
  on: `JobProcessor.process(job, token?)`. It must be passed: without it `moveToDelayed` sends `'0'`, which skips the lock check and leaves
  the lock key behind (`includes/removeLock.lua`).
- **The move.** `job.moveToDelayed(timestamp, token)` runs `moveToDelayed-11.lua` with `skipAttempt`: the job leaves `active` for the
  `delayed` set (score = the timestamp), its lock is removed and `attemptsMade` is **not** incremented (`atm` only grows when
  `skipAttempt` is off), so the next run's `lastAttempt` is unchanged. `attemptsStarted` grows by one per run; the workers set no
  `maxStartedAttempts`, so it has no effect.
- **The error.** `Worker.handleFailed` recognises `DelayedError` by class or name and only fetches the next job: no `moveToFailed`, no
  retry, no `failed` event, so the `failed` listener of `QueueWorkers` (the error log and the report to Sentry) never runs. `QueueWorkers.run`
  used to count every throw as `failed` and pass it through `toQueueError`: it now counts this one as
  `queue_jobs_processed_total{outcome="delayed"}` and rethrows it unchanged (`isDelayedError`), so BullMQ still sees a `DelayedError`.
- **The run record.** The dispatch job is event-driven and never wrote `job_runs` (docs/queues.md), so nothing is recorded there.

No queue, job id, payload, scheduler or outbox event is added; `maxStalledCount` stays 0 (a job that dies while active is still never
re-run). A worker restart keeps the delayed job, which lives in the queue Redis; if that job is lost (the queue Redis lost its data), the
dispatch sweep's rule (b) asks again once the order and its newest request are 5 minutes old, and the new job finds the window passed and
sends. No new mechanism.

**What does not change.** The merchant's cancel stays the machine's `cancel` (`canCancel`, `409 ALREADY_SENT` and `INVALID_TRANSITION`
as before); placement still writes `order.dispatch_requested` in its transaction; Dhru orders (`source = 'dhru'`) and shop orders
(`store`) are never deferred; manual and held orders are untouched; an order of a service without `allow_cancel` is sent at once.

**Interactions, checked.**
- **The dispatch sweep** (`dispatch_sweep`, rule (b)) never requeues or stops an order inside its window: `unclaimedPending` returns only
  orders placed more than 5 minutes ago (`DISPATCH_REQUEUE_AFTER_MS`), the window is 2, and the waiting job is `delayed`, which
  `DispatchRequests` counts as live. Proved by tests: `dispatch-cancel-window.test.ts` plans the sweep at placement, at the end of the window
  and one second before 5 minutes and finds nothing for the order; `supplier-pipeline.test.ts` shows the real delayed job read as `live`.
- **A staff send** (`POST /admin/orders/:id/dispatch`) of an order inside its window waits for the window too, with no override: the
  request is on its way (its job is delayed, or not relayed yet), so the machine's `staffDispatch` is a no-op (`204`, the press audited)
  and the job still waits. A manual order sent by staff inside its window is queued and its job waits for the end of the window. Option,
  not built: an override would need a fact the job can read (for example a staff `retry` line after placement), since the payload carries
  ids only; it is not trivial, and the owner did not ask for it.
- **A cancel that races the claim** is decided by the existing guards: the claim's guarded update (`dispatch_state = 'pending' AND sent_at
  IS NULL` on an open order) and the cancel's guarded update (`status`, `dispatch_state`, `sent_at` unchanged) serialise on the row; the
  loser gets nothing (`claimed_elsewhere` / `not_pending`) or `409`. A cancel inside the window rejects the order and releases the hold;
  the later run finds it closed and sends nothing (tested).

**Decision: four facts on the merchant's order.** `toMerchantOrder` (`src/modules/orders/application/order-views.ts`) and
`MerchantOrderSchema` (every merchant order on the wire: the list rows, the detail, the dashboard's latest orders and the placement's
answer) gain, beside `canCancel` and `canVerify`:
- `cancelUntil: string | null` (`cancelDeadline`): `placed_at + CANCEL_WINDOW_MS` as ISO only while `canCancel` is true **and** the order
  is inside its cancel window; a cancellable manual or held order (or a pending one past its window, until the job claims it) has none.
- `cancelBlocked: 'closed' | 'not_allowed' | 'already_sent' | 'in_progress' | null` (`cancelBlockedReason`): `null` exactly when
  `canCancel`; otherwise the first that applies: not open (completed or rejected) → `closed`; no `allow_cancel` → `not_allowed`; sent or
  claimed at least once (`everDispatched`, or the machine's dispatch state `sent` or `dispatching`: the facts that make it answer
  `ALREADY_SENT`) → `already_sent`; anything else → `in_progress`.
- `verifyUntil: string | null` (`verifyDeadline`): `completed_at + verify_window_h` hours, only while `canVerify`.
- `verifyBlocked: 'already_requested' | 'not_allowed' | 'not_completed' | 'window_passed' | null` (`verifyBlockedReason`): `null` exactly
  when `canVerify`; otherwise the first that applies: `verification_status` set → `already_requested`; no `allow_verify` →
  `not_allowed`; not completed → `not_completed`; otherwise (the window passed, a window of 0 hours included) → `window_passed`.

The lists of reasons are `CANCEL_BLOCKED_REASONS` and `VERIFY_BLOCKED_REASONS` in the same domain file. Invariants, tested over a table of
states: `cancelBlocked === null` ⇔ `canCancel`; `verifyBlocked === null` ⇔ `canVerify`; `cancelUntil !== null` ⇒ `canCancel`;
`verifyUntil !== null` ⇒ `canVerify`. The POST routes (`/client/orders/:id/cancel`, `/verify`) and their error codes do not change; the
staff views do not change.

**What people see.**
- **A merchant on the website**: an order of a service that allows cancellation stays `pending` for two minutes with `canCancel: true` and
  `cancelUntil`; it can be cancelled until then (the hold goes back), then it is sent. Every order says why Cancel or Verify is not there.
- **Dhru callers** (our Dhru API): nothing changes; their orders are sent at once and their status answers are the same.
- **Staff**: such an order reads `pending` in the pending queue (no `sentAt`, no supplier yet) for up to two minutes; "send now" does not
  shorten the wait.
- **Suppliers** receive such orders two minutes later than before.

**Consequences.**
- No route, table, migration, queue, job, scheduler, cache key, outbox event, permission or error code is added, so the route manifest, the
  slices and the coverage do not change. The OpenAPI documents are rebuilt by the lead (the four keys of the merchant order, their
  descriptions, the examples, and the descriptions of `POST /client/orders`, `GET /client/orders` and the cancel route).
- The queue infrastructure gains the waiting path: `JobProcessor.process(job, token?)`, `DelayedError` re-exported by `src/infra/queues`,
  and the label value `outcome="delayed"` of `queue_jobs_processed_total`.
- Turning "User Can Cancel Order" on for an automatic service now delays its website orders by two minutes. The demo seed switches it on
  for every service that is not a File service (`scripts/seed/catalog.ts`), so on demo data every website order of an automatic service
  waits two minutes.
- An `Idempotency-Key` replay of a `POST /client/orders` answer stored by the release before (a retry of the same submission across the
  deploy) lacks the four keys. The replay fills them in (`withActionFacts`, `order-views.ts`: no deadline, and a reason only where the
  stored flag is false), so the first `201` is sent again and the merchant does not order a second time with a new key (review of this
  decision). The fill-in can be deleted once no such answer can be left (7 days after the release).
- Tests: `test/unit/modules/orders/domain/merchant-actions.spec.ts` (the window rule), `test/unit/modules/orders/application/order-views.spec.ts`
  (the four facts, their order of reasons and the invariants over a table of states), `test/unit/modules/suppliers/jobs/supplier-dispatch.processor.spec.ts`
  (the delay path of the processor), `test/integration/suppliers/dispatch-cancel-window.test.ts` (new: deferred without a claim, event, call
  or audit and `cancelUntil` shown; claimed and sent after the window; a cancel inside the window and the later run; the switch read at run
  time; the sweep; a staff send; a Dhru order and a service without cancellation sent at once), `test/integration/suppliers/supplier-pipeline.test.ts`
  (the real worker: the job waits in `delayed` with no attempt used and nothing failed, is live for the sweep, then sends with one attempt),
  `test/integration/infra/queues.test.ts` (a job that moves itself to later runs again with no attempt used and is counted `delayed`).

**Release.** Backend before the shop. The shop reads the four keys as optional until this release is live, so the backend can go first;
from then on website orders of services with cancellation wait two minutes and carry the facts, and the shop shows them once it is released.
Nothing has to run by hand: no migration, no cache step.
