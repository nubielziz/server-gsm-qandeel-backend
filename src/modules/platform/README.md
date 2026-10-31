# Platform module (`platform`)

Map domain G. Cross-cutting services: system settings, the audit log, files, notification templates and notifications, merchant webhook endpoints and deliveries, and the transactional outbox. It also serves the API documentation built from the route contracts: `GET /openapi.json`, `GET /docs`, `GET /reference` (decision 017).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 004 file storage, 017 API documentation, 020 outbox and queues. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: `GET /openapi.json` and `GET /docs` (the public documentation), plus the internal `GET /reference` and `GET /reference/openapi.json` (no contracts: they are documentation routes, gated by `REFERENCE_DOCS`). Code: `docs/`. The transactional outbox (`outbox_events`): writing events and the worker's relay. Code: `outbox/`.

## Public API (`index.ts`)

Exports `PlatformModule`, the document builders and `OpenApiService` (used by `src/app.bootstrap.ts` and `scripts/gen-openapi.ts`), `DOCUMENTATION_ROUTES` (for the route-parity test) and the `REFERENCE_DOCS_GUARD` token (see below).

The outbox: `OutboxModule` (global: `OutboxService`, `OutboxRouteRegistry`), `OutboxService.add(tx, event)` and `backlog(db)`, `OutboxRouteRegistry.register({ type, queue, jobName? })`, the types `OutboxEventInput`, `OutboxPayload`, `OutboxJobData`, `OutboxRoute`, `OutboxBacklog`, and, for the worker only, `OutboxRelayModule` with `OutboxRelay`.

## Owned tables

Only this module reads and writes these 8 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `settings` | System settings as key and value pairs. |
| `notification_templates` | Email and Telegram templates for staff, merchants and customers. |
| `notifications` | A log of the notifications that were sent. |
| `webhook_endpoints` | Webhook URLs registered by merchants. |
| `webhook_deliveries` | Attempts to deliver webhooks. |
| `outbox_events` | Events waiting to be processed by the worker. |
| `audit_logs` | The audit log of admin actions. |
| `files` | S3 files and their metadata. |

## Routes

33 endpoints (admin 17, client 11, v1 2, hooks 1, system 2). Source: `docs/slices/platform.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (17)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/notification-templates/:id` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `GET /admin/audit-logs` | staff-permission · `audit:read` | Audit log. | 2 |
| `GET /admin/audit-logs/:id` | staff-permission · `audit:read` | Audit log. | 2 |
| `GET /admin/dashboard` | staff-permission · `dashboard:read` | KPIs for today: sales, profit, queues and supplier balances; scope=all\|b2b\|b2c separates merchants from the storefront. | 9 |
| `GET /admin/files/:id` | staff-permission · `files:read` | Download a file through a signed link. | 5 |
| `GET /admin/notification-templates` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `GET /admin/notification-templates/:id` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `GET /admin/notifications` | staff-permission · `notifications:read` | Log of sent notifications. | 12 |
| `GET /admin/notifications/:id` | staff-permission · `notifications:read` | Log of sent notifications. | 12 |
| `GET /admin/settings` | staff-permission · `settings:read` | System settings. | 2 |
| `GET /admin/webhook-deliveries` | staff-permission · `webhooks:read` | Log of merchant webhooks. | 7 |
| `GET /admin/webhook-deliveries/:id` | staff-permission · `webhooks:read` | Log of merchant webhooks. | 7 |
| `PATCH /admin/notification-templates/:id` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `PATCH /admin/settings` | staff-permission · `settings:update` | Edit the settings. | 2 |
| `POST /admin/notification-templates` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `POST /admin/notification-templates/:id/preview` | staff-permission · `notifications:read` | Preview the template with sample data. | 12 |
| `POST /admin/webhook-deliveries/:id/retry` | staff-permission · `webhooks:update` | Resend the delivery. | 7 |

### Merchant portal (11)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /client/webhooks/:id` | merchant-session | Delete an endpoint. | 7 |
| `GET /client/files/:id` | merchant-session | Download a file through a signed URL. | 5 |
| `GET /client/notification-preferences` | merchant-session | Notification preferences. | 12 |
| `GET /client/webhooks` | merchant-session | Webhook endpoints. | 7 |
| `GET /client/webhooks/:id/deliveries` | merchant-session | Delivery log and attempts. | 7 |
| `PATCH /client/webhooks/:id` | merchant-session | Edit or pause an endpoint. | 7 |
| `POST /client/files` | merchant-session | Upload a file for a File service order. | 5 |
| `POST /client/telegram/link` | merchant-session | One-time link to connect Telegram. | 12 |
| `POST /client/webhooks` | merchant-session | New webhook endpoint with its events; returns the signing secret. | 7 |
| `POST /client/webhooks/:id/test` | merchant-session | Send a test event. | 7 |
| `PUT /client/notification-preferences` | merchant-session | Save the preferences per event and channel. | 12 |

### REST API v1 (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /v1/files/:id` | api-key · `orders:read` | Download the result file through a signed URL. | 7 |
| `POST /v1/files` | api-key · `orders:write` | Upload a file for File services; returns a fileId. | 7 |

### Incoming webhooks (1)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `POST /webhooks/telegram/:secret` | url-secret | Telegram bot updates: account linking and commands. | 12 |

### System (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /docs` | public | REST v1 documentation page. | 7 |
| `GET /openapi.json` | public | REST v1 specification (OpenAPI). | 7 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `success`: Order completed by the supplier (tables: `notifications`, `outbox_events`, `webhook_deliveries`)
- `reject`: Supplier rejects the order (tables: `outbox_events`, `webhook_deliveries`)
- `manual`: Manual fulfilment by staff (tables: `audit_logs`, `outbox_events`, `webhook_deliveries`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `notifications`, `outbox_events`)
- `b2c-paid`: Paid storefront order (tables: `notifications`, `outbox_events`)
- `b2c-refund`: Refund before delivery (tables: `audit_logs`, `notifications`, `outbox_events`)
- `b2c-chargeback`: Chargeback dispute that we lose (tables: `audit_logs`, `files`, `notifications`, `outbox_events`)
- `b2c-ticket`: Support ticket about a delay (tables: `audit_logs`, `notifications`, `outbox_events`)
- `b2c-account`: Managing a storefront customer account (tables: `audit_logs`, `notifications`)
- `admin-team`: Adding and suspending a staff member (tables: `audit_logs`, `notifications`)
- `ip-rules`: IP block list and allowlist (tables: `audit_logs`, `settings`)
- `system-alert`: Alert and incident: a supplier slows down (tables: `audit_logs`, `notifications`, `settings`)
- `system-integrity`: Ledger mismatch and maintenance mode (tables: `audit_logs`, `notifications`, `settings`)

## Permissions

Staff permissions the map requires on this module's admin routes: `audit:read`, `dashboard:read`, `files:read`, `notifications:*`, `notifications:read`, `settings:read`, `settings:update`, `webhooks:read`, `webhooks:update`.

API key scopes on its REST v1 routes: `orders:read`, `orders:write`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet. A module registers an event type with its queue in `onModuleInit`
(`OutboxRouteRegistry.register`) and writes it with `OutboxService.add(tx, ...)` inside its transaction; the table of event
types is in `docs/queues.md` ("Outbox event types"). Consumed: none yet. The map's outgoing events (`order.status_changed`,
`wallet.low_balance`, `invoice.paid`) are registered by the features that produce them.

### The outbox (`outbox/`)

- **Write** (API and worker): `OutboxService.add(tx, { type, aggregateType, aggregateId, payload })` inserts the
  `outbox_events` row and sends `pg_notify('outbox', id)` on the caller's transaction, so the row and the wake-up exist if and
  only if the change commits. The payload is checked (`outbox-payload.ts`): a flat object of whole numbers, strings up to
  64 characters, flags and short lists; no decimals (no money), no nesting, no free text, at most 2 KB. It is stored with
  `meta.requestId` (the current request id, decision 012). An event type that no module registered is refused.
- **Relay** (worker only, `OutboxRelayModule`): `OutboxRelay.run()` selects the pending rows `ORDER BY id LIMIT 100 FOR
  UPDATE SKIP LOCKED`, adds one job per row to the queue of its type with the job id `outbox-<id>` and the data
  `OutboxJobData`, sets `processed_at` and counts the attempt in the same transaction, and repeats while batches are full.
  It runs on a one-second BullMQ tick (`outbox-relay-tick`, the safety net) and on a Postgres `NOTIFY outbox` wake-up
  (`OutboxListener`: one dedicated `pg.Client` named `gsm-outbox-listener`, reconnects with a growing wait, catches up after
  every reconnect, closed in `onModuleDestroy`). Calls that arrive during a run share it and make it look once more.
- **Failures.** Queue Redis down: the pass stops, every row stays pending and no attempt is counted (the tick retries). A
  row that cannot be handed over for its own reason (no queue registered for its type, BullMQ refuses the job): the
  attempt is counted and the row waits 2^attempts seconds (at most 5 minutes). Rows are never dropped; a stuck row shows in
  the backlog (`OutboxService.backlog`, metrics `outbox_pending_events`, `outbox_oldest_pending_age_seconds`).
- **Not here yet:** deleting processed rows (data retention, a maintenance job of a later feature).
- **Metrics** (worker `/metrics`): `outbox_events_relayed_total{queue}`, `outbox_relay_lag_seconds`,
  `outbox_relay_failures_total{reason}`, `outbox_pending_events`, `outbox_oldest_pending_age_seconds`.

## Jobs and schedules

The relay tick: `outbox-relay-tick`, every second, queue `outbox-relay`, job `tick` (processor `OutboxRelayProcessor`). Listed
in `docs/queues.md`. Other jobs of this module (notifications, webhook deliveries, file jobs) arrive with their features.

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").

## Docs gate hand-over (P2.5)

`REFERENCE_DOCS=staff` asks the provider under the `REFERENCE_DOCS_GUARD` token (`docs/reference-access.guard.ts`). Until one is provided, `staff` behaves like `off` (404). P2.5 supplies a guard that requires a staff session with `system:read`: provide `{ provide: REFERENCE_DOCS_GUARD, useExisting: <guard> }` from `PlatformModule` (after importing the module that exports the guard). `test/integration/docs.test.ts` shows the wiring with a test guard.
