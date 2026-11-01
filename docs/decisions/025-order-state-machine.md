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
  queue. `pastSla` = `status IN ('pending','processing') AND placed_at < now() - make_interval(mins => services.sla_minutes)`: age
  only, no queue exclusion (B92), one exported query fragment of the orders read model shared by `GET /admin/orders`, the
  dashboard and System health. The clock is `placed_at`, which the partial index `orders_open_idx (dispatch_state, placed_at)
  WHERE status open` covers; placement never sets `placed_at` or `created_at` explicitly, so both take the same transaction
  `now()` and the wire `createdAt` (= `created_at`, used by the console's SlaCell) is the same instant (a contract test checks
  it on every placement path). A service with a null or 0 SLA is never past SLA.
- **`dispatch_state` transitions** (lead resolution orders-suppliers-11; every action has a test of its resulting queue):

  | Event | From | To (status) |
  |---|---|---|
  | Placement | - | `held` (B2C risk hold), `done` (inventory code delivered at once), `manual` (fulfillment manual or no active supplier link), else `pending` (dispatch job enqueued) |
  | Dispatch job: REFERENCEID | `pending` | `sent` (processing, `sent_at`) |
  | Dispatch job: explicit refusal, timeout, or no eligible link (disabled, paused, or costlier than the charged price, B117 (6)) | `pending` | `needs_attention` (status unchanged, review event with the reason) |
  | Poll or fetch: STATUS 4 / STATUS 3 | `sent`, `needs_attention` | `done` (completed / rejected) |
  | Fetch finds it still running | `needs_attention` | `sent` |
  | `accept` | `manual` | `operator` (processing, queue null) |
  | `reply` / `reject` | any open, not `held` | `done` (completed / rejected) |
  | `refund` (B2B completed) | `done` | `done` (rejected) |
  | `reopen` | `done` (completed) | `operator` (processing, queue null) |
  | Verification accept / refund | `done` | `done` (accept: stays completed, `verification_status` `accepted`; refund: rejected, `verification_status` `refunded`) |
  | Risk approve / risk refund | `held` | `pending` (or `manual` by the placement rule) / `done` (rejected) |
  | Merchant cancel | `pending`, `manual`, `held` | `done` (rejected) |
  | Staff `dispatch` | `needs_attention`, `manual`, `operator` | `pending` + job; `pending` is a 204 no-op (already queued); `held` is `409 ORDER_HELD`; `sent` is `409 ALREADY_SENT` |
  | `change-supplier` | any | unchanged, except `sent` + `resetReference` becomes `needs_attention` (reason 'Supplier changed: dispatch needed'); with `dispatch: true` it becomes `pending` + job |

  The derived queue stays as defined above: `operator`, `sent` and `done` have queue `null`. The B117 (6) failover limit
  applies to automatic failover by the dispatch job only; a staff `change-supplier` may choose a costlier link (the cost
  fields are refreshed and the `supplier_changed` event records `costAbovePrice`), and the following staff `dispatch`
  sends to the chosen supplier service as is.
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
