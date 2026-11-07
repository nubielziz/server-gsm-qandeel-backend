# Platform module (`platform`)

Map domain G. Cross-cutting services: system settings, the audit log, files, notification templates and notifications, merchant webhook endpoints and deliveries, and the transactional outbox. It also serves the API documentation built from the route contracts: `GET /openapi.json`, `GET /docs`, `GET /reference` (decision 017).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 004 file storage, 017 API documentation, 020 outbox and queues. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: `GET /openapi.json` and `GET /docs` (the public documentation), plus the internal `GET /reference` and `GET /reference/openapi.json` (no contracts: they are documentation routes, gated by `REFERENCE_DOCS`). Code: `docs/`. The transactional outbox (`outbox_events`): writing events and the worker's relay. Code: `outbox/`. The audit log (`audit_logs`): `AuditService.record` and the check that staff writes are audited. Code: `audit/`. Cached read access to `settings` for other modules. Code: `settings/`. Feature 7b built the merchant webhooks (9 routes, 4 events, the delivery engine): see "Merchant webhooks (feature 7b)" below. Feature 2a built the four admin routes of the audit log and the settings (`GET /admin/audit-logs[/:id]`, `GET` and `PATCH /admin/settings`): see "Audit log and settings routes (feature 2a)" below. Code: `contracts/`, `controllers/`, `application/`, `infra/`, wired by `PlatformAdminModule`.

## Public API (`index.ts`)

Exports `PlatformModule`, the document builders and `OpenApiService` (used by `src/app.bootstrap.ts` and `scripts/gen-openapi.ts`), `DOCUMENTATION_ROUTES` (for the route-parity test) and the `REFERENCE_DOCS_GUARD` token (see below).

The audit log: `AuditModule` (global) provides `AuditService.record(tx, { action, entityType, entityId?, entityLabel?, before?, after? })` (see "Audit log" below). The settings: `SettingsModule` (global) provides `SettingsReader` (`all()`, `get(key)`, `integer(key, fallback, bounds)`, `integers(specs)`, `invalidate()`), the only way other modules read `settings`.

Settings and maintenance: `SettingsModule` (global) and `SettingsService.get(key, executor?)` (the raw JSON value of one setting, `undefined` when it was never set); `MaintenanceModule` with `MaintenanceService` (`state()`, `invalidate()`), the pure `maintenanceRefusal`, `scopesCovering`, `parseMaintenanceState`, `MAINTENANCE_KEY`, `MAINTENANCE_OFF`, `MAINTENANCE_SCOPES`, `DEFAULT_MAINTENANCE_MESSAGE` and the types `MaintenanceState`, `MaintenanceScope`, `MaintenanceRequest`.

The outbox: `OutboxModule` (global: `OutboxService`, `OutboxRouteRegistry`), `OutboxService.add(tx, event)` and `backlog(db)`, `OutboxRouteRegistry.register({ type, queue, jobName? })`, the types `OutboxEventInput`, `OutboxPayload`, `OutboxJobData`, `OutboxRoute`, `OutboxBacklog`, and, for the worker only, `OutboxRelayModule` with `OutboxRelay`.

Documents and stored files (feature 8): `PdfModule` (global) provides `PdfRenderer.render(document)` (`PdfDocument`, `PdfBlock`, `PdfColumn`), and `StoredFiles` (`store`, `metaOf`, `findOwned`, with `StoreFileInput`, `FileMeta` and `PROOF_MIME_TYPES`) is the public side of the `files` table for the money and identity modules.

The merchant webhooks (7b): `WebhookEventsModule` (event contracts and the outbox routes of `wallet.low_balance` and `service.price_changed`, loaded by the API and the worker), `WebhookDeliveryModule` (sender, fan-out, the processor of `merchant-webhooks`; API and worker), `MerchantWebhooksModule` (the staff log routes and `MerchantWebhookService`), the four `defineEvent` contracts (`orderStatusChanged`, `walletLowBalance`, `invoicePaid`, `servicePriceChanged`), `WEBHOOK_EVENT_NAMES`, `PING_EVENT`, `WebhookDeliveries`, `WebhookFanOut`, `MerchantWebhooksProcessor`, the event type constants and the `WEBHOOK_TARGET_POLICY` token. The portal's controller for `/client/webhooks*` (`MerchantWebhooksController`) lives in the identity module (`controllers/merchant-webhooks.controller.ts`, `MerchantWebhookRoutesModule`): it needs identity's `CurrentMerchant`, and platform imports no module, so a platform file that imported identity would make a cycle for every identity file that imports platform (decision 032). Platform exports `MerchantWebhookService` and the six portal contracts for it.

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
| `GET /admin/dashboard` | staff-permission · `dashboard:read` | KPIs for today: sales, profit, queues and supplier balances; scope=all\|b2b\|b2c separates merchants from the storefront. Built in feature 9 but served by the health module (`src/modules/health/dashboard/`): it reads orders, suppliers, catalog and customers, and platform is imported by all of them (decision 032). | 9 |
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

`SettingsService` is the only code outside the settings routes that reads the `settings` table: other modules call it
(identity reads `adminAllowlistOnly`). The routes that write settings call the `invalidate()` of whatever cache holds a value
after their commit. `PATCH /admin/settings` is an allow-list (lead resolution identity-platform-13):
it accepts only the keys of a settings registry in this module, each with its validator (today `imeiRetentionDays`, a JSON
integer 0 to 3650, shared with `PATCH /admin/storefront/settings`, and `pricing.price_change_tolerance_percent`, a JSON integer 0 to 100,
default 10 when never saved, read by the catalog's price guard, user rule 9); any other key, including the keys owned by stricter routes
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
  through the formatter seam (`ErrorFormatterRegistry`, decision 026): `DhruErrorFormatter` turns it into the
  `{ERROR: [{MESSAGE}], apiversion}` envelope (HTTP 200).
- **Dhru:** all actions share one path, so a Dhru order placement is decided in the pipeline's `preValidation` phase, once the
  body is parsed and the `action` field is known (`dhruActionOf`). A multipart body is parsed before the guards too
  (`registerMultipartBodies`, `src/common/multipart.ts`, feature 7a: text fields and file parts as one object), so Dhru credentials and the
  `action` of a multipart call are read like those of a form body and the maintenance stage refuses a multipart placement as it refuses a
  form one; the file orders need no handler-side call. The upload of a File service's input (`POST /v1/files`) is part of placing the
  order: scope `api_orders` refuses it too (`POST /client/files` is not: a merchant uploads its KYC documents and receipts in any mode).
- **Failure policy:** if the state cannot be read at all, requests go through (maintenance is a courtesy to customers, not a
  security rule).

## Audit log and settings routes (feature 2a)

Four admin routes (`contracts/`, `controllers/`, `application/`, `infra/`), wired by `PlatformAdminModule`. Scenarios `admin-team` and
`ip-rules` read and write them (`test/scenarios/`); route tests: `test/integration/audit-logs.test.ts` and `settings-admin.test.ts`.

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/audit-logs` | `audit:read` | the log newest first. Filters (equality): `actorType` (`staff \| client \| customer \| system`), `actorId`, `entityType`, `entityId`; `q` is a case-insensitive contains over `actorName`, `action` and `entityLabel`; `from` and `to` are UTC days, both included; sorts `createdAt` and `id`; `x-total-count` is exact for the filter |
| `GET /admin/audit-logs/:id` | `audit:read` | one entry; `404 NOT_FOUND` |
| `GET /admin/settings` | `settings:read` | one flat object `{ key: value }` of every settings row with its JSON type; keys whose names mark a secret (`password`, `token`, `secret`, `hash`, `apiKey`, ...: `isSecretKey`) are never sent; a key that was never set is absent |
| `PATCH /admin/settings` | `settings:update` | the allow-list below; answers the whole object after the change |

- **The audit list is read-only** (the table is append-only). `actorName` and `entityLabel` are snapshots written with the entry; the wire
  sends `null` for `''` (a system row has no actor name, id or address). `before` and `after` were masked when the entry was written.
- **`PATCH /admin/settings` is an allow-list** (`settings/settings-registry.ts`, resolution `identity-platform-13`): the registry holds
  `imeiRetentionDays` (a JSON integer 0 to 3650) and `pricing.price_change_tolerance_percent` (a JSON integer 0 to 100; feature 4b). Every key of the patch is judged first; any other key (the keys of the stricter routes
  `adminAllowlistOnly`, `maintenance`, the risk rules, the storefront policies included) or a value the validator refuses is `422
  VALIDATION_FAILED` with one `errors[]` item per refused key (`field` = the key), and nothing is written. An empty body is `422` on
  `body`. A valid patch upserts the rows and writes one audit row (`action: changed settings`, `entityType: setting`, `entityLabel` the keys,
  `before` and `after` of the changed keys, secrets masked) in the same transaction. After the commit it calls `SettingsReader.invalidate()`
  and `MaintenanceService.invalidate()`. No registry key feeds the IP rule cache; a key added later that does must also clear
  `IpRuleCache` (identity module, by a seam, since this module may not import identity).
- **Adding an editable setting:** add `{ key, validate }` to `EDITABLE_SETTINGS` with a unit test, name the cache it feeds and clear it after the commit.

## File downloads (feature 5, MISMATCHES B154)

`GET /admin/files/:id` (`files:read`) and `GET /client/files/:id` (merchant session, `pendingMerchant: 'allow'`) answer `302` to a
presigned object-storage link that lives 5 minutes (`StorageService.presignGet` with the stored file name as the download name),
with `Cache-Control: no-store` on the redirect (`FileAccessService`, `controllers/files.controller.ts`, `contracts/files.contracts.ts`).
`defineRoute` takes `success: { status: 302 }` for them (a bodiless GET: the handler sets `Location` and the response interceptor
refuses a 302 without it; OpenAPI documents the `Location` header). Staff may open any file; a merchant only its own upload
(`owner_type client`, `owner_id` the merchant) or the input or result file of one of its own orders (`ownsOrderFile`, a documented
foreign read of `orders` in `infra/file.repository.ts`); anything else, an unknown id included, is `404`, never `403`. The access is
logged at info without the file name and writes no audit row. The routes read the caller from the request context
(`getRequestContext().actor`), not from identity's decorators, because identity imports this module (decision 032).

## File uploads (feature 7a, MISMATCHES B157)

`POST /v1/files` (REST v1, key scope `orders:write`) and `POST /client/files` (merchant session and CSRF, `pendingMerchant: 'allow'` so a
merchant waiting for approval can upload its KYC documents) are one code path, `FileUploadService.upload` (`application/file-upload.service.ts`,
provided to every module by the global `FilesModule`, which the Dhru file order of the orders module uses too). The body is
`multipart/form-data` with one part named `file`, parsed before the guards by `registerMultipartBodies` (a multipart body on any route but
`/api/index.php`, `/v1/files` and `/client/files` is `415 UNSUPPORTED_MEDIA_TYPE`, and the buffer is bounded at 25 MiB plus the form
fields). Limits: 1 byte to 25 MiB (`422` on `file` when missing or empty, `413 PAYLOAD_TOO_LARGE` above), any media type (a value that is not a
`type/subtype` is stored as `application/octet-stream`), the name reduced to its base name without control characters and cut to 200
characters. The object goes to the files bucket under a key built here (`files/<year>/<month>/<uuid>`: never from the name), then a `files`
row owned by the merchant (`owner_type client`) is written with the size and SHA-256; an object whose row could not be written is deleted
again. The answer is `201 { id, filename, size, mime, sha256, createdAt }`; the id is what a File service order takes as `fileId`, or a KYC
submission or a receipt (features 8 and 17, B161, B163). `GET /v1/files/:id` (scope `orders:read`) redirects like the other downloads and
is the merchant's own files only (`404` for anything else). No audit row for a merchant's upload (B121).

## OpenAPI: the Dhru reference (feature 7a, decision 017)

`describeDhruActions` (`docs/dhru-reference.ts`) writes the eight action contracts of the Dhru registry (`src/common/dhru`) into the Dhru
operation of both documents: the form body becomes a `oneOf` by `action` (each branch with `x-gsm-decoded`, the shape of the decoded
`parameters`, and `x-gsm-success-entry`) with one request and one response example per action; the operation documents HTTP 200 only
(every refusal is an `ERROR` list in a 200 body). Every REST v1 operation documents the `RateLimit-*` response headers.

## Events

Outbox events produced (types, payload ids): the orders module registers `order.status_changed` and `order.dispatch_requested`
(`docs/queues.md`); this module registers none itself. A module registers an event type with its queue in `onModuleInit`
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

## PDF documents and stored files (feature 8, decision 030)

`PdfRenderer` (`pdf/pdf-renderer.ts`, provided globally by `PdfModule`, no database or storage needed) draws a small A4 document with `pdf-lib` 1.17.1 (pure TypeScript, runs on Bun): a title and
subtitle, then blocks (`heading`, `text`, `facts` label/value rows, `table` with relative column widths and left or right alignment, `space`), a footer with `Page n of m` on every page, automatic page breaks
(a table repeats its header) and word wrapping. The text is English in embedded Helvetica: a character the font cannot draw (Arabic, emoji) prints as `?` instead of failing the document, and the document
properties carry the caller's time (`createdAt`, from the injected clock: decision 031), never the wall clock. Billing renders merchant invoices with it; the client
statement of feature 11 reuses it.

`StoredFiles` (`files/stored-files.ts`, a plain provider: it needs `StorageService` and a database executor, so the money and identity modules list it themselves) is what other modules use instead of touching `files`:
`store(db, { ownerType, ownerId, filename, mime, bytes, area })` puts the object in the files bucket (key `<area>/<owner>/<uuid>`, never built from the file name) and inserts the row (the object goes first: a rolled-back
caller leaves an unreferenced object, never a row without an object), `metaOf(db, ids)` reads the metadata of files by id, and `findOwned(db, id, owner)` returns a file only if it belongs to that owner (B161 and B163: a
merchant attaches only its own uploads; another owner's id answers like an unknown one). `PROOF_MIME_TYPES` (PDF, JPEG, PNG) are the types a merchant may attach as a KYC document or a transfer receipt. The merchants'
upload routes are feature 7a's; invoice PDFs are written here as the merchant's file, so `GET /client/files/:id` serves them.

## Jobs and schedules

The relay tick: `outbox-relay-tick`, every second, queue `outbox-relay`, job `tick` (processor `OutboxRelayProcessor`). Listed
in `docs/queues.md`. Other jobs of this module (notifications, webhook deliveries, file jobs) arrive with their features.

## Cache keys

- `gsm:{env}:platform:settings:all` (`CacheKeys.settings()`): the whole `settings` table as one flat object, 60 s. `PATCH /admin/settings` and `PUT /admin/access/restriction` call `SettingsReader.invalidate()` inside `afterCommit`. Listed in `docs/cache-keys.md`. Feature 2a added no key family.

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
    action: 'suspended admin', // the demo's lower-case verb phrase; the console prints `<actor> <action> <entityLabel>` (ANSWERS audit Q3)
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
  `alert_rule`, `alert`, `incident`, `tax_rate`, `help_article`, `content_page`, `ledger_transaction`, `inventory_code`, `pricing_rule`); `record` throws a
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

## Merchant webhooks (feature 7b)

Nine routes (contracts `webhooks/webhooks.contracts.ts` for the portal, `webhooks/webhook-deliveries.contracts.ts` for staff; controllers
`webhooks/webhook-deliveries.controller.ts` (staff) and identity's `merchant-webhooks.controller.ts` (portal); use cases `merchant-webhook.service.ts` and `webhook-delivery-admin.service.ts`; queries
`webhook-endpoint.repository.ts` and `webhook-delivery.repository.ts`; pure rules `webhook-delivery.rules.ts`), the engine and the events.
Specs: MISMATCHES B156 (portal), RESOLUTIONS identity-platform-12 (the staff log), ALIGNMENT § 7 (the format).

| Route | Access | What it does |
|---|---|---|
| `GET /client/webhooks` | merchant | the merchant's endpoints, newest first, `x-total-count`; never the secret |
| `POST /client/webhooks` | merchant | `{ url, events, isActive? }` → `201 { endpoint, secret }`, `Cache-Control: no-store`; https with a public host (SSRF guard of decision 023, `422` on `url`), events a subset of the four (`422` on `events.N`), at most 5 endpoints (`422` on `url`, advisory lock against races); the secret is `whsec_` + 32 random bytes, stored AES-GCM (AAD `webhook_endpoints.secret_enc`), shown once |
| `PATCH /client/webhooks/:id` | merchant | url, events, isActive; turning an endpoint back on resets `failureCount`; another merchant's or unknown id is `404` |
| `DELETE /client/webhooks/:id` | merchant | `204`; the deliveries go with it (`ON DELETE CASCADE`) |
| `POST /client/webhooks/:id/test` | merchant | `202 { deliveryId }`: a signed `ping` delivery `{ message, endpointId }`; `409 INVALID_TRANSITION` for a paused endpoint; if the queue cannot take the job the delivery is removed and the answer is `503` |
| `GET /client/webhooks/:id/deliveries` | merchant | newest first: `{ id, event, attempt, status (pending, succeeded, failed), responseCode (0 without an answer), error (''), nextRetryAt, createdAt }` |
| `GET /admin/webhook-deliveries` | `webhooks:read` | the log: delivery columns plus `endpoint {id, url}` and `client {id, name}`; filters `status` (`delivered`, `pending`, `failed`), `event`, `clientId`; `q` over merchant, event and address |
| `GET /admin/webhook-deliveries/:id` | `webhooks:read` | the same row (it carries `payload`, `responseBody`, `error`) |
| `POST /admin/webhook-deliveries/:id/retry` | `webhooks:update` | one more attempt of the same payload: `pending`, `attempt + 1`, due now; `409 DELIVERY_SUCCEEDED`, `429` (limiter `webhook-retry`, one a minute per delivery); audited `retried webhook delivery of <merchant>` |

Merchant routes write no audit row (B121). The portal says `succeeded` where the console's log says `delivered` (B156 wording, kept).

### The events (public OpenAPI `webhooks`, decision 017)

| Event | Who writes the outbox row | Outbox payload (ids and codes) | `data` sent to the merchant |
|---|---|---|---|
| `order.status_changed` | feature 5 (registers the route to `merchant-webhooks`) | `{ orderId, clientId, fromStatus, toStatus }` | the order's public fields: ids, service name, status and previous status, IMEI, quantity, prices, currency, result, times; never cost, supplier or notes |
| `wallet.low_balance` | money, `WalletLowBalanceWatch` inside `LedgerPoster.post` (route registered here) | `{ clientId, currency, available, threshold }` | `{ currency, available, threshold }` |
| `invoice.paid` | feature 8 (registers the route to `merchant-webhooks`) | `{ invoiceId, clientId }` | `{ invoiceId, number, amount, currency, paidAt }` |
| `service.price_changed` | catalog, `PriceChangeScan` (route registered here) | `{ clientId, serviceId, previousPrice, price, currency }` | `{ serviceId, serviceName, previousPrice, price, currency }` |

The envelope is `{ id, type, createdAt, data }`; the id is `evt_` and 24 hex characters of a keyed hash of the event (stable, says nothing about volume). A merchant
event reaches `merchant-webhooks` with `payload.clientId`; `WebhookFanOut` fans out ANY registered type that carries a `clientId` and has a contract.
`order.status_changed` and `invoice.paid` are registered by features 5 and 8, not here (a type is registered once); until they exist the tests register them
(`test/support/webhooks.ts`). The data is built at fan-out from the outbox row and, for orders and invoices, from the source row through
`webhooks/webhook-foreign-reads.ts`, a documented deviation of decision 016 (platform imports no module; replace the bodies when orders and
invoices export a reader). The data is checked against the event contract before it is stored.

### Delivery (decision 020, `docs/queues.md`)

`WebhookFanOut` inserts one `webhook_deliveries` row per active, subscribed endpoint (`ON CONFLICT (endpoint_id, event_id) DO NOTHING`; `event_id` is the
envelope id, migration 0007) holding the envelope as `payload`, then adds the delivery job. `WebhookDeliveries.deliver` sends
`POST` JSON with `X-GSM-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">` and `X-GSM-Event-Id`, 10 s timeout, no redirects, answer read up to 64 KB and
stored up to 4 KB. 2xx is delivered. Anything else is a failed attempt: `10 min x 2^(n-1)` shortened by up to 20 % before attempt n + 1, 8 attempts over about 21 h,
then `failed`. The row is the truth (`attempt`, `next_retry_at`, `response_code` null for no answer, `response_body`, `error`); the BullMQ job
(`webhook-<delivery>-<attempt>`, delayed) is the alarm clock. The address is checked again at every send; a host that is no longer public fails the delivery at once.
Guarded writes (`status = 'pending' and attempt = n`) make a job that runs twice, or after a manual retry, harmless; sends are at least once, and the same
event id on every retry lets the receiver drop repeats. `failure_count` of the endpoint counts failed attempts and resets on a success or when the endpoint is switched on.

`WEBHOOK_TARGET_POLICY` (optional token) lets tests give the sender a local server and a stand-in DNS; nothing provides it in production.

Open points: nothing re-queues a pending delivery whose job was lost (the queue Redis lost its data): `webhook_deliveries_retry_idx` supports a sweep for 12b;
an endpoint is never switched off automatically after many failures; `invoice.paid` needs feature 8 to register its route and write `payload.clientId`.
