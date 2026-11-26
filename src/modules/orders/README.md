# Orders module (`orders`)

Map domain D. One order engine for both doors, the merchant doors (balance hold and settle) and the shop's door (pay first), with one account as the buyer of every order (decision 064): placement and balance hold, the status state machine (decision 025), order events and the admin and merchant order actions.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 024 ledger, 025 order state machine, 026 Dhru compatibility, 051 field patterns and the bulk reply's lines (feature 41), 064 one account type, 065 one Name per field and the main input flag, 070 order forms draw only the custom fields, 073 IMEI is a field type. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

## The buyer account and the door (decision 064)

This section holds the rules of the one account type; where an older bullet below says "merchant" for the buyer of a hold-and-settle order or "customer" for the buyer of a storefront order, read it with this section.

- **The buyer and the door.** The buyer of every order is an account (`orders.account_id`, NOT NULL), whatever its rank. **The door** is `orders.source` (`store` is the shop's door; `portal`, `dhru`, `v1` and `admin` are the merchant doors (only the first two place orders today; `v1` and `admin` are in rows written before)), and the door decides the money path of an existing order, never the rank the buyer has today: `isPrepaidOrder(order)` and `prepaidOrderSql(sourceColumn)` (`domain/door.ts`, exported) say whether an order is paid first (the shop's door), `orderStateOf(order)` reads `source`, and a tooling test fails on a buyer inferred from a null `client_id` or `customer_id`. `client_id` is still written for hold-and-settle orders (`orders_hold_buyer_check`: it is null or equals `account_id`; `orders_door_check`: `(source = 'store') = (client_id IS NULL)`) and never read; `customer_id` is `retiredCustomerId`, unwritten. The order input keys `clientId` and `onlyClientId` keep their names; the value is an account id.
- **Placement from a wallet** (`OrderPlacement.place({accountId, ...})`, `application/order-placement.ts`; pure rules in `domain/buyer-rules.ts`, reads in `infra/buyer.repository.ts`): the transaction takes the buyer's account row first (`FOR KEY SHARE`, and the rank is read after the lock) and refuses, before it writes anything, a retail rank (403 `RANK_NOT_ALLOWED`), an account that may not act (403 `ACCOUNT_SUSPENDED`) and a frozen merchant wallet (409 `WALLET_FROZEN`, money's `AccountWallets.assertNotFrozen`, called after the row lock and before the hold). `CustomerOrderPlacement.place(tx, {accountId, ...})` places the shop's order after payment. The pricing snapshot gains `rankId`. Every transition that moves money (settle, release, refund, reopen) takes the same account row lock first, then the order, then the advisory and ledger locks.
- **A refund after a change of rank.** A refund of a completed hold-path order credits the wallet that is **live now** (money's `refund` builder with `wallet`); a store-balance refund of a completed merchant-door order is `refundToStoreBalance` in `order-ledger.ts`. A **reopen** after the account left the merchant rank is refused with `409 RANK_CHANGED` ("Refund the order instead.") because it is a new debit; reject and cancel cannot meet a crossing, because the rank change is blocked while any order of the account is in flight: this module registers the blocker `live_order` (`LiveOrdersGuard`: status `pending` or `processing`, or `completed` with verification requested, any door) with money's `RankChangeGuards`.
- **The buyer account on the wire (staff).** A staff order row names it as `account {id, name, email, rank {id, name, kind}, guest}` (the address masked without `clients:read`; `guest` for an address that ordered without a login); the keys `client` and `customer` are gone. Filters `accountId`, `clientId` (an alias: a merchant's number is its account number) and `rankId`; `customerId` is `422`, because an old customer number is not an account number; the search reads names, never addresses; `channel` is told by the door the order came through (`source`), never by the rank the buyer has today. The staff export ends with the buyer's `rank`. Each line of `GET /admin/orders/:id/events` adds `account {id}` or null: an event written before the accounts merged keeps its old actor word (`client`, `customer`) and the answer resolves it through the legacy id map (`actorFactsOf`), and a number the map does not know names nobody; `TimelineActor.type` is `CurrentOrderEventActorType` (staff, account, supplier, system). The bulk reply's matched line carries `account` in place of `client` and `customer` (owner key `account <id> service <id>`).
- **Scopes: staff, merchant doors, shop door.** The portal (`GET /client/orders*`, the dashboard, the export, cancel and verify) and the Dhru status read the account's orders of the **merchant doors only** (`merchantDoorSql(accountId)`); the account's own shop order is 404 there and is listed by `GET /store/v1/me/orders` through the seam `ShopOrders.listShopOrders(db, accountId, query)` (`ports/shop-orders.ts`, implemented by `ShopOrderReads`; `shopDoorSql(accountId)`). The seam's rows are `ShopOrderRow`, which carry the stored tracking token (`publicTokenEnc`, or the plain `publicToken` of an order placed before decision 054) for the customers module to reveal. The error lists of `POST /client/orders` and the Dhru placement gain `RANK_NOT_ALLOWED`, `ACCOUNT_SUSPENDED` and `WALLET_FROZEN`.
- **Order figures of the account list.** The count, the date and the total of the orders of an account reach identity's account list as SQL fragments this module registers with `AccountListSql.registerOrderFigure` (`orderFigureSql(figure, accountIdColumn)` for `ordersCount`, `lastOrderAt` and `totalSpent`, both doors, any status); `OrderClientStats` also registers with identity's `ClientStatsDirectory` (`lifetimeOf(db, accountIds)`).
- **The orders participant of the guest claim** (`OrdersGuestClaimParticipant`, `ORDERS_PARTICIPANT` = `orders`): the shop orders of a guest row move to the account that proves the mailbox, taking the rows `FOR UPDATE NOWAIT`; its count is `claimedOrders`.
- **Outbox payload.** `order.status_changed` carries `{ orderId, accountId, source, fromStatus, toStatus }` in place of `clientId` (older rows still in the queue carry `clientId` and no `source`); the merchant notice goes only for orders held from a wallet (a `store` order is skipped, `no_merchant`). The idempotency of the portal is per account (the column `client_id` of `idempotency_keys` holds the account id).

The rest of this section is the history of the module's features.

Built (feature 5, orders-engine): 20 routes of this module (13 admin, 7 merchant portal) plus the two file downloads of the platform
module, the lead's state machine, and the demo seed. Dispatch, fetch and change-supplier (and the supplier jobs) are built by feature 6 in
the suppliers module, through `OrderSupplierMoves`; storefront orders are 14a and 16, the top-clients report (built by feature 11 in the money module's `ReportService`).
Built (feature 7a, dhru): the six Dhru order actions (below), the Idempotency-Key store of the portal and
the one `POST /api/index.php` transport route.

- **State machine** (`domain/order-machine.ts`, decision 025): `decideOrderAction` is the only place the rules live; every use case
  asks it and applies its answer through `application/order-transitions.ts` (`OrderTransitions.apply`): the order is read, the
  machine decides, the order changes with a guarded `UPDATE ... WHERE status = $from AND dispatch_state = $from AND
  verification_status IS NOT DISTINCT FROM $from AND sent_at IS NOT DISTINCT FROM $from` (zero rows: another request won, `409
  INVALID_TRANSITION`, nothing else written), the money posts, the timeline lines and the audit row are written and
  `order.status_changed` goes to the outbox, all in one transaction. `accept` on an order that is not in the manual queue answers
  `NOT_MANUAL` (the endpoint doc's code). Decision 044: a send in flight is the dispatch state `dispatching` (the dispatch claim sets it
  with `sent_at`; the supplier's answer applies only to its own claim, and a supplier's status answer only while the order still names
  the supplier and reference it was asked about: the guard also compares them). While an order is `dispatching`, staff reply, reject,
  change of supplier, staff dispatch and a storefront refund approval wait (`409 ALREADY_SENT` with `SEND_IN_PROGRESS_DETAIL`) and the
  merchant's cancel is `409 ALREADY_SENT`. The merchant's cancel is also refused for good once the order was ever claimed for a supplier
  call (it has at least one `dispatch` event), even when a failed or lost send reads `pending` again: the machine's state carries
  `everDispatched`, `OrderTransitions.apply` reads it (one count of `dispatch` events) only for a cancel, and the order read model
  (`OrderRow.everDispatched`, one `EXISTS` in the same select) feeds `canCancel`, so the button and the route agree; such an order is
  cancelled by staff. `orderStateOf` is the one conversion of a stored order to the machine's state (a `pending`
  order with `sent_at` set, claimed by an earlier release, counts as `dispatching`); `wireDispatchState` shows `dispatching` as
  `pending`, so no response, queue or contract enum changes. A storefront order is released from a risk hold, sent to a supplier, accepted or
  completed by staff only while its payment stands: the machine's state carries `paymentStop` (`disputed` while a dispute is open,
  `returned` once the payment was charged back or refunded in full, `paymentStopOf`), read through the money module's `orderPaymentStatus`
  only for the risk release, a staff send, a change of supplier that sends, an accept and a staff reply (also each line of the bulk reply)
  (`paymentCanStop`), never for a merchant's order; those are `409 INVALID_TRANSITION` with `PAYMENT_STOP_REASONS` as the detail, and the
  dispatch job stops such an order in `needs_attention` with the same sentence before it claims it (`OrderSupplierMoves.paymentStop`).
  Refunding or rejecting the order stays open; a supplier that already has the order still completes or rejects it. An order delivered
  before and reopened is still delivered again by a staff reply (`completedBefore`): its reject is `USE_REFUNDS`, and a second delivery
  books no new supplier cost. A rejection of a
  charged-back payment refunds nothing (`MoveOutcome.chargedBack`): the timeline's refund line says so (`CHARGED_BACK_REFUND_LINE`) and
  no `order.failed` mail is written.
- **Placement** (`application/order-placement.ts`, `OrderPlacement.place`): the one shared path (portal now; Dhru and the
  storefront call it later). Steps in the caller's transaction: the merchant and the service it may see (`MerchantCatalog.find`:
  archived, disabled or hidden is not orderable: `NOT_FOUND`, or `SERVICE_DISABLED` for a disabled one), validation (custom field values
  against the service's fields, each by its type: a field of type `imei` is 15 digits with Luhn, else `INVALID_IMEI`, decision 073; where a
  pattern outside the supported form of decision 051 is not run (the field then has no pattern, `compileFieldPattern`); quantity against `min_qty`, `max_qty` and
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
- **Stock delivery** (RULES orders 10, orders-suppliers-11, decision 069): a service delivered from code stock
  (`services.stock_delivery`) with at least `quantity` available codes delivers them at placement, whatever its fulfilment mode, in
  every path (portal, REST v1, Dhru single and bulk, the shop); codes held by any other service are never taken (`claim` reads the
  flag): catalog's `InventoryStock.claim` locks the oldest codes (`FOR UPDATE SKIP LOCKED`:
  two placements at the same moment never share a code), the order is written `completed` / `done` with the codes as its
  result (one per line), the codes become `sold` with the order id, the hold settles at once (`order:<id>:settle`, revenue only:
  no supplier, B17), the timeline gets `completed` and `settle` (system) and `order.status_changed` (`pending → completed`) goes
  to the outbox; no dispatch row. A short stock takes nothing and the order goes the usual way. A delivered code stays sold
  after a reopen or a refund. Not built yet: reserving codes for a held storefront order (sold on completion, back to stock on
  a rejection before delivery), with 14a and 18.
- **Main input** (`domain/main-input.ts`, orders-suppliers-2, `mainInputOf`): `orders.imei` holds the value of the field flagged as the
  main input when it has one (decision 065: what the dispatch sends as `IMEI`, so the duplicate check of `block_open` names it too); on an
  IMEI service else the `imei` the request sent, and nothing more when the service has a main-input field (decision 073: an empty optional
  IMEI field never lets another field travel as `IMEI` and in CUSTOMFIELD at once, so the dispatch sends no `IMEI`); else the first
  required custom field by sort (an IMEI service without a main-input field, server, remote) or the first field's value or the file name
  (file). The wire sends `''` for none.
- **Field types and the IMEI** (decisions 065, 070 and 073). A field of type `imei` holds one IMEI on any service, main input or not: its
  value is read as digits (spaces and dashes removed, `fieldValueOf`), must be 15 digits with a valid Luhn check digit (`invalid_imei` on
  its path; the answer's code is `INVALID_IMEI`, 422) and is stored as those digits (`normalizedInputs`); `required` and the pattern work as
  on any field (the pattern judges the digits). The service type `imei` forces nothing: an IMEI service's order form is its custom fields,
  each judged by its own type, Required tick and pattern (`inputProblems`), so an optional main input may be left empty, a text main input
  takes letters (an ECID) and an IMEI service without fields takes no input at all. A service's field flagged `is_main_input` (at most
  one) is the main input. Older callers of an IMEI service send the main input as `imei` (older shop pages, Dhru's `IMEI` parameter, each
  item of a bulk `imeis`): when it has text it is the main-input field's value (`bridgedImeiOf`), wins over a value under that field's
  key and is judged by that field, its problems on the item's IMEI path (`imei`, `imeis.N`, `IMEI`); without such a field it is taken as
  typed (trimmed) and stored as the order's main input with no IMEI check. Without `imei` the field is judged on the value under its key,
  its problems on `inputs.<key>` (Dhru keeps them on `IMEI`: our list leaves the field out); a missing value is refused only when the field
  is required. The request schemas refuse an empty `imei` with `422` on `imei` before placement. A bridged `imei` is stored under the
  field's key only when the request sent that key, so an IMEI typed into the field makes the same order (duplicate check, dispatch as
  `IMEI`) as one sent as `imei`. `imei` sent for a non-IMEI service stays `422 not_applicable`; a field that is only
  keyed `imei` is an ordinary field. A Dhru caller names its `CUSTOMFIELD` values by field **Name** (what `imeiservicelist` shows as `fieldname`): `inputsByFieldName`
  (`domain/field-inputs.ts`) matches a name to a Name exactly (the `supplier_key` column), then to a key exactly, then to a Name trimmed and
  without regard to case, and keeps a name that matches nothing as sent (so `inputProblems` answers `unknown_field`); a field sent twice is `422`
  `duplicate_field` on `inputs.<later name>`. `orders.inputs` stays keyed by the hidden key, whoever placed the order.
- **Answers** (`domain/order-answers.ts`). `GET /admin/orders/:id` and `GET /client/orders/:id` add `answers: [{ key, label, value }]`:
  the service's fields in form order that have a value under their label as it is now, then stored keys no field has any more, under
  their own key as the label. The list routes do not carry it.
- **Money** (`application/order-ledger.ts`): placement holds (`order`: wallet to hold); a reply settles (`complete`: hold to
  revenue, plus supplier prepaid to cost of goods only when the order has a supplier **and** a supplier reference, and only if no
  earlier settlement booked the cost of the supplier's current acceptance: B17, a new send the supplier accepted after a reopen
  is a new charge); a reject or a cancel releases (`reject`); a reopen moves the revenue back to the hold and a B2B refund moves it straight to the wallet (`reopen` and `refund` builders in money's `domain/money-events.ts`, kinds `adjustment`
  and `refund`, the console's words), both keeping the cost. Keys: `order:<id>:hold`, `order:<id>:settle` (a second completion after
  a reopen is `order:<id>:settle:2`, and so on), `order:<id>:release`, `order:<id>:refund` (B2C), and `reverse:<settlement id>` for a
  reopen or a B2B refund: decision 024's key (the brief's
  `order:<id>:refund` for the B2B refund is replaced by it). The settlement to reverse is found by
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
  input, the rest the code; a line ends at CRLF, CR, LF, U+2028 or U+2029, so reading a line takes time in proportion to its length,
  decision 051; whitespace-insensitive, non-empty inputs only, index `orders_imei_squashed_idx`) and refuses a paste of
  more than 500 lines. A line is `matched` only when exactly one order with its input is open and no order with that input but
  another buyer (merchant or storefront customer) or another service is open or was cancelled or rejected in the last 7 days
  (`RECENT_REJECTION_DAYS`); otherwise it is `ambiguous` and staff reply on the order itself. A matched line names the merchant or
  customer and the service of its order (`client`, `customer`, `service`). Apply runs each item as its own `reply` transaction and reports refusals in `failed`, plus one summary audit row
  for the request (so an apply where every item failed is still audited).
- **Export** (`application/order-export.service.ts`): counts first (more than 100,000 rows: `422`), writes one `audit_logs` row
  (staff), then streams the CSV in batches of 1,000 by keyset paging on `(sort value, id)`, so rows never repeat or get skipped while
  orders arrive. Cells that start with `=`, `+`, `-`, `@`, tab or CR are written as text. Only the first `_sort` key is used.
  `originCheck`: same-origin or a console `Origin` (decision 045).
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
keyed hash of the token (`orders.public_token_hash`, unique partial index, decision 054) and the stored hash is compared with the
presented token's in constant time; an order placed before decision 054 is found by its plain `public_token` until the seal pass ran. The
token is stored only as that hash and an AES-GCM copy (`public_token_enc`, AAD `orders.public_token_enc`), which the paid checkout view,
the balance-payment answer and the customer's order list reveal (`OrderReadService.trackingTokenOf`, `CapabilityTokenVault`). The one-off
pass `TrackingTokenSeal` (job `tracking_tokens_seal` on `maintenance`, `TrackingTokenSealModule`, worker only; asked for once by migration
`capability_tokens_seal`) seals the orders placed before. A merchant order has no token and can never be opened this way, and the order of
an anonymized customer opens nothing (the customers module answers through `TrackingCustomerPorts`, `application/tracking-customer-port.ts`). One
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
  result: {code, comment, fileId}, verificationStatus, inputFileId, canCancel, canVerify, createdAt, completedAt }`.
  Never cost, supplier, supplier reference, notes, queue, dispatch state, pricing snapshot or risk. `GET /client/orders/:id` adds
  `answers: [{key, label, value}]` (decision 065) and `events: [{id, type, message, createdAt}]`, only the types `created`, `hold`, `accepted`, `completed`, `rejected`, `release`,
  `refund`, `reopened` and `verification` (never a note, a supplier line or the settlement, which shows the cost).
- `POST /client/orders` (`201 { orders: [order] }`): body `{ serviceId, imei? | imeis? (1-100), quantity?, inputs?, fileId? }`.
  An IMEI service's main input goes under its main-input field's key in `inputs` (decision 070), or as `imei` (older pages; it is that
  field's value and wins, decision 073). `imeis` places one order per item of the same service, **all or none** in one transaction (the first refusal, including
  `INSUFFICIENT_FUNDS` or a duplicate inside the list, undoes the request); it stays accepted, but the shop no longer sends it. Problems are
  named by field: `imei`, `imeis.2`, `quantity`, `inputs.<key>` (also every problem of a value typed into the main-input field), `fileId`. Optional header `Idempotency-Key` (feature 24B, scope
  `portal`, migration 0020): the same key and body sends the first `201` again with `idempotency-replayed: true` and places nothing;
  another body is `409 IDEMPOTENCY_KEY_REUSED`, one still running `409 IDEMPOTENCY_IN_PROGRESS`; a refusal
  stores nothing; the answer is kept 7 days. The key is not written to `orders.idempotency_key` (a bulk makes several orders). The
  orders are read back inside the placement's transaction so the answer is stored with them.
- `GET /client/orders`: filters `status` (and `status_ne`), `type`, `serviceId`, `createdAt_gte`/`createdAt_lte`; `q` over the input,
  the service name and the id; sorts `createdAt` (default, newest first), `totalPrice`, `status`. Another merchant's order is `404`.
- `POST /client/orders/:id/cancel` (`204`): only while the order was never sent (`pending`, `manual`, `held`) and the service has
  `allow_cancel`: rejected as "Cancelled by the merchant", the hold released. `ALREADY_SENT` once the order was sent to a supplier at
  least once (while being sent, sent, or sent and then failed or queued again: staff cancel such an order); `INVALID_TRANSITION` when
  the service forbids it or staff already work on the order.
- `POST /client/orders/:id/verify` (`204`): a completed order, once, when the service has `allow_verify` and inside
  `verify_window_h` hours of completion (0 hours means no window); `INVALID_TRANSITION` otherwise.
- `GET /client/orders/export`: CSV `id,created,service,input,quantity,status,price,currency`, same filters; 100,000 rows at most.
- `GET /client/files/:id` and `GET /admin/files/:id` (platform module, B154): `302` to a presigned link that lives 5 minutes.
- **Idempotency** (`application/idempotency-store.ts`, `infra/idempotency.repository.ts`, table `idempotency_keys`, migration 0009):
  `Idempotency-Key` (1 to 255 printable characters) on `POST /client/orders`. Inside the placement's transaction the
  key is locked without waiting (`pg_try_advisory_xact_lock` on merchant and key: a second request that arrives while the first runs is
  `409 IDEMPOTENCY_IN_PROGRESS`, `Retry-After: 1`), the stored answer is read, and when there is none the placement runs and its status
  and body are inserted before the commit, so the orders and the answer exist together or not at all. The same key with the same
  scope and request hash (keyed hash of the canonical body: key order does not matter) replays the stored status and body with
  `Idempotency-Replayed: true` and posts nothing (not even when the wallet is empty or the service is off by then); another body is
  `409 IDEMPOTENCY_KEY_REUSED`. A refusal stores nothing, so the key may be tried again. Keys are per merchant and are
  remembered for 7 days (`domain/idempotency-window.ts`, B166, P4a): the answer's `created_at` is the clock's time, and the daily job
  `idempotency_purge` (`jobs/`, 04:10 UTC, see "Jobs and schedules") deletes the answers older than the window, so the key is free
  again (a new order, not a replay). The window is exact: when `IdempotencyStore.run` finds a stored answer older than the window
  (`idempotencyCutoff`, the same strict `<` as the job) it deletes that row in the same transaction, then carries on as a first request,
  whatever the new body is. So an old key never replays, or answers `409 IDEMPOTENCY_KEY_REUSED`, between the window and the next 04:10
  run; the job is only the cleanup of keys nobody sends again. A row stored with the scope `order` or `bulk` came from the retired REST
  API v1: it stays valid in the table's check, and a portal request with its key is `409 IDEMPOTENCY_KEY_REUSED`.
- **Dhru** (`application/dhru-orders.ts`, `controllers/dhru.controller.ts`, `contracts/dhru.contracts.ts`, decision 026):
  `POST /api/index.php` is the one transport route (access `dhru-credentials`: `username` + `apiaccesskey`; form,
  multipart or JSON). It reads `action` and the base64 `parameters` and asks the shared `DhruGateway` (`src/common/dhru`), which runs
  the handler the owning module bound to the action and answers `{ SUCCESS: [...], apiversion }` or `{ ERROR: [{ MESSAGE }], apiversion }`
  (HTTP 200 always; the error formatter words each refusal: `Authentication Failed`, `Invalid Action`, `Not enough credits`,
  `Price changed. Please refresh the service list and order again.`). This module owns `placeimeiorder` (`{ MESSAGE: 'Order received',
  REFERENCEID }`, our order id as text), `placeimeiorderbulk` (one entry per caller request id, items placed one after the other, each
  in its own transaction), `getimeiorder` and `getimeiorderbulk` (`STATUS` 0 new, 1 in process, 3 rejected, 4 completed, `CODE` the result
  or reason, `""` while it runs; another merchant's order is `Order not found`), `placefileorder` (`FILENAME` + base64 `FILEDATA`, or a file
  part of a multipart call; stored through platform's `FileUploadService`; when the order is then refused or rolled back (changed price,
  not enough credits, a duplicate) the stored object and its `files` row are removed again by `FileUploadService.discard`, which keeps any
  file something still points at (B166, P4a; platform README "File uploads"); an IMEI service in `placefileorder` and a File service in
  `placeimeiorder` are refused naming the right action; the form body of this route may be up to the multipart size, 25 MiB plus the form
  fields (`src/common/route-body-limits.ts`), about 13 MiB of file as `FILEDATA` because the file is base64 inside the base64 `parameters`;
  a larger file, up to 25 MiB, goes as a multipart file part; every other route and the JSON body of this one keep 1 MiB) and `getfileorder` (adds `FILEID` when staff attached a result file). Dhru has
  no idempotency field: a repeated placement is stopped by the duplicate rule. Money's `accountinfo` and catalog's `imeiservicelist` are
  bound to the same gateway by their modules.
- **A refused file order and its file (B166, P4a).** Only the Dhru `placefileorder` discards its file, because it carries the file inside the
  request: the upload is stored first and the caller never learns its id, so nobody could reuse it. A portal
  (`POST /client/orders`) file order needs no cleanup on a refusal: it points at a file the merchant uploaded separately
  (`POST /client/files`) and sent as `fileId`. The refusal leaves that file in place on purpose, so the merchant can fix the cause (price,
  funds) and retry with the same `fileId`; removing it would break the retry.
- A multipart placement during maintenance is refused by the pipeline too: `registerMultipartBodies` (`src/common/multipart.ts`) parses
  the three multipart routes before the guards, so the maintenance stage sees the Dhru `action`.

Open point: none for the merchant's cancel and verify any more: staff set `allowCancel`, `allowVerify` and `verifyWindowH` (0 to 720
hours, 0 = no window) through `POST|PATCH /admin/services` (feature 7a, catalog module); they start off.

- **Storefront payments and refunds (feature 16).** `CustomerOrderPlacement` (`application/customer-placement.ts`) is `OrderPlacement`'s counterpart for a customer, called by the capture of a paid checkout: no wallet hold, the net, VAT and rate come from the session, `customer_id`, `checkout_session_id`
  and a 22-character `public_token` are set instead of a merchant, a `paid` line follows `created`, an automatic service is queued for dispatch, a manual one waits in the manual queue, and codes in stock of a service delivered from code stock are delivered at once (claim, sell and `b2c_deliver`; decision 069). The risk hold of feature 18 plugs in at `placementDispatchState({ held })`.
  The state machine has one more action, `refundApproved` (an open storefront order in any queue, held or reopened included, becomes `rejected`, money `b2c_refund`), used when staff approve a refund of an order that was not delivered. `OrderLedger` posts the `b2c_refund` move through the money module's `B2cRefunds`
  (what is left on the payment and its VAT share, a `processing` refund row and its gateway job, or the approved refund's own journal when `refundId` is given); `StorefrontOrderPortImpl` fills money's port slot so the refund routes can cancel an order and add refund and dispute lines to the timeline without importing orders. A rejection the system decides (the actor is a supplier or the system) reads the storefront policy `autoRefundFailed` (`StorefrontPolicies`): off, `OrderLedger` asks `B2cRefunds` for `mode: 'request'`, which opens a refund request for staff and posts nothing, and the timeline says `Refund of $X is waiting for staff to approve`; a rejection a person decides always refunds. `OrderTransitions.apply` also writes the storefront customer's `order.completed` / `order.failed` email (money's `StorefrontMails`) in the transition's transaction. A staff reject that gives a storefront payment back also needs `refunds:approve`, checked through `TransitionRequest.authorize` after the machine's decision; the verification decision `refund` also needs `orders:reopen` (decision 046). Decision 048: when the payment is disputed or charged back with the card network, a rejection (staff or supplier) and a risk refund open a refund request instead (`MoveOutcome.disputed`), no mail is sent, and the timeline says `Refund of $X is waiting for staff: the buyer disputed this payment with the card network, so nothing was sent back` (a risk refund's line `Risk review: refund waits for staff`). One order per checkout session is a database rule: the unique index `orders_checkout_session_uq` (a full index, so it also serves the foreign key; NULLs stay distinct; migration `payments_integrity`, which first checks the data and names the sessions that break it).
  Feature 33 (decision 042): a checkout opened while its service took an IMEI and paid after the supplier sync made it a `server` service keeps the buyer's value: `carriedImeiInputs` (`domain/main-input.ts`) puts the IMEI under the first field (form order) flagged as the main input (decision 065; the dispatcher's rule too) when that field has no value, so `orders.imei` holds it and the dispatch sends it as `IMEI`. The merchant paths (portal, Dhru) place at once against the current type and refuse an IMEI for a non-IMEI service (`422`, `not_applicable` on the IMEI field), so nothing is lost there.
  `OrderReceiptService` serves `GET /store/v1/orders/:token/receipt`: the paid tax receipt invoice of the order as a PDF (`PdfRenderer`, decision 030), drawn once by the `receipt.render` job the capture queues, stored, and served as those stored bytes every time (the money module's `OrderReceipts`; a missing copy is made by the first download; `404` for an unknown token or an order with no receipt).

### Staff reads and the export (decision 047)

`GET /admin/orders` and `GET /admin/orders/:id` show an account's address masked (`ja•••@example.com`) unless the caller holds `clients:read`
(`toStaffOrder(row, extras, contact)`; identity's `customerContactOf` decides it and the controller passes it down). `GET /admin/orders/export` also needs `reports:read`
(`ORDER_EXPORT_PERMISSION`, checked first in `OrderExportService.forStaff(caller, query)`: a refused export counts nothing and writes no audit row): the file holds buyers,
inputs and costs of up to 100,000 orders, and the reports permission already shows costs and profit.

## Public API (`index.ts`)

Exports `OrdersModule` (with `OrdersOutboxModule`, which the worker loads, and `OrdersAdminModule`, the routes and use cases), the pure
rules (`decideOrderAction`, `deriveQueue`, `isOpen`, `placementDispatchState`, `orderStateOf`, `wireDispatchState`, `WIRE_DISPATCH_STATES`, `mainInputOf`), the SQL fragments (`pastSlaPredicate`,
`queueSql`, `channelSql`), the door helpers `isPrepaidOrder` and `prepaidOrderSql`, the seam `ShopOrders` with the types `ShopOrderPage` and `ShopOrderRow`, the services other features call (`OrderPlacement` for Dhru (7a) and the storefront; `OrderTransitions`
for the risk actions, with `refusalError`, `SEND_IN_PROGRESS_DETAIL` and `CHANGED_FIRST_DETAIL`; `OrderSupplierMoves`, the door of the supplier flows (its claim, its guarded moves, `recordLateAcceptance`, `paymentStop` with `PAYMENT_STOP_REASONS` and the type `PaymentStop`, and the readers of the dispatch sweep, with the types `UnansweredClaim`, `UnclaimedOrder` and `LateAcceptance`), and `OrdersEngineModule`, which provides both without routes for
the worker; `OrderReadService`), the outbox event names (`ORDER_OUTBOX_EVENTS`, `OrderOutbox`) and the
vocabularies and row types of the two tables. Other modules import only `src/modules/orders/index.ts` (lint rule
`gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 2 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `orders` | Orders; id equals REFERENCEID. `account_id` names the buyer of every order (decision 064); `source` is the door (`store` for the shop). `client_id` is still written for hold-and-settle orders and is null for the shop's door; `customer_id` is retired and unwritten. |
| `order_events` | The order timeline; append only. |

## Routes

33 endpoints (admin 17, client 7, store 3, dhru 6); the six `/v1/orders` rows and the `EVENT order.status_changed` row of the map are retired (see `test/contract/retired.ts`). Source: `docs/slices/orders.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built. **Built by feature 5:** the 13 admin routes with stage 5 and the 7 `/client` routes (contracts in `contracts/orders.contracts.ts`, `order-actions.contracts.ts`, `client-orders.contracts.ts`; controllers in `controllers/`). The rows with stage 6, 7, 11, 14 and 16 are built by those features.

### Admin console (17)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/orders` | staff-permission · `orders:read` | Orders and their queues (pending, manual, needs_attention, verification, review); filter by channel=b2b\|b2c (told by the door) and by `accountId` or `rankId`. | 5 |
| `GET /admin/orders/:id` | staff-permission · `orders:read` | Orders and their queues (pending, manual, needs_attention, verification, review); filter by channel=b2b\|b2c. | 5 |
| `GET /admin/orders/:id/events` | staff-permission · `orders:read` | The full order timeline. | 5 |
| `GET /admin/orders/export` | staff-permission · `orders:read` | Export a CSV file according to the filters. | 5 |
| `GET /admin/reports/top-clients` | staff-permission · `reports:read` | Top accounts by volume and by profit, every rank, by door (the money module's report). | 11 |
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

### Dhru Fusion API (6)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DHRU getfileorder` | dhru-credentials | Result of a File order (optional). | 7 |
| `DHRU getimeiorder` | dhru-credentials | Order status and result. | 7 |
| `DHRU getimeiorderbulk` | dhru-credentials | Status of several orders. | 7 |
| `DHRU placefileorder` | dhru-credentials | Place a File service order (optional, for older clients). | 7 |
| `DHRU placeimeiorder` | dhru-credentials | Place an IMEI or Server order and hold the balance. | 7 |
| `DHRU placeimeiorderbulk` | dhru-credentials | Place several orders in one request. | 7 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

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

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (ids and status words only, written in the transition's own transaction):

| Type | Queue | Payload | Written when | Consumer |
|---|---|---|---|---|
| `order.status_changed` | `notifications` | `{ orderId, accountId, source, fromStatus, toStatus }` (decision 064; older queued rows carry `clientId`) | the status of an order changed (accept, reply, reject, cancel, reopen, refund, a verification refund) | the order result notifications of feature 12a (`EventNotifier`; the platform registers the route) |
| `order.dispatch_requested` | `supplier-dispatch` | `{ orderId }` | placement of an automatic order with an active supplier link; a staff `dispatch` and a `change-supplier` with `dispatch: true` (feature 6) | the dispatch job of feature 6 (`SupplierDispatchProcessor`) |

Feature 5 registers the route of `order.dispatch_requested` (`OrderOutbox.onModuleInit`, loaded by the API and the worker) and adds no processor
for either queue: the notifications module routes and plans `order.status_changed`, and 6 built the dispatch job. The creation of an order is not a status change and writes no `order.status_changed`.
A dispatch row for an order that is rejected or completed before the job runs is harmless: the job re-reads the order and moves it
only through the guarded transition (decision 025). Consumed: none.

## Jobs and schedules

`idempotency_purge` (P4a, `jobs/idempotency-purge*.ts`, `IdempotencyPurgeModule`, worker only): daily at 04:10 UTC on the `maintenance` queue,
recorded in `job_runs`; it forgets the portal's Idempotency-Keys older than 7 days (deletes the stored answers,
1000 rows per statement). The dispatch job (`supplier-dispatch`) and the poll jobs (`supplier-poll`) are feature 6 (suppliers module). See `docs/queues.md`.

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
`orders-bulk-reply`, `orders-export`, `orders-client-stats`, `orders-seed`, `files`, and (7a) `dhru-surface`,
`client-orders-idempotency`, `files-upload`, and (P4a) `idempotency-purge`, `file-order-cleanup`, `dhru-file-body`. The Dhru fixtures (one request/response record per action, checked on keys and types):
`test/dhru/`. Scenarios `success`, `reject`, `timeout` and `manual` (`test/e2e/`) include the merchant's Dhru calls
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
