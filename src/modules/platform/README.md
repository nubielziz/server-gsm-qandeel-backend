# Platform module (`platform`)

Map domain G. Cross-cutting services: system settings, the audit log, files, notification templates and notifications, merchant webhook endpoints and deliveries, and the transactional outbox. It also serves the API documentation built from the route contracts: `GET /openapi.json`, `GET /docs`, `GET /reference` (decision 017).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 004 file storage, 017 API documentation, 020 outbox and queues. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: `GET /openapi.json` and `GET /docs` (the public documentation), plus the internal `GET /reference` and `GET /reference/openapi.json` (no contracts: they are documentation routes, gated by `REFERENCE_DOCS`). Code: `docs/`.

## Public API (`index.ts`)

Exports `PlatformModule`, the document builders and `OpenApiService` (used by `src/app.bootstrap.ts` and `scripts/gen-openapi.ts`), `DOCUMENTATION_ROUTES` (for the route-parity test) and the `REFERENCE_DOCS_GUARD` token (see below).

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

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").

## Docs gate hand-over (P2.5)

`REFERENCE_DOCS=staff` asks the provider under the `REFERENCE_DOCS_GUARD` token (`docs/reference-access.guard.ts`). Until one is provided, `staff` behaves like `off` (404). P2.5 supplies a guard that requires a staff session with `system:read`: provide `{ provide: REFERENCE_DOCS_GUARD, useExisting: <guard> }` from `PlatformModule` (after importing the module that exports the guard). `test/integration/docs.test.ts` shows the wiring with a test guard.
