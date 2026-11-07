# Orders module (`orders`)

Map domain D. One order engine for B2B merchants and B2C storefront customers: placement and balance hold, the status state machine (decision 025), order events and the admin and merchant order actions.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 024 ledger, 025 order state machine, 026 Dhru compatibility. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 5, orders-engine): 20 routes of this module (13 admin, 7 merchant portal) plus the two file downloads of the platform
module, the lead's state machine, and the demo seed. Dispatch, fetch and change-supplier (and the supplier jobs) are built by feature 6 in
the suppliers module, through `OrderSupplierMoves`; the outgoing webhook is 7b, storefront orders 14a and 16, the top-clients report 11.
Built (feature 7a, dhru-and-rest-v1): the six REST v1 order routes and the six Dhru order actions (below), the Idempotency-Key store and
the one `POST /api/index.php` transport route.

- **State machine** (`domain/order-machine.ts`, decision 025): `decideOrderAction` is the only place the rules live; every use case
  asks it and applies its answer through `application/order-transitions.ts` (`OrderTransitions.apply`): the order is read, the
  machine decides, the order changes with a guarded `UPDATE ... WHERE status = $from AND dispatch_state = $from AND
  verification_status IS NOT DISTINCT FROM $from` (zero rows: another request won, `409 INVALID_TRANSITION`, nothing else written),
  the money posts, the timeline lines and the audit row are written and `order.status_changed` goes to the outbox, all in one
  transaction. `accept` on an order that is not in the manual queue answers `NOT_MANUAL` (the endpoint doc's code).
- **Placement** (`application/order-placement.ts`, `OrderPlacement.place`): the one shared path (portal now; Dhru, REST v1 and the
  storefront call it later). Steps in the caller's transaction: the merchant and the service it may see (`MerchantCatalog.find`:
  archived, disabled or hidden is not orderable: `NOT_FOUND`, or `SERVICE_DISABLED` for a disabled one), validation (IMEI 15 digits
  with Luhn: `INVALID_IMEI`; custom field values against the service's fields; quantity against `min_qty`, `max_qty` and
  `qty_options`: `422` with the field path), the price from `PriceResolver` for this merchant, the price guard (`checkPriceChange`
  against `ListedPrices`, tolerance setting `pricing.price_change_tolerance_percent`: `409 PRICE_CHANGED` with `listedPrice` and
  `currentPrice`, or charge and record `raised` in `pricing_snapshot`), the duplicate rule (`services.duplicate_rule = block_open`:
  a keyed hash of merchant, service and main input, taken under an advisory lock so two parallel requests cannot both pass:
  `409 DUPLICATE_ORDER` with `orderId`), then insert (`placed_at` and `created_at` never set, so equal), the `created`, `hold` (and
  `review` for a manual order) lines, the hold in the ledger (`order` event, key `order:<id>:hold`: `INSUFFICIENT_FUNDS` undoes
  everything) and, for an automatic order with an active supplier link, the `order.dispatch_requested` outbox row. The first
  dispatch state is the machine's `placementDispatchState` (`manual` for a manual service or one without an active link). Total
  price and total cost are unit x quantity; the unit cost is the service's effective cost. `placed_at` and `created_at` are one
  injected-clock instant per request (decisions 025, 031).
- **Stock delivery** (RULES orders 10, orders-suppliers-11): a service with at least `quantity` available codes delivers them at
  placement, whatever its fulfilment mode: catalog's `InventoryStock.claim` locks the oldest codes (`FOR UPDATE SKIP LOCKED`:
  two placements at the same moment never share a code), the order is written `completed` / `done` with the codes as its
  result (one per line), the codes become `sold` with the order id, the hold settles at once (`order:<id>:settle`, revenue only:
  no supplier, B17), the timeline gets `completed` and `settle` (system) and `order.status_changed` (`pending → completed`) goes
  to the outbox; no dispatch row. A short stock takes nothing and the order goes the usual way. A delivered code stays sold
  after a reopen or a refund. Not built yet: reserving codes for a held storefront order (sold on completion, back to stock on
  a rejection before delivery), with 14a and 18.
- **Main input** (`domain/main-input.ts`, orders-suppliers-2): `orders.imei` holds the IMEI (type `imei`), the first required
  custom field by sort (server, remote) or the first field's value or the file name (file). The wire sends `''` for none.
- **Money** (`application/order-ledger.ts`): placement holds (`order`: wallet to hold); a reply settles (`complete`: hold to
  revenue, plus supplier prepaid to cost of goods only when the order has a supplier **and** a supplier reference, and only if no
  earlier settlement booked the cost: B17); a reject or a cancel releases (`reject`); a reopen moves the revenue back to the hold and a
  B2B refund moves it straight to the wallet (`reopen` and `refund` builders in money's `domain/money-events.ts`, kinds `adjustment`
  and `refund`, the console's words), both keeping the cost. Keys: `order:<id>:hold`, `order:<id>:settle` (a second completion after
  a reopen is `order:<id>:settle:2`, and so on), `order:<id>:release`, `order:<id>:refund` (B2C), and `reverse:<settlement id>` for a
  reopen or a B2B refund: decision 024's key, which `MerchantSpend` reads to stop counting a reversed settlement (the brief's
  `order:<id>:refund` for the B2B refund is replaced by it for that reason). The settlement to reverse is found by
  `OrderSettlements.liveOf` (money module) by the order reference, so it works for the demo seed's settlements too. A free order
  (price 0) posts nothing. B2C orders: the same builders (`b2c_deliver`, `b2c_refund`, reopen to customer funds) post the ledger
  side; the refunds row and the gateway refund job of `b2c_refund` arrive with feature 16 (B16).
- **Reads** (`application/order-read.service.ts`, `infra/order-read.repository.ts`): one select with the joins the console's row
  needs (service, category, merchant, customer, supplier), the exact `COUNT`, no N+1: `attempts` (the number of `dispatch` events)
  and `reviewReason` (the newest `review`, `risk` or `verification` event that has a `reason`, sent only while the order waits in
  the manual, needs-attention, verification or review queue) are read for the whole page in two queries. The queue and the channel
  are SQL expressions equal to `deriveQueue` (a test compares them for every state combination). **`pastSlaPredicate(now)`**
  (`infra/order-sql.ts`, exported from the index for the dashboard and System health, feature 9) is the one age-only predicate of B92:
  `status IN ('pending','processing') AND services.sla_minutes > 0 AND placed_at < now - sla_minutes`; the caller's query joins
  `services` on `orders.service_id`. `q` searches the input, supplier reference, service, merchant and customer names, and the id
  exactly when it is all digits.
- **Bulk reply** (`application/bulk-reply.service.ts`, `domain/bulk-reply.ts`): preview matches pasted lines (first token is the
  input, the rest the code; whitespace-insensitive, non-empty inputs only, index `orders_imei_squashed_idx`) and refuses a paste of
  more than 500 lines; apply runs each item as its own `reply` transaction and reports refusals in `failed`, plus one summary audit row
  for the request (so an apply where every item failed is still audited).
- **Export** (`application/order-export.service.ts`): counts first (more than 100,000 rows: `422`), writes one `audit_logs` row
  (staff), then streams the CSV in batches of 1,000 by keyset paging on `(sort value, id)`, so rows never repeat or get skipped while
  orders arrive. Cells that start with `=`, `+`, `-`, `@`, tab or CR are written as text. Only the first `_sort` key is used.
- **Merchant stats** (`application/order-client-stats.ts`): the orders source of identity's `ClientStatsDirectory` (30 days of
  `created_at` with no end): orders, spend of the orders not rejected, profit of the completed ones, margin, success rate, last order.
- **Outbox** (`application/order-outbox.ts`, `orders-outbox.module.ts`, also loaded by the worker): see "Events".
- **Seed** (`scripts/seed/orders.ts`): the demo's 760 merchant orders by their demo ids, mapped as the frontend mock maps them
  (completed and rejected are `done`; processing `sent`; a supplier problem is `processing` + `needs_attention`; the first queued
  order becomes the manual order and the two newest completed ones wait for a verification decision), with their 4,491 timeline
  lines. The money seed already posted their holds and settlements: every merchant's `client_hold` equals the sum of its open
  orders (a test proves it) and this seeder posts nothing. `supplier_id` is the order's demo supplier (`sup`), the suppliers seeder of
  feature 6 runs before this one; `supplier_service_id` and `supplier_ref` stay null (the demo has no supplier order numbers, so a
  seeded order is never polled). The 104 storefront orders wait for customers (14b).

### Storefront order tracking (feature 14a)

`GET /store/v1/orders/:token` (`access: tracking-token`, `order-tracking.module.ts`): the holder of an order's public token sees its
status, result and timeline. `TrackingTokenResolver` registers with the identity guard in `onModuleInit`: the order is found by the
unique partial index on `orders.public_token` and the stored token is compared with the presented one in constant time (decision
010 keeps the token as is so the tracking link can be re-sent); a merchant order has no token and can never be opened this way. One
answer (`404 NOT_FOUND`, "This link is not valid.") for an unknown, malformed or nearly-right token; lookups are limited to 30 a
minute per address by the pipeline. The view (`application/order-tracking.service.ts`, `domain/tracking.ts`): `status` (a risk hold
reads `pending`), the service name, type and delivery time, the main input with all but its last four characters hidden, the
quantity, `placedAt`, `completedAt`, `result { code, comment }` once the order is `completed` (null before; a rejection's reason
never leaves), and the timeline limited to `created`, `paid`, `accepted`, `completed`, `rejected`, `refund` and `reopened` in fixed
words (never the stored `data.message`, which can name a supplier, a cost or a merchant). Never cached (`Cache-Control:
no-store`). Placing a storefront order (which writes `public_token`) is feature 16.

### Merchant portal contract (no console screen; ALIGNMENT § 7, B121, B153, recorded as B160)

The shapes of the seven `/client` routes are written here because the map rows are one-liners (MISMATCHES B160 holds the same
spec). Money is a 4-decimal string, times
are ISO with milliseconds, ids are numbers, lists are simple-rest with `x-total-count`.

- `GET /client/dashboard`: `{ wallet: {balance, reserved, creditLimit, available}, counts: {pending, processing, completed,
  rejected}, openOrders, latestOrders: [order x 5] }`.
- The merchant's order: `{ id, status, imei, quantity, inputs, unitPrice, totalPrice, currency, service: {id, name, type}, source,
  result: {code, comment, fileId}, verificationStatus, clientNote, inputFileId, canCancel, canVerify, createdAt, completedAt }`.
  Never cost, supplier, supplier reference, notes, queue, dispatch state, pricing snapshot or risk. `GET /client/orders/:id` adds
  `events: [{id, type, message, createdAt}]`, only the types `created`, `hold`, `accepted`, `completed`, `rejected`, `release`,
  `refund`, `reopened` and `verification` (never a note, a supplier line or the settlement, which shows the cost).
- `POST /client/orders` (`201 { orders: [order] }`): body `{ serviceId, imei? | imeis? (1-100), quantity?, inputs?, fileId? }`.
  `imeis` places one order per IMEI of the same service, **all or none** in one transaction (the first refusal, including
  `INSUFFICIENT_FUNDS` or a duplicate inside the list, undoes the request). Problems are named by field: `imei`, `imeis.2`,
  `quantity`, `inputs.<key>`, `fileId`.
- `GET /client/orders`: filters `status` (and `status_ne`), `type`, `serviceId`, `createdAt_gte`/`createdAt_lte`; `q` over the input,
  the service name and the id; sorts `createdAt` (default, newest first), `totalPrice`, `status`. Another merchant's order is `404`.
- `POST /client/orders/:id/cancel` (`204`): only while the order was never sent (`pending`, `manual`, `held`) and the service has
  `allow_cancel`: rejected as "Cancelled by the merchant", the hold released. `ALREADY_SENT` once sent; `INVALID_TRANSITION` when
  the service forbids it or staff already work on the order.
- `POST /client/orders/:id/verify` (`204`): a completed order, once, when the service has `allow_verify` and inside
  `verify_window_h` hours of completion (0 hours means no window); `INVALID_TRANSITION` otherwise.
- `GET /client/orders/export`: CSV `id,created,service,input,quantity,status,price,currency`, same filters; 100,000 rows at most.
- `GET /client/files/:id` and `GET /admin/files/:id` (platform module, B154): `302` to a presigned link that lives 5 minutes.
- **REST v1 orders** (`application/api-orders.service.ts`, `controllers/v1-orders.controller.ts`, feature 7a): `POST /v1/orders`,
  `POST /v1/orders/bulk`, `GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/orders/:id/cancel` and `POST /v1/orders/:id/verify` act for
  the merchant behind the API key (principal `api-key`; scopes `orders:write` and `orders:read`). Placement is `OrderPlacement.place` on
  the service's own transaction (source `v1`, the key's id on the order), so the price, the user rule 9 guard (`409 PRICE_CHANGED` with
  `listedPrice` and `currentPrice`), the duplicate rule, the hold and the dispatch row are the portal's. The answer is the portal's
  merchant order plus `canCancel` and `canVerify`. Cancel and verify are the portal's use cases (`ClientOrdersService`) and answer the
  order. Lists are cursor pages (`?limit=` 1 to 100, default 50, `?cursor=`: `{ data, nextCursor }`, newest first, the cursor is the id of
  the last order sent) with the filters `status` (comma list), `ids` (up to 100), `imei` (exact, whitespace ignored) and `updatedSince`.
  Another merchant's order is `404`. No audit row (B121); the timeline names the merchant as the actor.
- **Idempotency** (`application/idempotency-store.ts`, `infra/idempotency.repository.ts`, table `idempotency_keys`, migration 0009):
  `Idempotency-Key` (1 to 255 printable characters) on `POST /v1/orders` and `/v1/orders/bulk`. Inside the placement's transaction the
  key is locked without waiting (`pg_try_advisory_xact_lock` on merchant and key: a second request that arrives while the first runs is
  `409 IDEMPOTENCY_IN_PROGRESS`, `Retry-After: 1`), the stored answer is read, and when there is none the placement runs and its status
  and body are inserted before the commit, so the orders and the answer exist together or not at all. The same key with the same
  scope and request hash (keyed hash of the canonical body: key order does not matter) replays the stored status and body with
  `Idempotency-Replayed: true` and posts nothing (not even when the wallet is empty or the service is off by then); another body or the
  other route is `409 IDEMPOTENCY_KEY_REUSED`. A refusal stores nothing, so the key may be tried again. Keys are per merchant and are
  kept for as long as the row lives (no expiry job yet). A single placement also keeps the key on `orders.idempotency_key`.
- **Bulk over REST v1**: each item is placed inside a savepoint of one transaction, in the order sent, drawing on one wallet: a refused
  item (`INSUFFICIENT_FUNDS`, `PRICE_CHANGED`, `DUPLICATE_ORDER`, `INVALID_IMEI`, ...) undoes only itself and is answered in its place as
  `{ index, ok: false, error: { code, status, title, detail, errors?, listedPrice?, currentPrice?, orderId? } }`; the answer is `200` even
  when every item was refused. A body that is not valid (no orders, more than 100, an item without `serviceId`) is `422` as a whole.
- **Dhru** (`application/dhru-orders.ts`, `controllers/dhru.controller.ts`, `contracts/dhru.contracts.ts`, decision 026):
  `POST /api/index.php` is the one transport route (access `dhru-credentials`: `username` + `apiaccesskey` with the `dhru` scope; form,
  multipart or JSON). It reads `action` and the base64 `parameters` and asks the shared `DhruGateway` (`src/common/dhru`), which runs
  the handler the owning module bound to the action and answers `{ SUCCESS: [...], apiversion }` or `{ ERROR: [{ MESSAGE }], apiversion }`
  (HTTP 200 always; the error formatter words each refusal: `Authentication Failed`, `Invalid Action`, `Not enough credits`,
  `Price changed. Please refresh the service list and order again.`). This module owns `placeimeiorder` (`{ MESSAGE: 'Order received',
  REFERENCEID }`, our order id as text), `placeimeiorderbulk` (one entry per caller request id, items placed one after the other, each
  in its own transaction), `getimeiorder` and `getimeiorderbulk` (`STATUS` 0 new, 1 in process, 3 rejected, 4 completed, `CODE` the result
  or reason, `""` while it runs; another merchant's order is `Order not found`), `placefileorder` (`FILENAME` + base64 `FILEDATA`, or a file
  part of a multipart call; stored through platform's `FileUploadService`; an IMEI service in `placefileorder` and a File service in
  `placeimeiorder` are refused naming the right action) and `getfileorder` (adds `FILEID` when staff attached a result file). Dhru has
  no idempotency field: a repeated placement is stopped by the duplicate rule. Money's `accountinfo` and catalog's `imeiservicelist` are
  bound to the same gateway by their modules.
- A multipart placement during maintenance is refused by the pipeline too: `registerMultipartBodies` (`src/common/multipart.ts`) parses
  the three multipart routes before the guards, so the maintenance stage sees the Dhru `action`.

Open point: none for the merchant's cancel and verify any more: staff set `allowCancel`, `allowVerify` and `verifyWindowH` (0 to 720
hours, 0 = no window) through `POST|PATCH /admin/services` (feature 7a, catalog module); they start off.

## Public API (`index.ts`)

Exports `OrdersModule` (with `OrdersOutboxModule`, which the worker loads, and `OrdersAdminModule`, the routes and use cases), the pure
rules (`decideOrderAction`, `deriveQueue`, `isOpen`, `placementDispatchState`, `mainInputOf`), the SQL fragments (`pastSlaPredicate`,
`queueSql`, `channelSql`), the services other features call (`OrderPlacement` for Dhru, REST v1 (7a) and the storefront; `OrderTransitions`
for the risk actions; `OrderSupplierMoves`, the door of the supplier flows, and `OrdersEngineModule`, which provides both without routes for
the worker; `OrderReadService`), the outbox event names (`ORDER_OUTBOX_EVENTS`, `OrderOutbox`) and the
vocabularies and row types of the two tables. Other modules import only `src/modules/orders/index.ts` (lint rule
`gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 2 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `orders` | Orders; id equals REFERENCEID. client_id accepts null for storefront (B2C) orders, which fill customer_id instead; exactly one of the two is set. |
| `order_events` | The order timeline; append only. |

## Routes

40 endpoints (admin 17, client 7, store 3, v1 6, dhru 6, events 1). Source: `docs/slices/orders.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built. **Built by feature 5:** the 13 admin routes with stage 5 and the 7 `/client` routes (contracts in `contracts/orders.contracts.ts`, `order-actions.contracts.ts`, `client-orders.contracts.ts`; controllers in `controllers/`). The rows with stage 6, 7, 11, 14 and 16 are built by those features.

### Admin console (17)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/orders` | staff-permission · `orders:read` | Orders and their queues (pending, manual, needs_attention, verification, review); filter by channel=b2b\|b2c. | 5 |
| `GET /admin/orders/:id` | staff-permission · `orders:read` | Orders and their queues (pending, manual, needs_attention, verification, review); filter by channel=b2b\|b2c. | 5 |
| `GET /admin/orders/:id/events` | staff-permission · `orders:read` | The full order timeline. | 5 |
| `GET /admin/orders/export` | staff-permission · `orders:read` | Export a CSV file according to the filters. | 5 |
| `GET /admin/reports/top-clients` | staff-permission · `reports:read` | Top merchants by volume and by profit. | 11 |
| `POST /admin/orders/:id/accept` | staff-permission · `orders:update` | Accept a manual order and move it to processing. | 5 |
| `POST /admin/orders/:id/change-supplier` | staff-permission · `orders:update` | Change the supplier or reset the reference. | 6 (built in the suppliers module) |
| `POST /admin/orders/:id/dispatch` | staff-permission · `orders:update` | Manually send the order to the supplier (force send). | 6 (built in the suppliers module) |
| `POST /admin/orders/:id/fetch` | staff-permission · `orders:update` | Fetch the result now (force get). | 6 (built in the suppliers module) |
| `POST /admin/orders/:id/notes` | staff-permission · `orders:update` | Add an internal note. | 5 |
| `POST /admin/orders/:id/refund` | staff-permission · `orders:reopen` | Refund a completed merchant order: reopen, then reject; storefront orders are refunded from /admin/refunds. | 5 |
| `POST /admin/orders/:id/reject` | staff-permission · `orders:update` | Reject the order with a reason and refund it. | 5 |
| `POST /admin/orders/:id/reopen` | staff-permission · `orders:reopen` | Reopen a completed order back to processing. | 5 |
| `POST /admin/orders/:id/reply` | staff-permission · `orders:update` | Complete the order with its result. | 5 |
| `POST /admin/orders/:id/verification` | staff-permission · `orders:update` | Verification decision: accept or refund. | 5 |
| `POST /admin/orders/bulk-reply/apply` | staff-permission · `orders:update` | Apply the matched replies. | 5 |
| `POST /admin/orders/bulk-reply/preview` | staff-permission · `orders:update` | Match IMEI and CODE lines to orders. | 5 |

### Merchant portal (7)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/dashboard` | merchant-session | Summary: balance and latest orders. | 5 |
| `GET /client/orders` | merchant-session | My orders, with filters and IMEI search. | 5 |
| `GET /client/orders/:id` | merchant-session | Order details with the timeline. | 5 |
| `GET /client/orders/export` | merchant-session | Export orders as CSV. | 5 |
| `POST /client/orders` | merchant-session | Place an order; accepts a list of IMEIs for a bulk order. | 5 |
| `POST /client/orders/:id/cancel` | merchant-session | Cancel an order. | 5 |
| `POST /client/orders/:id/verify` | merchant-session | Request verification of the result. | 5 |

### Storefront (B2C) (3)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /store/v1/me/orders` | customer-session | My orders and their status. | 14 |
| `GET /store/v1/orders/:token` | tracking-token | Tracking page by token: status, result and timeline. | 14 |
| `GET /store/v1/orders/:token/receipt` | tracking-token | PDF receipt with the net amount, the tax and its rate, and the customer's country. | 16 |

### REST API v1 (6)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /v1/orders` | api-key · `orders:read` | Order list: filter by status, ids, imei and updatedSince, with cursor pagination. | 7 |
| `GET /v1/orders/:id` | api-key · `orders:read` | Order status and result. | 7 |
| `POST /v1/orders` | api-key · `orders:write` | Place an order; supports Idempotency-Key. | 7 |
| `POST /v1/orders/:id/cancel` | api-key · `orders:write` | Cancel an order that is still pending, if the service allows it. | 7 |
| `POST /v1/orders/:id/verify` | api-key · `orders:write` | Request verification of the result within the allowed window. | 7 |
| `POST /v1/orders/bulk` | api-key · `orders:write` | Up to 100 orders, with a result per item. | 7 |

### Dhru Fusion API (6)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DHRU getfileorder` | dhru-credentials | Result of a File order (optional). | 7 |
| `DHRU getimeiorder` | dhru-credentials | Order status and result. | 7 |
| `DHRU getimeiorderbulk` | dhru-credentials | Status of several orders. | 7 |
| `DHRU placefileorder` | dhru-credentials | Place a File service order (optional, for older clients). | 7 |
| `DHRU placeimeiorder` | dhru-credentials | Place an IMEI or Server order and hold the balance. | 7 |
| `DHRU placeimeiorderbulk` | dhru-credentials | Place several orders in one request. | 7 |

### Outgoing webhook events (1)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `EVENT order.status_changed` | outbound-hmac | An order changed status; the payload carries the whole order. | 7 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `success`: Order completed by the supplier (tables: `order_events`, `orders`)
- `reject`: Supplier rejects the order (tables: `order_events`, `orders`)
- `manual`: Manual fulfilment by staff (tables: `order_events`, `orders`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `order_events`, `orders`)
- `b2c-paid`: Paid storefront order (tables: `order_events`, `orders`)
- `b2c-refund`: Refund before delivery (tables: `order_events`, `orders`)
- `b2c-chargeback`: Chargeback dispute that we lose (tables: `order_events`, `orders`)
- `b2c-ticket`: Support ticket about a delay (tables: `order_events`, `orders`)
- `system-alert`: Alert and incident: a supplier slows down (tables: `order_events`, `orders`)

## Permissions

Staff permissions the map requires on this module's admin routes: `orders:read`, `orders:reopen`, `orders:update`, `reports:read`.

API key scopes on its REST v1 routes: `orders:read`, `orders:write`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (ids and status words only, written in the transition's own transaction):

| Type | Queue | Payload | Written when | Consumer |
|---|---|---|---|---|
| `order.status_changed` | `merchant-webhooks` | `{ orderId, clientId (null for a storefront order), fromStatus, toStatus }` | the status of an order changed (accept, reply, reject, cancel, reopen, refund, a verification refund) | the webhook fan-out of feature 7b |
| `order.dispatch_requested` | `supplier-dispatch` | `{ orderId }` | placement of an automatic order with an active supplier link; a staff `dispatch` and a `change-supplier` with `dispatch: true` (feature 6) | the dispatch job of feature 6 (`SupplierDispatchProcessor`) |

Feature 5 registers both routes (`OrderOutbox.onModuleInit`, loaded by the API and the worker) and adds no processor for either queue:
7b built the webhook fan-out and 6 the dispatch job. The creation of an order is not a status change and writes no `order.status_changed`.
A dispatch row for an order that is rejected or completed before the job runs is harmless: the job re-reads the order and moves it
only through the guarded transition (decision 025). Consumed: none.

Outgoing webhook events from the map (documented as OpenAPI `webhooks` once defined with `defineEvent`): `order.status_changed` (7b).

## Jobs and schedules

None in this feature. The dispatch job (`supplier-dispatch`) and the poll jobs (`supplier-poll`) are feature 6 (suppliers module); the
webhook deliveries (`merchant-webhooks`) are 7b. See `docs/queues.md`.

## Cache keys

None. The order status, the holds and the ledger are decision state and are never cached (decision 022); every read goes to Postgres.
The price tolerance setting is read through the platform's cached settings snapshot (`SettingsReader`, 60 s).

## Audit

Staff actions write `audit_logs` with the demo's verb phrases (ANSWERS audit Q3; the console prints `<actor> <action> <entityLabel>`),
entity type `order`, label `ORD-<id> for <merchant>` and the status before and after: `accepted order`, `completed order`,
`rejected order`, `reopened order`, `refunded order`, `accepted verification of`, `refunded after verification of`, `added a note to`.
A bulk apply also writes `applied bulk reply to` (label `N of M orders`) and an export `exported` (label `N orders`).
`POST /admin/orders/bulk-reply/preview` changes nothing and is declared `audit: false`. Merchant routes write no audit row (B121).

## Tests

Unit: the machine, main input, placement rules, bulk reply, CSV, timeline lines, views, outbox, the Dhru contracts, the idempotency
hash. Integration (`test/integration/`): `client-orders-placement`, `client-orders`, `orders-read`, `orders-actions`, `orders-b2c-actions`,
`orders-bulk-reply`, `orders-export`, `orders-client-stats`, `orders-seed`, `files`, and (7a) `dhru-surface`, `rest-v1`,
`rest-v1-idempotency`, `files-upload`. The Dhru fixtures (one request/response record per action, checked on keys and types):
`test/dhru/`. Scenarios `success`, `reject`, `timeout` and `manual` (`test/scenarios/`) include the merchant's Dhru calls
(`placeimeiorder`, `getimeiorder`).

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `identity-platform-10` · GET /admin/dashboard
- `orders-suppliers-1` · GET /admin/orders
- `orders-suppliers-2` · GET /admin/orders, GET /admin/orders/:id
- `orders-suppliers-11` · POST /admin/orders/:id/accept, reply, reject, reopen, refund, verification, dispatch, fetch, change-supplier
- `orders-suppliers-12` · POST /admin/orders/:id/change-supplier, POST /admin/orders/:id/dispatch
- `orders-suppliers-14` · GET /admin/orders, GET /admin/orders/:id
- `orders-suppliers-15` · GET /admin/orders/:id/events
- `orders-suppliers-17` · POST /admin/orders/:id/change-supplier
- `orders-suppliers-18` · POST /admin/orders/:id/reject
- `orders-suppliers-19` · POST /admin/orders/:id/dispatch, POST /admin/orders/bulk-reply/apply, GET /admin/orders/export
