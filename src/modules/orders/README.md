# Orders module (`orders`)

Map domain D. One order engine for B2B merchants and B2C storefront customers: placement and balance hold, the status state machine (decision 025), order events and the admin and merchant order actions.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 024 ledger, 025 order state machine, 026 Dhru compatibility. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Not built yet: the module is an empty shell (`orders.module.ts`, `index.ts`). Its feature adds controllers, services, repositories and the owned tables.

## Public API (`index.ts`)

Exports `OrdersModule` only. Add the services other modules may call here, and nothing else: other modules import only `src/modules/orders/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 2 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `orders` | Orders; id equals REFERENCEID. client_id accepts null for storefront (B2C) orders, which fill customer_id instead; exactly one of the two is set. |
| `order_events` | The order timeline; append only. |

## Routes

40 endpoints (admin 17, client 7, store 3, v1 6, dhru 6, events 1). Source: `docs/slices/orders.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (17)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/orders` | staff-permission · `orders:read` | Orders and their queues (pending, manual, needs_attention, verification, review); filter by channel=b2b\|b2c. | 5 |
| `GET /admin/orders/:id` | staff-permission · `orders:read` | Orders and their queues (pending, manual, needs_attention, verification, review); filter by channel=b2b\|b2c. | 5 |
| `GET /admin/orders/:id/events` | staff-permission · `orders:read` | The full order timeline. | 5 |
| `GET /admin/orders/export` | staff-permission · `orders:read` | Export a CSV file according to the filters. | 5 |
| `GET /admin/reports/top-clients` | staff-permission · `reports:read` | Top merchants by volume and by profit. | 11 |
| `POST /admin/orders/:id/accept` | staff-permission · `orders:update` | Accept a manual order and move it to processing. | 5 |
| `POST /admin/orders/:id/change-supplier` | staff-permission · `orders:update` | Change the supplier or reset the reference. | 6 |
| `POST /admin/orders/:id/dispatch` | staff-permission · `orders:update` | Manually send the order to the supplier (force send). | 6 |
| `POST /admin/orders/:id/fetch` | staff-permission · `orders:update` | Fetch the result now (force get). | 6 |
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

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

Outgoing webhook events from the map (documented as OpenAPI `webhooks` once defined with `defineEvent`): `order.status_changed`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").
