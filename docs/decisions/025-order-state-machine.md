# 025: Order engine: status, dispatch state, queues and money per transition

Status: accepted, 2026-10-31. Sources: map statuses and scenarios (success, reject, manual, timeout, b2c-*), the
frontend Order contract (`docs/contract/endpoints/orders.md`).

**Decision.**
- `orders.status` (wire and Dhru): `pending` (0), `processing` (1), `completed` (4), `rejected` (3). Allowed:
  pending → processing | completed | rejected; processing → completed | rejected; completed → processing (reopen) |
  rejected (refund, verification refund); rejected is final. A closed order refuses actions with
  `409 ORDER_NOT_OPEN`.
- `orders.dispatch_state` (internal, passed through on the wire): `pending` (waiting for the dispatch job), `held`
  (B2C risk review), `manual` (operator needed: manual service or no active supplier link), `operator` (accepted by
  staff), `sent` (supplier accepted, polling), `needs_attention` (timeout or supplier error; never re-sent
  automatically), `done` (finished or served from inventory).
- `queue` on the wire is derived: `review` = held; `manual` = pending + manual; `needs_attention` = needs_attention
  (status stays pending until a REFERENCEID exists); `verification` = completed + `verification_status` requested;
  `pending` = pending + dispatch pending; otherwise null. `reviewReason` = text stored on the event that opened the
  queue. `pastSla` = open and older than the service's SLA minutes (one predicate for orders and System health).
- Every transition is one DB transaction: guarded `UPDATE orders … WHERE id = $1 AND status = $2 [AND
  dispatch_state = $3]` (0 rows → 409), an `order_events` row (actor `staff | client | customer | supplier | system`),
  the ledger posting through `postTransaction` with idempotency key `order_event:<event id>`, and an outbox
  `order.status_changed` row when the status changed. Staff actions also write `audit_logs`.
- Money per transition (map money events): placement B2B = `order` (wallet → hold); B2C order creation on payment =
  `b2c_pay` + `b2c_fee`; completion B2B = `complete` (cogs line only when a supplier or stock cost exists), B2C =
  `b2c_deliver`; rejection B2B = `reject`, B2C before delivery = `b2c_refund` with a system-approved refund row and a
  gateway refund job; reopen = revenue back to hold (B2B) or customer funds (B2C), cogs kept; B2B refund of a
  completed order = revenue → wallet in one step (reopen + reject), cogs kept; B2C refunds of delivered orders go
  through `/admin/refunds` (`409 USE_REFUNDS`). Accept, notes, change-supplier, dispatch and fetch move no money.
- Supplier flow (worker): dispatch job sends `placeimeiorder`; a REFERENCEID → `sent` + processing; an explicit
  refusal or a timeout → `needs_attention` with the reason, hold kept, staff alerted. Polling `getimeiorder`: every
  minute for 1 h, then every 5 min, then every 30 min after `orders.poll_slow_after_hours` (setting, default 24);
  STATUS 4 → complete, STATUS 3 → reject.
- Inventory services reserve a code at placement, mark it sold on completion (it becomes the result), release it on
  rejection before delivery; a delivered code never returns to stock.
- Cancellation by the merchant (`/client`, `/v1`): only while the order was never sent (`pending | manual | held`)
  and the service allows it; posts `reject`. Verification: within `verify_window_h` of completion when the service
  allows it; staff decide accept or refund.
- `orders.source` ∈ `dhru | v1 | portal | store | admin`; `channel` on the wire = b2b when `client_id` is set,
  b2c when `customer_id` is set.

**Consequences.** All state lives in Postgres; jobs re-read the order and act only through guarded transitions, so
a retried or duplicated job is harmless. Each map scenario is an e2e test of these transitions.
