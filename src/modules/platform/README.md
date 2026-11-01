# Platform module (`platform`)

Map domain G. Cross-cutting services: system settings, the audit log, files, notification templates and notifications, merchant webhook endpoints and deliveries, and the transactional outbox. It also serves the API documentation built from the route contracts: `GET /openapi.json`, `GET /docs`, `GET /reference` (decision 017).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 004 file storage, 017 API documentation, 020 outbox and queues. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: `GET /openapi.json` and `GET /docs` (the public documentation), plus the internal `GET /reference` and `GET /reference/openapi.json` (no contracts: they are documentation routes, gated by `REFERENCE_DOCS`). Code: `docs/`. The transactional outbox (`outbox_events`): writing events and the worker's relay. Code: `outbox/`. The audit log (`audit_logs`): `AuditService.record` and the check that staff writes are audited. Code: `audit/`. Cached read access to `settings` for other modules. Code: `settings/`.

## Public API (`index.ts`)

Exports `PlatformModule`, the document builders and `OpenApiService` (used by `src/app.bootstrap.ts` and `scripts/gen-openapi.ts`), `DOCUMENTATION_ROUTES` (for the route-parity test) and the `REFERENCE_DOCS_GUARD` token (see below).

The audit log: `AuditModule` (global) provides `AuditService.record(tx, { action, entityType, entityId?, entityLabel?, before?, after? })` (see "Audit log" below). The settings: `SettingsModule` (global) provides `SettingsReader` (`all()`, `get(key)`, `integer(key, fallback, bounds)`, `integers(specs)`, `invalidate()`), the only way other modules read `settings`.

Settings and maintenance: `SettingsModule` (global) and `SettingsService.get(key, executor?)` (the raw JSON value of one setting, `undefined` when it was never set); `MaintenanceModule` with `MaintenanceService` (`state()`, `invalidate()`), the pure `maintenanceRefusal`, `scopesCovering`, `parseMaintenanceState`, `MAINTENANCE_KEY`, `MAINTENANCE_OFF`, `MAINTENANCE_SCOPES`, `DEFAULT_MAINTENANCE_MESSAGE` and the types `MaintenanceState`, `MaintenanceScope`, `MaintenanceRequest`.

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

## Settings and maintenance mode (`settings/`, `maintenance/`)

`SettingsService` is the only code outside the (future) settings routes that reads the `settings` table: other modules call it
(identity reads `adminAllowlistOnly`). The routes that write settings arrive with their features and call the `invalidate()` of
whatever cache holds a value after their commit. `PATCH /admin/settings` is an allow-list (lead resolution identity-platform-13):
it accepts only the keys of a settings registry in this module, each with its validator (today only `imeiRetentionDays`, a JSON
integer 0 to 3650, shared with `PATCH /admin/storefront/settings`); any other key, including the keys owned by stricter routes
(`adminAllowlistOnly`, `maintenance`, risk rules, storefront policies), is `422 VALIDATION_FAILED` with `errors[].field` = the key.
A feature that needs another key editable there adds it to the registry with its validator.

**Maintenance** (scenario `system-integrity`, `docs/contract/endpoints/health.md` `PUT /admin/system/maintenance`) is the settings
key `maintenance`, stored as the console's `MaintenanceState` (`enabled`, `scope`, `message`, `expectedEndAt`, `startedAt`,
`startedBy`). **Default: off** when the key was never set; a value that is not a well-formed state also counts as off, with a
warning in the log. The state is read through `MaintenanceService.state()`: memory for one second, then the cache Redis
(`gsm:{env}:platform:maintenance:state`, 60 s, stale value for up to 5 more minutes), then settings. The route that changes it
(system health feature, `system:manage`) calls `maintenance.invalidate()` after its commit; other instances follow within a second.
The stage is the second of the request pipeline (`src/common/pipeline/README.md`), after the IP rules and before the per-IP limit.

| Scope | `503 MAINTENANCE` for | Never |
|---|---|---|
| `store` | every request to `/store/v1/*` | |
| `checkout` | `POST /store/v1/checkout-sessions` (opening a checkout) and `POST /store/v1/checkout-sessions/:token/pay` (starting its payment): no session is created, nothing is held | the rest of the storefront |
| `api_orders` | order placement: `POST /v1/orders`, `POST /v1/orders/bulk`, and the Dhru actions `placeimeiorder`, `placeimeiorderbulk`, `placefileorder` | reads, cancels and verifies of running orders; Dhru `getimeiorder`, `getimeiorderbulk`, `accountinfo`, `imeiservicelist` |
| `all` | the union of the three | |

Never affected by any scope: `/admin/*` (staff are not locked out), `/client/*` (the merchant portal), `/webhooks/*` (a payment
already started must still be confirmed), `/health`, `/metrics`, `/docs`, `/openapi.json` and `/reference`.

- **The answer** is problem+json `503 MAINTENANCE` with the staff member's message as `detail` (a default sentence when there is
  none), the extension member `expectedEndAt` (an ISO time or `null`; it only informs, only switching maintenance off ends it)
  and `Retry-After` (seconds to the expected end, kept between 30 and 300; 60 when unknown). On `/api/index.php` the error goes
  through the formatter seam (`ErrorFormatterRegistry`, decision 026): the Dhru module registers the formatter that turns it into
  the `{ERROR: [{MESSAGE}], apiversion}` envelope; until it exists the Dhru route answers problem+json.
- **Dhru:** all actions share one path, so a Dhru order placement is decided in the pipeline's `preValidation` phase, once the
  body is parsed and the `action` field is known (`dhruActionOf`). A body the pipeline cannot read (multipart) is not refused
  there; the Dhru handlers can call `maintenanceRefusal(await maintenance.state(), { method, path, dhruAction })` themselves.
- **Failure policy:** if the state cannot be read at all, requests go through (maintenance is a courtesy to customers, not a
  security rule).

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

- `gsm:{env}:platform:settings:all` (`CacheKeys.settings()`): the whole `settings` table as one flat object, 60 s. The settings write routes (feature 2a) call `SettingsReader.invalidate()` inside `afterCommit`. Listed in `docs/cache-keys.md`.

| Key | What | TTL | Invalidation |
|---|---|---|---|
| `gsm:{env}:platform:maintenance:state` | the maintenance state | 60 s, then stale for 5 min while one refresh runs | `MaintenanceService.invalidate()` after the commit of a maintenance change |

Registered in `docs/cache-keys.md`. Register each further key family (owner, TTL, invalidation after commit) there too (see `CONTRIBUTING.md` → "Add a cache key").

Register every other key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").

## Audit log (decision 018)

Every admin write writes `audit_logs` inside the use case's transaction:

```ts
await this.db.runInTransaction(async ({ tx }) => {
  const before = await this.repository.find(tx, id);
  const after = await this.repository.update(tx, id, patch);
  await this.audit.record(tx, {
    action: 'Suspended staff member', // a readable English verb phrase, as the console shows it
    entityType: 'staff', // snake_case, from the console's fixed list
    entityId: id, // omit for an action without a numeric record (settings, a queue pause): stored as 0
    entityLabel: after.name, // a name snapshot, or the target when there is no id
    before, // secrets are redacted (passwordHash, *Enc, tokens, apiKey ...) before they are stored
    after,
  });
});
```

The actor (`actor_type`, `actor_id`) and the IP come from the request context the session guards filled in; outside a request the
actor is `system`. The row is written on the caller's transaction, so a rolled-back change leaves no row.

**Snapshots and vocabularies** (lead resolutions identity-platform-7 and -15, built with feature 2a):
- `audit_logs.actor_name` is a snapshot written by `AuditService.record` from `RequestActor.name` (the session guards fill it from
  the subject, the API-key and Dhru guards set `{type: 'client', id, name}`; `''` for `system`), the same way as `entity_label`, so
  renamed or deleted accounts still read correctly and `q` can search it in SQL. On the wire `actorName` is `null` when the snapshot
  is `''`. `actor_type` is `staff | client | customer | system` (exported `AUDIT_ACTOR_TYPES`, CHECK `audit_logs_actor_type_check`).
- `entityType` must come from the exported `AUDIT_ENTITY_TYPES` (the console's 19 words plus `role`, `client_group`, `category`,
  `currency`, `payment_gateway`, `invoice`, `api_key`, `webhook_endpoint`, `kyc_submission`, `notification_template`,
  `alert_rule`, `alert`, `incident`, `tax_rate`, `help_article`, `content_page`, `ledger_transaction`); `record` throws a
  `RangeError` (a programming error that rolls the transaction back) on any other value. The list is enforced in code with no
  DB CHECK, so the append-only table never needs a migration for it; a feature that needs a new type adds it in its own commit.
  Table to word: `clients` is `merchant`, `staff_users` `staff`, `checkout_sessions` `checkout`, `legal_documents` `legal`,
  blocklist entries `blocklist`, `settings` `setting`, `commission_plans` `plan`, `withdrawal_requests` `withdrawal`,
  `support_tickets` `ticket`.

**Enforcement.** A global interceptor (`AuditEnforcementInterceptor`) checks every successful staff mutation (a staff-authenticated
route whose method is not GET and whose contract does not say `audit: false`): if the request wrote no audit row, development and
tests answer `500` with a message that names the route, and production logs an error (the change is already committed). A sign-in
step opts out with `audit: false` and says why in the contract description.

## Docs gate

`REFERENCE_DOCS=staff` asks the provider under the `REFERENCE_DOCS_GUARD` token (`docs/reference-access.guard.ts`). The identity module
provides it (`StaffSystemReadGuard`: a staff session with `system:read`; `401` without a session, `403 FORBIDDEN` without the
permission). Without any provider `staff` behaves like `off` (404). The reference routes have no contract, so the guard dispatcher
lets them through to this guard (`DOCUMENTATION_ROUTES`). `test/integration/docs.test.ts` shows both.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-10` · GET /admin/reports/funnel
- `identity-platform-7` · GET /admin/audit-logs
- `identity-platform-8` · GET /admin/dashboard
- `identity-platform-9` · GET /admin/dashboard
- `identity-platform-10` · GET /admin/dashboard
- `identity-platform-11` · GET /admin/notification-templates
- `identity-platform-12` · GET /admin/webhook-deliveries
- `identity-platform-13` · PATCH /admin/settings
- `identity-platform-15` · GET /admin/audit-logs
- `identity-platform-16` · POST /client/* , /v1/files, /webhooks/telegram/:secret
