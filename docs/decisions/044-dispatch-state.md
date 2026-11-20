# 044: Dispatch state: a send in flight is its own state

Status: accepted, 2026-11-20. Amends decision 025 (dispatch states and transitions) and the backup note of decision 036.

**Context.** The dispatch job claims an order before it calls the supplier and records the supplier's answer in a second
transaction. Between the two the order kept the dispatch state `pending`, so the actions allowed on a waiting order were also allowed
while the supplier was taking it, and an answer that came back after such an action was kept only in the call log. A claim whose job
ended without an answer, and an order whose dispatch job was lost before its claim, stayed in `pending` with nothing to move them; a
cache Redis error in the supplier's call limits failed the job without a review state. A change of supplier kept the previous
supplier's reference, and a supplier's status answer was applied to whatever supplier the order named when it arrived. The operations
guide said that lost queue jobs are re-created from `outbox_events`, which is true only for some kinds of work.

**Decision.**
- New dispatch state `dispatching`. The claim sets it together with `sent_at` in one guarded update (from `pending` with `sent_at`
  empty). The answer of the call is accepted only from `dispatching` and only for the claim it answers (`sent_at` unchanged). An order
  that an earlier release claimed (`pending` with `sent_at` set) is treated as `dispatching`.
- While an order is `dispatching` the merchant's cancel answers `409 ALREADY_SENT` as for a sent order; a staff reply, reject, change
  of supplier, staff dispatch and the approval of a storefront refund answer `409 ALREADY_SENT` with a detail that asks to wait for the
  supplier's answer. No new error code.
- The merchant's cancel is also refused for good with `409 ALREADY_SENT` (the plain sentence of a sent order) once the order was ever
  claimed for a supplier call, that is, once it has at least one `dispatch` event, whatever it reads afterwards: after a timeout and a
  staff "send again" the order is `pending` with `sent_at` empty, yet the supplier may hold the first attempt. The machine's state
  carries `everDispatched` (`orderStateOf` takes it, default false); `OrderTransitions.apply` reads it only for a cancel; the order read
  model reads it with one `EXISTS` in the same select, so `canCancel` is false on the portal and REST v1 lists and details. Staff end such
  an order (reject).
- The wire keeps its values: the staff order shows `dispatching` as `pending`, and every queue derived from the dispatch state treats it
  as `pending`. The merchant's `canCancel` is false while a send is in flight.
- An acceptance that arrives after the order moved on is recorded in its own transaction: the reference is stored when the order has
  none and still names that supplier, a `review` line names the supplier and the reference, an order that waits for another send goes to
  `needs_attention` instead of being sent again, and the worker logs an error and reports it through the error reporter.
- A supplier's acceptance is not lost when its recording fails. A call log row that cannot be written is logged and reported and does not
  stop the answer from being recorded. When the answer's own transaction fails for any reason other than "the order moved on" and the
  supplier accepted, the same recording runs with a sentence that says the answer could not be recorded: the reference is stored, one
  `review` line asks to check the supplier before sending again, the order keeps its claim (the sweep moves it later, and staff can then
  fetch the result with the stored reference), and the original error ends the job as before, so a retry finds the claim and sends nothing.
  If this recording fails too, it is logged and reported and never rethrown.
- A sweep runs every minute on the `maintenance` queue (`dispatch_sweep`; a `job_runs` row when it acts and for a manual run):
  an order `dispatching` for longer than its supplier's timeout plus 2 minutes goes to `needs_attention` (answer not recorded; never
  sent again automatically; the hold stays); an order `pending` that no run claimed, whose newest dispatch request is older than 5
  minutes and has no live job (not yet relayed, or its job `outbox-<event id>` waiting, delayed or running), gets a new request through
  the outbox, at most 3 times in its life and never once the newest request is older than 24 hours: then it goes to `needs_attention`.
  An order that never had a dispatch request is left alone however old it is: every placement, release and staff send writes its request
  in the same transaction as the change, so an order without any request row was not placed through the order engine (seeded demo rows,
  for example) and nothing was lost. One order that cannot be moved does not stop the others: the sweep counts the failure, keeps the
  first one, moves the rest, and then ends with one error that gives how many orders were moved and how many failed and the first
  failure's first line, so the run is recorded as failed and the next minute tries again.
- Staff "send again" on a `pending` order with no live dispatch job queues a new dispatch and leaves the order's supplier columns as
  they are (the job chooses the target by the automatic rule, with its price protection); with a live job it changes nothing. An
  order in `needs_attention`, `manual` or `operator` keeps the earlier rule.
- An error of the cache Redis in a supplier's call limits counts as "busy": the queue retries, and the last attempt stops the order in
  `needs_attention` with the reason.
- When a change of supplier names another supplier, the old reference is cleared, and a `sent` order goes to `needs_attention` unless
  the same call dispatches it. A supplier's status answer (poll or staff fetch) is applied only while the order still names the supplier
  and reference it was asked about.
- Every guarded order update also compares `sent_at` with the value the decision was made on.

**Consequences.** Migration 0047 widens `orders_dispatch_state_check`; every existing row satisfies it and the previous release runs
on the new schema. A release before this one does not know `dispatching`: after a rollback, orders being sent at that moment keep it
and need a person (roll forward instead). On its first run the sweep moves every open order that was never claimed and whose newest
request is older than 24 hours to `needs_attention`; an order with no dispatch request at all (seeded demo orders, rows written by
hand) is left alone. After a loss of the queue Redis data the worker is
restarted so that its schedules exist again; docs/OPERATIONS.md lists what comes back by itself and what does not yet.
